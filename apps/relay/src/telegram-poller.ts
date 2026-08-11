import type { RelayLogger } from "@agent-relay/core";
import { NOOP_LOGGER } from "@agent-relay/core";
import type {
  TelegramGetUpdatesOptions,
  TelegramPolledUpdate,
} from "@agent-relay/telegram-transport";

export interface TelegramUpdateSource {
  getUpdates(
    options?: TelegramGetUpdatesOptions,
  ): Promise<TelegramPolledUpdate[]>;
}

export interface TelegramUpdateHandler {
  handle(update: unknown): Promise<unknown>;
}

export interface TelegramPollerOptions {
  source: TelegramUpdateSource;
  handler: TelegramUpdateHandler;
  logger?: RelayLogger;
  timeoutSeconds?: number;
  limit?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  sleep?: (delayMs: number, signal: AbortSignal) => Promise<void>;
  localOwnership?: "held" | "not-held";
  now?: () => Date;
}

export interface TelegramPollingRuntimeStatus {
  mode: "poll";
  localOwnership: "held" | "not-held";
  state:
    "not-started" | "starting" | "active" | "error" | "blocked" | "stopped";
  replyReady: boolean;
  lastSuccessfulPollAt: string | null;
  lastError: { at: string; code: string } | null;
}

function errorDetails(error: unknown): Record<string, unknown> {
  if (typeof error !== "object" || error === null) {
    return {};
  }
  return {
    ...("code" in error ? { errorCode: error.code } : {}),
    ...("status" in error ? { status: error.status } : {}),
    ...("retryable" in error ? { retryable: error.retryable } : {}),
  };
}

function isExplicitlyNonRetryable(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "retryable" in error &&
    error.retryable === false
  );
}

function errorCode(error: unknown): string {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : "telegram-poll-failed";
}

async function abortableSleep(
  delayMs: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) {
    return;
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(finish, delayMs);
    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
    signal.addEventListener("abort", finish, { once: true });
  });
}

export class TelegramUpdatePoller {
  private readonly logger: RelayLogger;
  private readonly timeoutSeconds: number;
  private readonly limit: number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly sleep: (
    delayMs: number,
    signal: AbortSignal,
  ) => Promise<void>;
  private readonly now: () => Date;
  private readonly localOwnership: "held" | "not-held";
  private state: TelegramPollingRuntimeStatus["state"] = "not-started";
  private lastSuccessfulPollAt: string | null = null;
  private lastError: TelegramPollingRuntimeStatus["lastError"] = null;

  public constructor(private readonly options: TelegramPollerOptions) {
    this.logger = options.logger ?? NOOP_LOGGER;
    this.timeoutSeconds = options.timeoutSeconds ?? 30;
    this.limit = options.limit ?? 100;
    this.retryBaseMs = options.retryBaseMs ?? 1_000;
    this.retryMaxMs = options.retryMaxMs ?? 60_000;
    this.sleep = options.sleep ?? abortableSleep;
    this.localOwnership = options.localOwnership ?? "not-held";
    this.now = options.now ?? (() => new Date());
    if (
      !Number.isSafeInteger(this.timeoutSeconds) ||
      this.timeoutSeconds < 1 ||
      this.timeoutSeconds > 50
    ) {
      throw new Error("poll timeout must be between 1 and 50 seconds");
    }
    if (
      !Number.isSafeInteger(this.limit) ||
      this.limit < 1 ||
      this.limit > 100
    ) {
      throw new Error("poll limit must be between 1 and 100");
    }
    if (
      !Number.isSafeInteger(this.retryBaseMs) ||
      this.retryBaseMs < 1 ||
      !Number.isSafeInteger(this.retryMaxMs) ||
      this.retryMaxMs < this.retryBaseMs
    ) {
      throw new Error("poll retry delays are invalid");
    }
  }

  public status(): TelegramPollingRuntimeStatus {
    return {
      mode: "poll",
      localOwnership: this.localOwnership,
      state: this.state,
      replyReady: this.localOwnership === "held" && this.state === "active",
      lastSuccessfulPollAt: this.lastSuccessfulPollAt,
      lastError: this.lastError,
    };
  }

  private retryDelay(attempt: number): number {
    return Math.min(
      this.retryMaxMs,
      this.retryBaseMs * 2 ** Math.min(attempt, 20),
    );
  }

  public async run(signal: AbortSignal): Promise<void> {
    let offset: number | undefined;
    let failedAttempts = 0;
    this.state = "starting";
    this.logger.log({
      level: "info",
      code: "telegram.poll-started",
      message: "Telegram update polling started",
      at: new Date().toISOString(),
    });
    try {
      while (!signal.aborted) {
        let updates: TelegramPolledUpdate[];
        try {
          updates = await this.options.source.getUpdates({
            ...(offset === undefined ? {} : { offset }),
            limit: this.limit,
            timeoutSeconds: this.timeoutSeconds,
            signal,
          });
        } catch (error) {
          if (signal.aborted) {
            break;
          }
          const at = this.now().toISOString();
          const nonRetryable = isExplicitlyNonRetryable(error);
          const delayMs = this.retryDelay(failedAttempts);
          failedAttempts += 1;
          this.state = nonRetryable ? "blocked" : "error";
          this.lastError = { at, code: errorCode(error) };
          this.logger.log({
            level: "error",
            code: "telegram.poll-failed",
            message: "Telegram update polling failed",
            at,
            details: {
              ...errorDetails(error),
              ...(nonRetryable ? {} : { retryDelayMs: delayMs }),
            },
          });
          if (nonRetryable) {
            this.logger.log({
              level: "error",
              code: "telegram.poll-blocked",
              message:
                "Telegram update polling stopped after a terminal provider conflict",
              at,
              details: errorDetails(error),
            });
            break;
          }
          await this.sleep(delayMs, signal);
          continue;
        }

        let handlerFailed = false;
        const ordered = [...updates].sort(
          (left, right) => left.update_id - right.update_id,
        );
        for (const update of ordered) {
          try {
            await this.options.handler.handle(update);
            offset = Math.max(offset ?? 0, update.update_id + 1);
          } catch {
            handlerFailed = true;
            const at = this.now().toISOString();
            this.state = "error";
            this.lastError = {
              at,
              code: "telegram-poll-handler-failed",
            };
            this.logger.log({
              level: "error",
              code: "telegram.poll-handler-failed",
              message: "Telegram update routing failed",
              at,
              details: { updateId: update.update_id },
            });
            break;
          }
        }
        if (handlerFailed) {
          await this.sleep(this.retryDelay(failedAttempts), signal);
          failedAttempts += 1;
        } else {
          failedAttempts = 0;
          this.state = "active";
          this.lastSuccessfulPollAt = this.now().toISOString();
          this.lastError = null;
        }
      }
    } finally {
      if (this.state !== "blocked") {
        this.state = "stopped";
      }
      this.logger.log({
        level: "info",
        code: "telegram.poll-stopped",
        message: "Telegram update polling stopped",
        at: new Date().toISOString(),
      });
    }
  }
}
