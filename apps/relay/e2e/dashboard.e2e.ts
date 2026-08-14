import { readFile, rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { MemoryLogger } from "@agent-relay/core";

import { startDaemon } from "../dist/daemon.js";
import type { RunningDaemon } from "../dist/daemon.js";
import { WebCredentialSchema } from "../dist/web-credential.js";
import type { WebCredential } from "../dist/web-credential.js";
import {
  HISTORY_SESSION_COUNT,
  PRIVATE_BRANCH_SENTINEL,
  PRIVATE_PATH_SENTINEL,
  PRIVATE_TRANSCRIPT_SENTINEL,
  seedDashboard,
  seedExtraSession,
} from "./fixtures.js";
import type { DashboardSeed } from "./fixtures.js";

interface DashboardRuntime {
  daemon: RunningDaemon | undefined;
  baseUrl: string;
  port: number;
  databasePath: string;
  credentialPath: string;
  credential: WebCredential;
  seed: DashboardSeed;
}

let temporaryDirectory: string | undefined;
let runtime: DashboardRuntime | undefined;

async function launchDaemon(
  databasePath: string,
  credentialPath: string,
  port: number,
): Promise<RunningDaemon> {
  return await startDaemon({
    databasePath,
    webCredentialPath: credentialPath,
    port,
    telegramOperatorUserId: 7001,
    telegramReplyChatId: 9001,
    drainIntervalMs: 60_000,
    retentionIntervalMs: 60_000,
    logger: new MemoryLogger(),
  });
}

async function createRuntime(): Promise<DashboardRuntime> {
  temporaryDirectory = await mkdtemp(join(tmpdir(), "agent-relay-dashboard-"));
  const databasePath = join(temporaryDirectory, "relay.sqlite");
  const credentialPath = join(temporaryDirectory, "web-credential.json");
  const daemon = await launchDaemon(databasePath, credentialPath, 0);
  const address = daemon.server.address();
  if (address === null || typeof address === "string") {
    await daemon.close();
    throw new Error("dashboard test daemon did not expose a TCP address");
  }
  const seed = await seedDashboard(daemon.service, "dashboardfix1");
  const credential = WebCredentialSchema.parse(
    JSON.parse(await readFile(credentialPath, "utf8")) as unknown,
  );
  return {
    daemon,
    baseUrl: `http://127.0.0.1:${address.port}`,
    port: address.port,
    databasePath,
    credentialPath,
    credential,
    seed,
  };
}

async function bootstrap(active: DashboardRuntime): Promise<string> {
  const response = await fetch(`${active.baseUrl}/v1/web/bootstrap-grants`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${active.credential.token}`,
      origin: active.baseUrl,
      "x-agent-relay-csrf": active.credential.csrfToken,
      "content-type": "application/json",
    },
    body: JSON.stringify({ schema: "agent-relay-web-bootstrap-create.v1" }),
  });
  expect(response.status).toBe(201);
  const body = (await response.json()) as { grant: string };
  const url = new URL("/ui/", active.baseUrl);
  url.searchParams.set("grant", body.grant);
  return url.toString();
}

async function connect(page: Page, active: DashboardRuntime): Promise<void> {
  await page.goto(await bootstrap(active));
  await expect(page.locator("[data-console]")).toBeVisible();
  await expect(page.locator("[data-pane-body]")).toBeVisible();
}

function active(): DashboardRuntime {
  if (runtime === undefined)
    throw new Error("dashboard runtime is unavailable");
  return runtime;
}

test.beforeEach(async () => {
  runtime = await createRuntime();
});

test.afterEach(async () => {
  await runtime?.daemon?.close();
  runtime = undefined;
  if (temporaryDirectory !== undefined) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = undefined;
  }
});

test("presents the project rail, attention, current, and recent hierarchy", async ({
  page,
}) => {
  const current = active();
  await connect(page, current);

  await expect(page.locator("[data-rail-list] .rail-button")).toHaveCount(5);
  await expect(
    page.locator("[data-rail-list] .rail-button").first(),
  ).toContainText("All projects");
  await expect(
    page.locator("[data-rail-list] .rail-button").first(),
  ).toHaveAttribute("aria-current", "true");
  await expect(page.locator("[data-rail-total]")).toHaveText("4 projects");

  const sectionIds = await page
    .locator(".pane-section")
    .evaluateAll((nodes) => nodes.map((node) => node.id));
  expect(sectionIds).toEqual([
    "needs-attention",
    "current-sessions",
    "recent-sessions",
  ]);

  await expect(
    page.locator("[data-attention-list] .attention-card"),
  ).toHaveCount(5);
  await expect(page.locator("[data-attention-list]")).toContainText("Failed");
  await expect(page.locator("[data-attention-list]")).toContainText("Unknown");

  const harnessHeadings = await page
    .locator("[data-current-list] .harness-heading")
    .evaluateAll((nodes) =>
      nodes.map((node) => node.textContent?.trim().split("\n")[0]?.trim()),
    );
  expect(harnessHeadings).toEqual(["Codex", "Claude Code", "Cursor"]);
  await expect(page.locator("[data-current-list] .session-card")).toHaveCount(
    7,
  );

  await expect(page.locator("[data-history-body] tr")).toHaveCount(25);
  const historyStates = await page
    .locator("[data-history-body] tr .chip")
    .evaluateAll((nodes) => [
      ...new Set(nodes.map((node) => node.textContent?.trim())),
    ]);
  expect(historyStates).toEqual(["Ended"]);
  await expect(page.locator("[data-recent-count]")).toHaveText("25 loaded");
});

test("selects one opaque worktree without collapsing duplicate labels", async ({
  page,
}) => {
  const current = active();
  await connect(page, current);

  const duplicates = page
    .locator("[data-rail-list] .rail-button")
    .filter({ hasText: "checkout-service" });
  await expect(duplicates).toHaveCount(2);
  const labels = await duplicates.evaluateAll((nodes) =>
    nodes.map((node) => node.querySelector(".rail-label")?.textContent?.trim()),
  );
  expect(new Set(labels).size).toBe(2);

  await duplicates.first().click();
  await expect(page.locator("[data-pane-title]")).toContainText(
    "checkout-service",
  );
  await expect(duplicates.first()).toHaveAttribute("aria-current", "true");
  await expect(page.locator("[data-current-list] .session-card")).toHaveCount(
    2,
  );
  await expect(page.locator("[data-history-body] tr")).toHaveCount(0);
  await expect(page.locator("[data-history-empty]")).toBeVisible();

  await page.locator("[data-rail-list] .rail-button").first().click();
  await expect(page.locator("[data-pane-title]")).toHaveText("All projects");
  await expect(page.locator("[data-history-body] tr")).toHaveCount(25);
});

test("pages recent history without duplicating rows or hiding attention", async ({
  page,
}) => {
  const current = active();
  await connect(page, current);

  const attentionBefore = await page
    .locator("[data-attention-list] .attention-card")
    .count();
  await page.locator("[data-load-more]").click();
  await expect(page.locator("[data-history-body] tr")).toHaveCount(
    HISTORY_SESSION_COUNT,
  );
  const keys = await page
    .locator("[data-history-body] tr")
    .evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute("data-history-session")),
    );
  expect(new Set(keys).size).toBe(HISTORY_SESSION_COUNT);
  await expect(
    page.locator("[data-attention-list] .attention-card"),
  ).toHaveCount(attentionBefore);
  await expect(page.locator("[data-load-more]")).toBeHidden();
  await expect(page.locator("[data-history-summary]")).toContainText(
    "end of retained history",
  );
  await expect(page.locator("[data-history-summary]")).toBeFocused();
});

test("recovers from a stale history cursor by reloading the newest page", async ({
  page,
}) => {
  const current = active();
  await connect(page, current);
  await expect(page.locator("[data-history-body] tr")).toHaveCount(25);

  await page.route("**/v1/web/projects?*cursor=*", async (route) => {
    await route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({
        code: "stale_cursor",
        message: "project history changed; fetch a fresh snapshot",
      }),
    });
  });
  await page.locator("[data-load-more]").click();
  await expect(page.locator("[data-history-body] tr")).toHaveCount(25);
  const keys = await page
    .locator("[data-history-body] tr")
    .evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute("data-history-session")),
    );
  expect(new Set(keys).size).toBe(25);
  await page.unroute("**/v1/web/projects?*cursor=*");
});

test("answers a structured question and a questionnaire against the exact session", async ({
  page,
}) => {
  const current = active();
  await connect(page, current);

  const textForm = page.locator(
    `[data-response-form][data-request-id="${current.seed.textRequestId}"]`,
  );
  await expect(textForm).toBeVisible();
  await textForm.locator('[name="response"]').fill("Synthetic browser answer");
  await textForm.getByRole("button", { name: "Submit response" }).click();
  await expect(textForm).toHaveCount(0);
  await expect(page.locator("[data-notice-list]")).toContainText(
    "answered in this browser",
  );
  expect(
    current.daemon?.service.getRequest(current.seed.textRequestId),
  ).toMatchObject({ state: "answered", resolvedBy: "web" });

  const setForm = page.locator(
    `[data-response-form][data-request-id="${current.seed.questionSetRequestId}"]`,
  );
  await expect(setForm).toBeVisible();
  await setForm.getByRole("radio", { name: "Proceed" }).check();
  await setForm.locator("textarea").fill("Synthetic note");
  await setForm.getByRole("button", { name: "Submit response" }).click();
  await expect(setForm).toHaveCount(0);
  expect(
    current.daemon?.service.getRequest(current.seed.questionSetRequestId),
  ).toMatchObject({ state: "answered", resolvedBy: "web" });

  const selectForm = page.locator(
    `[data-response-form][data-request-id="${current.seed.selectRequestId}"]`,
  );
  await expect(selectForm.getByRole("radio", { name: "Canary" })).toBeVisible();
  await expect(selectForm.getByRole("radio", { name: "Hold" })).toBeVisible();
});

test("holds live updates while the operator has focus in a live section", async ({
  page,
}) => {
  const current = active();
  await connect(page, current);
  const currentCards = page.locator("[data-current-list] .session-card");
  await expect(currentCards).toHaveCount(7);

  await page
    .locator("[data-current-list] .session-card .why summary")
    .first()
    .focus();
  await seedExtraSession(
    current.daemon?.service ??
      (() => {
        throw new Error("dashboard daemon is stopped");
      })(),
    current.seed.runId,
    "hold",
  );

  await expect(page.locator("[data-update-pill]")).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.locator("[data-update-pill]")).toContainText(
    "keyboard focus",
  );
  await expect(currentCards).toHaveCount(7);

  await page.getByRole("button", { name: "Show updates" }).click();
  await expect(currentCards).toHaveCount(8);
  await expect(page.locator("[data-update-pill]")).toBeHidden();
});

test("keeps loaded history in place when live activity arrives, and reloads on request", async ({
  page,
}) => {
  const current = active();
  await connect(page, current);
  await page.locator("[data-load-more]").click();
  await expect(page.locator("[data-history-body] tr")).toHaveCount(
    HISTORY_SESSION_COUNT,
  );

  await seedExtraSession(
    current.daemon?.service ??
      (() => {
        throw new Error("dashboard daemon is stopped");
      })(),
    current.seed.runId,
    "history",
  );
  await expect(page.locator("[data-update-pill]")).toBeVisible({
    timeout: 20_000,
  });
  await page.getByRole("button", { name: "Show updates" }).click();
  await expect(page.locator("[data-history-stale]")).toBeVisible();
  await expect(page.locator("[data-history-body] tr")).toHaveCount(
    HISTORY_SESSION_COUNT,
  );

  await page.getByRole("button", { name: "Reload history" }).click();
  await expect(page.locator("[data-history-body] tr")).toHaveCount(25);
  await expect(page.locator("[data-history-stale]")).toBeHidden();
});

test("keeps a project selection made while an older snapshot is in flight", async ({
  page,
}) => {
  const current = active();
  await connect(page, current);
  const duplicates = page
    .locator("[data-rail-list] .rail-button")
    .filter({ hasText: "checkout-service" });
  await expect(duplicates).toHaveCount(2);

  await duplicates.nth(1).click();
  await expect(page.locator("[data-pane-title]")).toContainText(
    "checkout-service",
  );

  let delay = true;
  await page.route("**/v1/web/projects?*", async (route) => {
    if (delay) {
      delay = false;
      await new Promise((resolve) => setTimeout(resolve, 1_500));
    }
    await route.continue();
  });
  await duplicates.first().click();
  await page.locator("[data-rail-list] .rail-button").first().click();
  await expect(page.locator("[data-pane-title]")).toHaveText("All projects", {
    timeout: 20_000,
  });
  await expect(
    page.locator("[data-rail-list] .rail-button").first(),
  ).toHaveAttribute("aria-current", "true");
  await expect(page.locator("[data-pane-loading]")).toBeHidden();
  await expect(page.locator("[data-history-body] tr")).toHaveCount(25);
  await page.unroute("**/v1/web/projects?*");
});

test("closes the evidence view and stops holding updates when the session ends", async ({
  page,
}) => {
  const current = active();
  await connect(page, current);
  await page
    .locator(
      "[data-current-list] [data-session-action='details']:not([disabled])",
    )
    .first()
    .click();
  await expect(page.locator("[data-drawer-backdrop]")).toBeVisible();

  await current.daemon?.close();
  current.daemon = undefined;
  current.daemon = await launchDaemon(
    current.databasePath,
    current.credentialPath,
    current.port,
  );
  await expect(page.locator("[data-connect-panel]")).toBeVisible({
    timeout: 25_000,
  });
  await expect(page.locator("[data-drawer-backdrop]")).toBeHidden();
  expect(
    await page.evaluate(() => document.body.classList.contains("drawer-open")),
  ).toBe(false);
});

test("clears revealed private content when the evidence view closes", async ({
  page,
}) => {
  const current = active();
  await connect(page, current);
  const detailsButton = page
    .locator(
      "[data-current-list] [data-session-action='details']:not([disabled])",
    )
    .first();
  await detailsButton.click();
  await page.locator("[data-timeline-list] .timeline-entry").first().click();
  await expect(page.locator("[data-event-detail]")).toBeVisible();
  await expect(page.locator("[data-close-detail]")).toBeFocused();
  await page.getByRole("button", { name: /Reveal private/u }).click();
  await expect(page.locator("[data-private-reveal]")).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(page.locator("[data-drawer-backdrop]")).toBeHidden();
  expect(
    await page.evaluate(() => ({
      reveal:
        document.querySelector("[data-private-reveal-content]")?.textContent ??
        "",
      detail: document.querySelector("[data-event-detail]")?.textContent ?? "",
    })),
  ).toEqual({ reveal: "", detail: "" });
});

test("keeps the dashboard free of paths, branches, transcripts, and private identifiers", async ({
  page,
}) => {
  const current = active();
  await connect(page, current);
  await page.locator("[data-load-more]").click();
  await expect(page.locator("[data-history-body] tr")).toHaveCount(
    HISTORY_SESSION_COUNT,
  );

  const detailsButton = page
    .locator(
      "[data-current-list] [data-session-action='details']:not([disabled])",
    )
    .first();
  await detailsButton.click();
  await expect(page.locator("[data-timeline-list] li")).not.toHaveCount(0);
  await page.locator("[data-timeline-list] .timeline-entry").first().click();
  await expect(page.locator("[data-event-detail]")).toBeVisible();

  const markup = await page.content();
  for (const forbidden of [
    PRIVATE_PATH_SENTINEL,
    PRIVATE_BRANCH_SENTINEL,
    PRIVATE_TRANSCRIPT_SENTINEL,
    current.seed.machineId,
    current.seed.workingSessionId,
    current.seed.failedSessionId,
    "cwdHash",
    "sha256:",
  ]) {
    expect(markup).not.toContain(forbidden);
  }
  expect(
    await page.evaluate(() => ({
      local: Object.keys(localStorage),
      session: Object.keys(sessionStorage),
      xss: (window as unknown as { __xss?: number }).__xss,
    })),
  ).toEqual({ local: [], session: [], xss: undefined });
  expect(await page.locator("[data-rail-list] img").count()).toBe(0);
});

test("supports keyboard-only navigation, landmarks, and status announcements", async ({
  page,
}) => {
  const current = active();
  await connect(page, current);

  await expect(page.locator("header.topbar")).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "Projects" }),
  ).toBeVisible();
  await expect(page.getByRole("main")).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
  const headingLevels = await page
    .locator("h1, h2, h3, h4")
    .evaluateAll((nodes) =>
      nodes
        .filter((node) => node.checkVisibility())
        .map((node) => Number(node.tagName.slice(1))),
    );
  expect(headingLevels[0]).toBe(1);
  for (const [index, level] of headingLevels.entries()) {
    if (index === 0) continue;
    expect(level - (headingLevels[index - 1] ?? 1)).toBeLessThanOrEqual(1);
  }

  await page.keyboard.press("Tab");
  await expect(page.locator(".skip-link")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#project-pane$/u);

  const railButton = page.locator("[data-rail-list] .rail-button").nth(1);
  await railButton.focus();
  const outline = await railButton.evaluate(
    (node) => getComputedStyle(node).outlineStyle,
  );
  expect(outline).not.toBe("none");
  await page.keyboard.press("Enter");
  await expect(railButton).toHaveAttribute("aria-current", "true");
  await expect(railButton).toBeFocused();

  await expect(page.locator("[data-live-region]")).toContainText("attention", {
    timeout: 15_000,
  });

  const detailsButton = page
    .locator(
      "[data-attention-list] [data-session-action='details']:not([disabled])",
    )
    .first();
  await detailsButton.click();
  await expect(page.locator("[data-drawer-backdrop]")).toBeVisible();
  await expect(page.locator("[data-close-timeline]")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.locator("[data-drawer-backdrop]")).toBeHidden();
  await expect(detailsButton).toBeFocused();
});

test("confirms an end action before closing the relay lane", async ({
  page,
}) => {
  const current = active();
  await connect(page, current);
  const endButton = page
    .locator("[data-current-list] [data-session-action='end']:not([disabled])")
    .first();
  await expect(endButton).toHaveText("End");
  await endButton.click();
  await expect(endButton).toHaveText("Confirm end");
  await expect(page.locator("[data-live-region]")).toContainText(
    "Activate End again to confirm",
  );
  await page.keyboard.press("Escape");
  await expect(
    page.locator("[data-current-list] [data-session-action='end']").first(),
  ).toHaveText("End");
});

test("stays usable at laptop and narrow mobile viewports", async ({ page }) => {
  const current = active();
  await page.setViewportSize({ width: 390, height: 844 });
  await connect(page, current);

  for (const width of [1440, 1280, 1024, 768, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(
      overflow.scrollWidth,
      `horizontal overflow at ${String(width)}px`,
    ).toBeLessThanOrEqual(overflow.clientWidth + 1);
  }
  await page.setViewportSize({ width: 390, height: 844 });

  await expect(page.locator("[data-rail-list]")).toBeVisible();
  await expect(
    page.locator("[data-attention-list] .attention-card"),
  ).not.toHaveCount(0);
  const stacked = await page
    .locator("[data-history-body] tr")
    .first()
    .evaluate((node) => getComputedStyle(node).display);
  expect(stacked).toBe("block");
});

test("respects reduced motion", async ({ page }) => {
  const current = active();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await connect(page, current);
  const durations = await page.evaluate(() =>
    [...document.querySelectorAll(".rail-button, .session-action")].map(
      (node) => getComputedStyle(node).transitionDuration,
    ),
  );
  expect(durations.every((value) => value === "0.001s" || value === "0s")).toBe(
    true,
  );
});

test("explains a lost daemon and requires a fresh launch after restart", async ({
  page,
}) => {
  const current = active();
  await connect(page, current);
  await expect(page.locator("[data-connection-label]")).toHaveText("Live");

  await current.daemon?.close();
  current.daemon = undefined;
  await expect(page.locator("[data-connection-label]")).toHaveText(
    "Reconnecting",
    { timeout: 20_000 },
  );
  await expect(page.locator("[data-status-banner]")).toBeVisible();

  current.daemon = await launchDaemon(
    current.databasePath,
    current.credentialPath,
    current.port,
  );
  await expect(page.locator("[data-connect-panel]")).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.locator("[data-connect-error]")).toContainText(
    "browser session ended",
  );

  await page.goto(await bootstrap(current));
  await expect(page.locator("[data-connection-label]")).toHaveText("Live");
  await expect(page.locator("[data-history-body] tr")).toHaveCount(25);
});
