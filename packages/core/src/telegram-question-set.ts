import { Buffer } from "node:buffer";

import { TELEGRAM_CALLBACK_DATA_LIMIT_BYTES } from "./telegram-choice.js";

export type QuestionSetCallbackAction =
  "choose" | "select" | "unselect" | "next" | "back" | "submit" | "cancel";

export interface ParsedQuestionSetCallback {
  action: QuestionSetCallbackAction;
  token: string;
}

const codeByAction: Record<QuestionSetCallbackAction, string> = {
  choose: "o",
  select: "s",
  unselect: "u",
  next: "n",
  back: "b",
  submit: "x",
  cancel: "c",
};

const actionByCode: Record<string, QuestionSetCallbackAction | undefined> = {
  o: "choose",
  s: "select",
  u: "unselect",
  n: "next",
  b: "back",
  x: "submit",
  c: "cancel",
};

const optionTokenPattern = /^decision_[A-Za-z0-9_-]{8,48}$/;
const navigationPatterns: Record<
  Exclude<QuestionSetCallbackAction, "choose" | "select" | "unselect">,
  RegExp
> = {
  next: /^wizard_next_[A-Za-z0-9-]{36}$/,
  back: /^wizard_back_[A-Za-z0-9-]{36}$/,
  submit: /^wizard_submit_[A-Za-z0-9-]{36}$/,
  cancel: /^wizard_cancel_[A-Za-z0-9-]{36}$/,
};

function matchesToken(action: QuestionSetCallbackAction, token: string) {
  if (action === "choose" || action === "select" || action === "unselect") {
    return optionTokenPattern.test(token);
  }
  return navigationPatterns[action].test(token);
}

export function questionSetCallbackData(
  action: QuestionSetCallbackAction,
  token: string,
): string {
  if (!matchesToken(action, token)) {
    throw new Error("Telegram question-set token is malformed");
  }
  const data = `relay-w:${codeByAction[action]}:${token}`;
  if (Buffer.byteLength(data, "utf8") > TELEGRAM_CALLBACK_DATA_LIMIT_BYTES) {
    throw new Error("Telegram question-set callback data exceeds 64 bytes");
  }
  return data;
}

export function parseQuestionSetCallbackData(
  data: string,
): ParsedQuestionSetCallback | undefined {
  if (Buffer.byteLength(data, "utf8") > TELEGRAM_CALLBACK_DATA_LIMIT_BYTES) {
    return undefined;
  }
  const match = /^relay-w:([osunbxc]):(.+)$/.exec(data);
  if (match === null) {
    return undefined;
  }
  const action = actionByCode[match[1] ?? ""];
  const token = match[2] ?? "";
  return action !== undefined && matchesToken(action, token)
    ? { action, token }
    : undefined;
}
