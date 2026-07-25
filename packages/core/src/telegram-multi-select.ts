import { Buffer } from "node:buffer";

import { TELEGRAM_CALLBACK_DATA_LIMIT_BYTES } from "./telegram-choice.js";

export type MultiSelectCallbackAction =
  "select" | "unselect" | "submit" | "cancel";

export interface ParsedMultiSelectCallback {
  action: MultiSelectCallbackAction;
  token: string;
}

const prefixByAction: Record<MultiSelectCallbackAction, string> = {
  select: "relay-m:s:",
  unselect: "relay-m:u:",
  submit: "relay-m:x:",
  cancel: "relay-m:c:",
};

const actionByCode: Record<string, MultiSelectCallbackAction | undefined> = {
  s: "select",
  u: "unselect",
  x: "submit",
  c: "cancel",
};

const optionTokenPattern = /^decision_[A-Za-z0-9_-]{8,48}$/;
const submitTokenPattern = /^draft_submit_[A-Za-z0-9-]{36}$/;
const cancelTokenPattern = /^draft_cancel_[A-Za-z0-9-]{36}$/;

function tokenMatches(action: MultiSelectCallbackAction, token: string) {
  if (action === "select" || action === "unselect") {
    return optionTokenPattern.test(token);
  }
  return action === "submit"
    ? submitTokenPattern.test(token)
    : cancelTokenPattern.test(token);
}

export function multiSelectCallbackData(
  action: MultiSelectCallbackAction,
  token: string,
): string {
  if (!tokenMatches(action, token)) {
    throw new Error("Telegram multi-select token is malformed");
  }
  const data = `${prefixByAction[action]}${token}`;
  if (Buffer.byteLength(data, "utf8") > TELEGRAM_CALLBACK_DATA_LIMIT_BYTES) {
    throw new Error("Telegram multi-select callback data exceeds 64 bytes");
  }
  return data;
}

export function parseMultiSelectCallbackData(
  data: string,
): ParsedMultiSelectCallback | undefined {
  if (Buffer.byteLength(data, "utf8") > TELEGRAM_CALLBACK_DATA_LIMIT_BYTES) {
    return undefined;
  }
  const match = /^relay-m:([suxc]):(.+)$/.exec(data);
  if (match === null) {
    return undefined;
  }
  const action = actionByCode[match[1] ?? ""];
  const token = match[2] ?? "";
  return action !== undefined && tokenMatches(action, token)
    ? { action, token }
    : undefined;
}
