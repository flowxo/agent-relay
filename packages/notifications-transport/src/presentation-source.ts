import { sha256 } from "@agent-relay/protocol";

export type NotificationsResolutionPresentation =
  "answered" | "duplicate" | "expired" | "cancelled" | "unsupported";

export type NotificationsResolutionSource =
  "terminal" | "telegram" | "web" | "notifications";

export interface ReflectNotificationsResolutionInput {
  operationId: string;
  messageId: string;
  interactionId: string;
  presentation: NotificationsResolutionPresentation;
  resolutionSource?: NotificationsResolutionSource;
  reasonCode?: string;
  signal: AbortSignal;
}

export type ReflectNotificationsResolutionResult =
  | {
      outcome: "updated";
      operationId: string;
      messageId: string;
    }
  | {
      outcome: "unsupported";
      reasonCode: "notifications-resolution-update-unsupported";
    };

export interface NotificationsResolutionPresenter {
  readonly capability: "supported" | "unsupported";
  reflect(
    input: ReflectNotificationsResolutionInput,
  ): Promise<ReflectNotificationsResolutionResult>;
}

export function notificationsResolutionOperationId(eventId: string): string {
  if (
    eventId.length < 8 ||
    eventId.length > 256 ||
    !/^[A-Za-z0-9._:-]+$/u.test(eventId)
  ) {
    throw new Error("hosted event id is not a safe opaque identifier");
  }
  return `resolution_${sha256(eventId)}`;
}

/**
 * The exact pinned Notifications 1.0.0-rc.1 client has no resolved-message
 * update method. Keeping that absence behind the same bounded interface lets a
 * later exact contract add the capability without changing local authority.
 */
export class PinnedNotificationsResolutionPresenter implements NotificationsResolutionPresenter {
  public readonly capability = "unsupported" as const;

  public async reflect(
    _input: ReflectNotificationsResolutionInput,
  ): Promise<ReflectNotificationsResolutionResult> {
    return await Promise.resolve({
      outcome: "unsupported" as const,
      reasonCode: "notifications-resolution-update-unsupported" as const,
    });
  }
}
