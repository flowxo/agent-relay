import { Buffer } from "node:buffer";

export const TELEGRAM_CALLBACK_DATA_LIMIT_BYTES = 64;

/**
 * A product-level compactness budget, not a Telegram API maximum.
 *
 * Telegram does not publish a total inline-keyboard button limit. Agent Relay
 * keeps single-choice cards to ten buttons so a request remains scannable on a
 * phone. Larger protocol-valid requests use the correlated numbered-text
 * fallback.
 */
export const TELEGRAM_INLINE_CHOICE_LIMIT = 10;

const CHOICE_CALLBACK_PREFIX = "relay:";
const decisionTokenPattern = /^decision_[A-Za-z0-9_-]{8,48}$/;

export function choiceCallbackData(token: string): string {
  if (!decisionTokenPattern.test(token)) {
    throw new Error("Telegram choice token is malformed");
  }
  const data = `${CHOICE_CALLBACK_PREFIX}${token}`;
  if (Buffer.byteLength(data, "utf8") > TELEGRAM_CALLBACK_DATA_LIMIT_BYTES) {
    throw new Error("Telegram choice callback data exceeds 64 bytes");
  }
  return data;
}

export function parseChoiceCallbackData(data: string): string | undefined {
  if (
    Buffer.byteLength(data, "utf8") > TELEGRAM_CALLBACK_DATA_LIMIT_BYTES ||
    !data.startsWith(CHOICE_CALLBACK_PREFIX)
  ) {
    return undefined;
  }
  const token = data.slice(CHOICE_CALLBACK_PREFIX.length);
  return decisionTokenPattern.test(token) ? token : undefined;
}
