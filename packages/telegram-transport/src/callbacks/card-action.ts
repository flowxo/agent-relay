import { z } from "zod";

import {
  CardActionTokenSchema,
  type CardActionKind,
} from "@agent-relay/notification-contracts";

const ACTION_CODES: Record<CardActionKind, string> = {
  continue: "c",
  details: "d",
  mute: "m",
  end: "e",
};

const ACTIONS_BY_CODE = Object.fromEntries(
  Object.entries(ACTION_CODES).map(([action, code]) => [code, action]),
) as Record<string, CardActionKind>;

export const CardActionCallbackDataSchema = z
  .string()
  .max(64)
  .regex(/^relay-card:v1:[cdme]:card_[a-f0-9]{32}$/);

export interface ParsedCardActionCallback {
  version: 1;
  action: CardActionKind;
  token: string;
}

export function cardActionCallbackData(
  action: CardActionKind,
  token: string,
): string {
  return `relay-card:v1:${ACTION_CODES[action]}:${CardActionTokenSchema.parse(
    token,
  )}`;
}

export function parseCardActionCallbackData(
  value: unknown,
): ParsedCardActionCallback | undefined {
  const parsed = CardActionCallbackDataSchema.safeParse(value);
  if (!parsed.success) {
    return undefined;
  }
  const [, code, token] =
    /^relay-card:v1:([cdme]):(card_[a-f0-9]{32})$/.exec(parsed.data) ?? [];
  const action = code === undefined ? undefined : ACTIONS_BY_CODE[code];
  if (action === undefined || token === undefined) {
    return undefined;
  }
  return { version: 1, action, token };
}
