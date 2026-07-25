import { z } from "zod";

import { sha256 } from "@agent-relay/protocol";

export const CardActionKindSchema = z.enum([
  "continue",
  "details",
  "mute",
  "end",
]);

export type CardActionKind = z.infer<typeof CardActionKindSchema>;

export const CardActionTokenSchema = z.string().regex(/^card_[a-f0-9]{32}$/);

const ACTION_CODES: Record<CardActionKind, string> = {
  continue: "c",
  details: "d",
  mute: "m",
  end: "e",
};

export function cardActionToken(
  eventId: string,
  action: CardActionKind,
): string {
  return `card_${sha256(`${eventId}\u001f${action}`).slice(0, 32)}`;
}

export function cardActionCallbackData(
  action: CardActionKind,
  token: string,
): string {
  return `relay-card:v1:${ACTION_CODES[action]}:${CardActionTokenSchema.parse(
    token,
  )}`;
}
