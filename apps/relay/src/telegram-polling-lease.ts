import { createServer } from "node:net";

const LEASE_PORT_BASE = 38_000;

export class TelegramPollingLeaseError extends Error {
  public override readonly name = "TelegramPollingLeaseError";
  public readonly code = "telegram-poller-already-owned";
  public readonly retryable = false;

  public constructor() {
    super(
      "Another local Agent Relay daemon already owns Telegram reply polling; stop it explicitly before starting this daemon",
    );
  }
}

export interface TelegramPollingLease {
  release(): Promise<void>;
}

export interface AcquireTelegramPollingLeaseOptions {
  port?: number;
}

function isErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

export function defaultTelegramPollingLeasePort(): number {
  if (process.getuid === undefined) {
    throw new Error(
      "Telegram polling coordination requires a Unix user identity",
    );
  }
  const port = LEASE_PORT_BASE + process.getuid();
  if (port > 65_535) {
    throw new Error(
      "Telegram polling coordination does not support this Unix user identity",
    );
  }
  return port;
}

export async function acquireTelegramPollingLease(
  options: AcquireTelegramPollingLeaseOptions = {},
): Promise<TelegramPollingLease> {
  const port = options.port ?? defaultTelegramPollingLeasePort();
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("Telegram polling coordination port is invalid");
  }

  // Agent Relay intentionally permits one Telegram poller per OS user. A
  // fixed, user-derived loopback port is kernel-held for the daemon lifetime,
  // records no credential/provider identity, is atomic under contention, and
  // is released automatically if the process crashes.
  const server = createServer((socket) => socket.destroy());
  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: unknown): void => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = (): void => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen({
        host: "127.0.0.1",
        port,
        exclusive: true,
      });
    });
  } catch (error) {
    if (isErrorCode(error, "EADDRINUSE")) {
      throw new TelegramPollingLeaseError();
    }
    throw error;
  }

  let releasePromise: Promise<void> | undefined;
  return {
    release: () => {
      releasePromise ??= new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) {
            resolve();
          } else {
            reject(error);
          }
        });
      });
      return releasePromise;
    },
  };
}
