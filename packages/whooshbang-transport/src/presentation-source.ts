import { sha256 } from "@agent-relay/protocol";

export type WhooshBangResolutionPresentation =
  "answered" | "duplicate" | "expired" | "cancelled" | "unsupported";

export type WhooshBangResolutionSource =
  "terminal" | "telegram" | "web" | "whooshbang";

export interface ReflectWhooshBangResolutionInput {
  operationId: string;
  messageId: string;
  interactionId: string;
  presentation: WhooshBangResolutionPresentation;
  resolutionSource?: WhooshBangResolutionSource;
  reasonCode?: string;
  signal: AbortSignal;
}

export type ReflectWhooshBangResolutionResult =
  | {
      outcome: "updated";
      operationId: string;
      messageId: string;
    }
  | {
      outcome: "unsupported";
      reasonCode: "whooshbang-resolution-update-unsupported";
    };

export interface WhooshBangResolutionPresenter {
  readonly capability: "supported" | "unsupported";
  reflect(
    input: ReflectWhooshBangResolutionInput,
  ): Promise<ReflectWhooshBangResolutionResult>;
}

export function whooshbangResolutionOperationId(eventId: string): string {
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
 * The exact pinned WhooshBang 1.0.0-rc.5 client has no resolved-message
 * update method. Keeping that absence behind the same bounded interface lets a
 * later exact contract add the capability without changing local authority.
 */
export class PinnedWhooshBangResolutionPresenter implements WhooshBangResolutionPresenter {
  public readonly capability = "unsupported" as const;

  public async reflect(
    _input: ReflectWhooshBangResolutionInput,
  ): Promise<ReflectWhooshBangResolutionResult> {
    return await Promise.resolve({
      outcome: "unsupported" as const,
      reasonCode: "whooshbang-resolution-update-unsupported" as const,
    });
  }
}
