import { z } from "zod";

export const CODEX_APP_SERVER_VERSION = "codex-cli 0.145.0";
export const CODEX_APP_SERVER_SCHEMA_SHA256 =
  "1bc09dedc506075562d4d49b702ecab6d947dd5a8c2a9014a5cde592a0938efb";
export const CODEX_APP_SERVER_MAXIMUM_LINE_BYTES = 1024 * 1024;
export const CODEX_APP_SERVER_MAXIMUM_PENDING_REQUESTS = 64;

export type CodexRequestId = string | number;

const RequestIdSchema = z.union([
  z.string().min(1).max(160),
  z.number().safe(),
]);

const JsonRpcErrorSchema = z
  .object({
    code: z.number().safe(),
    message: z.string().max(500),
    data: z.unknown().optional(),
  })
  .strict();

const ResponseSchema = z
  .object({
    id: RequestIdSchema,
    result: z.unknown().optional(),
    error: JsonRpcErrorSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.result === undefined) === (value.error === undefined)) {
      context.addIssue({
        code: "custom",
        message: "response must contain exactly one result or error",
      });
    }
  });

const ServerRequestSchema = z
  .object({
    id: RequestIdSchema,
    method: z.string().min(1).max(160),
    params: z.unknown(),
  })
  .strict();

const ServerNotificationSchema = z
  .object({
    method: z.string().min(1).max(160),
    params: z.unknown(),
    emittedAtMs: z.number().safe().nonnegative().optional(),
  })
  .strict();

export type CodexAppServerInbound =
  | {
      readonly kind: "response";
      readonly id: CodexRequestId;
      readonly result?: unknown;
      readonly error?: { readonly code: number; readonly message: string };
    }
  | {
      readonly kind: "request";
      readonly id: CodexRequestId;
      readonly method: string;
      readonly params: unknown;
    }
  | {
      readonly kind: "notification";
      readonly method: string;
      readonly params: unknown;
    }
  | {
      readonly kind: "process_exited";
      readonly exitCode: number | null;
      readonly signal: NodeJS.Signals | null;
      readonly intentional: boolean;
    };

export function decodeCodexAppServerLine(line: string): CodexAppServerInbound {
  if (
    Buffer.byteLength(line, "utf8") < 2 ||
    Buffer.byteLength(line, "utf8") > CODEX_APP_SERVER_MAXIMUM_LINE_BYTES
  ) {
    throw new CodexAppServerProtocolError("native_line_size_invalid");
  }
  let value: unknown;
  try {
    value = JSON.parse(line) as unknown;
  } catch {
    throw new CodexAppServerProtocolError("native_json_malformed");
  }
  const response = ResponseSchema.safeParse(value);
  if (response.success) {
    return {
      kind: "response",
      id: response.data.id,
      ...(response.data.result === undefined
        ? {}
        : { result: response.data.result }),
      ...(response.data.error === undefined
        ? {}
        : {
            error: {
              code: response.data.error.code,
              message: response.data.error.message,
            },
          }),
    };
  }
  const request = ServerRequestSchema.safeParse(value);
  if (request.success) {
    return {
      kind: "request",
      id: request.data.id,
      method: request.data.method,
      params: request.data.params,
    };
  }
  const notification = ServerNotificationSchema.safeParse(value);
  if (notification.success) {
    return {
      kind: "notification",
      method: notification.data.method,
      params: notification.data.params,
    };
  }
  throw new CodexAppServerProtocolError("native_envelope_malformed");
}

export class CodexAppServerProtocolError extends Error {
  readonly safeCode: string;

  constructor(safeCode: string) {
    super(safeCode);
    this.name = "CodexAppServerProtocolError";
    this.safeCode = safeCode;
  }
}

export const InitializeResponseSchema = z
  .object({
    userAgent: z.string().min(1).max(240),
    codexHome: z.string().min(1),
    platformFamily: z.string().min(1).max(80),
    platformOs: z.string().min(1).max(80),
  })
  .strict();

export const ThreadResponseSchema = z
  .object({
    thread: z
      .object({
        id: z.string().min(1).max(160),
      })
      .passthrough(),
  })
  .passthrough();

export const TurnResponseSchema = z
  .object({
    turn: z
      .object({
        id: z.string().min(1).max(160),
        status: z.string().min(1).max(80),
      })
      .passthrough(),
  })
  .strict();

export const TurnSteerResponseSchema = z
  .object({
    turnId: z.string().min(1).max(160),
  })
  .strict();

export const EmptyResponseSchema = z.object({}).strict();

export const ThreadStartedNotificationSchema = z
  .object({
    thread: z
      .object({
        id: z.string().min(1).max(160),
      })
      .passthrough(),
  })
  .strict();

const TurnSchema = z
  .object({
    id: z.string().min(1).max(160),
    status: z.enum(["completed", "interrupted", "failed", "inProgress"]),
  })
  .passthrough();

export const TurnNotificationSchema = z
  .object({
    threadId: z.string().min(1).max(160),
    turn: TurnSchema,
  })
  .strict();

const ThreadItemSchema = z
  .object({
    id: z.string().min(1).max(160),
    type: z.string().min(1).max(120),
  })
  .passthrough();

export const ItemNotificationSchema = z
  .object({
    item: ThreadItemSchema,
    threadId: z.string().min(1).max(160),
    turnId: z.string().min(1).max(160),
  })
  .passthrough();

export const ApprovalRequestSchema = z
  .object({
    threadId: z.string().min(1).max(160),
    turnId: z.string().min(1).max(160),
    itemId: z.string().min(1).max(160),
  })
  .passthrough();

export const ErrorNotificationSchema = z
  .object({
    threadId: z.string().min(1).max(160),
    turnId: z.string().min(1).max(160),
    willRetry: z.boolean(),
    error: z.unknown(),
  })
  .strict();

export function codexRequestReference(id: CodexRequestId): string {
  return `${typeof id}:${String(id)}`;
}
