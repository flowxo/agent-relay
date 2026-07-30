import { describe, expect, it } from "vitest";

import { formatTelegramText } from "./formatting.js";

describe("Telegram literal rich-text formatting", () => {
  it("styles trusted structure while leaving Markdown-looking content literal", () => {
    const text = [
      "Codex · agent-relay",
      "",
      "Summary: literal *asterisks*, [link](https://invalid.example), and <b>tag</b> 🧪",
      "",
      "Waiting for your next instruction · now",
      "",
      "turn.stopped · codex/cli · main · session 12345678-a1b2c3",
    ].join("\n");

    const formatted = formatTelegramText(text);

    expect(formatted.text).toBe(text);
    expect(formatted.entities).toEqual(
      expect.arrayContaining([
        { type: "bold", offset: 0, length: "Codex · agent-relay".length },
        expect.objectContaining({
          type: "italic",
          length: "turn.stopped · codex/cli · main · session 12345678-a1b2c3"
            .length,
        }),
      ]),
    );
    for (const entity of formatted.entities) {
      expect(entity.offset).toBeGreaterThanOrEqual(0);
      expect(entity.length).toBeGreaterThan(0);
      expect(entity.offset + entity.length).toBeLessThanOrEqual(text.length);
    }
  });

  it("renders an open-session table as one preformatted entity", () => {
    const text = [
      "Open Agent Relay sessions · 2",
      "",
      "STATE  AGENT   PROJECT           BRANCH          SESSION",
      "─────  ──────  ────────────────  ──────────────  ───────────────",
      "WAIT   codex   agent-relay       main            12345678-a1b2c3",
    ].join("\n");

    const formatted = formatTelegramText(text);
    const tableOffset = text.indexOf("STATE");

    expect(formatted.entities).toContainEqual({
      type: "pre",
      offset: tableOffset,
      length: text.length - tableOffset,
    });
    expect(
      formatted.entities.filter((entity) => entity.type === "pre"),
    ).toHaveLength(1);
  });
});
