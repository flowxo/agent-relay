export interface TelegramTextEntity {
  type: "bold" | "italic" | "pre";
  offset: number;
  length: number;
}

export interface TelegramFormattedText {
  text: string;
  entities: TelegramTextEntity[];
}

const STATE_LINE =
  /^(?:Session started|Working|Activity|Waiting for your next instruction|Turn failed|Input required|Approval required|Process exited|Process may be stale|Session ended|Answered|Canceled|Expired|Superseded|Failed)(?:\s|·|$)/u;
const SESSION_STATUS_LINE =
  /^(?:🟢 Running|🟡 Waiting|🔕 Muted|🔴 Crashed|🟠 Possibly stalled|⚫ Ended)$/u;
const EVENT_FOOTER =
  /^(?:session\.started|turn\.started|turn\.activity|turn\.stopped|input\.required|permission\.required|turn\.failed|process\.stale|process\.exited|session\.ended)\s+·/u;
const LABELS = [
  "Summary:",
  "Question:",
  "Request:",
  "Selected:",
  "Selection draft:",
  "Project:",
  "Branch:",
  "Harness:",
  "Session:",
  "Last event:",
  "Last seen:",
  "Open requests:",
] as const;

interface TextLine {
  text: string;
  offset: number;
}

function textLines(text: string): TextLine[] {
  const lines: TextLine[] = [];
  let offset = 0;
  for (const line of text.split("\n")) {
    lines.push({ text: line, offset });
    offset += line.length + 1;
  }
  return lines;
}

function overlaps(
  entity: TelegramTextEntity,
  start: number,
  length: number,
): boolean {
  const end = start + length;
  return entity.offset < end && start < entity.offset + entity.length;
}

/**
 * Builds Bot API entities over literal text. No user or model text is parsed
 * as markup, so Markdown-looking content remains inert and visible.
 *
 * JavaScript string offsets count UTF-16 code units, which is the unit the
 * Telegram Bot API requires for MessageEntity offsets and lengths.
 */
export function formatTelegramText(text: string): TelegramFormattedText {
  const lines = textLines(text);
  const entities: TelegramTextEntity[] = [];
  const first = lines.find((line) => line.text.length > 0);
  if (first !== undefined) {
    entities.push({
      type: "bold",
      offset: first.offset,
      length: first.text.length,
    });
  }

  const tableHeader = lines.find(
    (line) =>
      line.text.startsWith("STATE ") &&
      line.text.includes("PROJECT") &&
      line.text.includes("SESSION"),
  );
  if (tableHeader !== undefined) {
    const tableText = text.slice(tableHeader.offset).trimEnd();
    if (tableText.length > 0) {
      entities.push({
        type: "pre",
        offset: tableHeader.offset,
        length: tableText.length,
      });
    }
  }

  for (const line of lines) {
    if (line.text.length === 0) {
      continue;
    }
    if (STATE_LINE.test(line.text) || SESSION_STATUS_LINE.test(line.text)) {
      if (
        !entities.some((entity) =>
          overlaps(entity, line.offset, line.text.length),
        )
      ) {
        entities.push({
          type: "bold",
          offset: line.offset,
          length: line.text.length,
        });
      }
      continue;
    }
    if (EVENT_FOOTER.test(line.text)) {
      if (
        !entities.some((entity) =>
          overlaps(entity, line.offset, line.text.length),
        )
      ) {
        entities.push({
          type: "italic",
          offset: line.offset,
          length: line.text.length,
        });
      }
      continue;
    }
    const label = LABELS.find((candidate) => line.text.startsWith(candidate));
    if (
      label !== undefined &&
      !entities.some((entity) => overlaps(entity, line.offset, label.length))
    ) {
      entities.push({
        type: "bold",
        offset: line.offset,
        length: label.length,
      });
    }
  }
  return {
    text,
    entities: entities.sort((left, right) => left.offset - right.offset),
  };
}

export function formattedTelegramPayload(text: string): {
  text: string;
  entities?: TelegramTextEntity[];
} {
  const formatted = formatTelegramText(text);
  return {
    text: formatted.text,
    ...(formatted.entities.length === 0
      ? {}
      : { entities: formatted.entities }),
  };
}
