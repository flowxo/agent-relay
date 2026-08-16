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
import { seedWebDemo } from "../dist/web-demo.js";
import type { WebDemoSeed } from "../dist/web-demo.js";

interface BrowserRuntime {
  daemon: RunningDaemon | undefined;
  baseUrl: string;
  port: number;
  databasePath: string;
  credentialPath: string;
  credential: WebCredential;
  seed: WebDemoSeed;
}

let temporaryDirectory: string | undefined;
let runtime: BrowserRuntime | undefined;

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

async function createRuntime(): Promise<BrowserRuntime> {
  temporaryDirectory = await mkdtemp(
    join(tmpdir(), "agent-relay-web-browser-"),
  );
  const databasePath = join(temporaryDirectory, "relay.sqlite");
  const credentialPath = join(temporaryDirectory, "web-credential.json");
  const daemon = await launchDaemon(databasePath, credentialPath, 0);
  const address = daemon.server.address();
  if (address === null || typeof address === "string") {
    await daemon.close();
    throw new Error("browser test daemon did not expose a TCP address");
  }
  const seed = await seedWebDemo(daemon.service, {
    runId: "browserdemo1",
  });
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

async function connect(page: Page, active: BrowserRuntime): Promise<void> {
  const bootstrapUrl = await bootstrap(active);
  await page.goto(bootstrapUrl);
  await expect(page.locator("[data-console]")).toBeVisible();
  await expect(page).toHaveURL(`${active.baseUrl}/ui/`);
  expect(page.url()).not.toContain("grant=");
}

async function bootstrap(active: BrowserRuntime): Promise<string> {
  const response = await fetch(`${active.baseUrl}/v1/web/bootstrap-grants`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${active.credential.token}`,
      origin: active.baseUrl,
      "x-agent-relay-csrf": active.credential.csrfToken,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      schema: "agent-relay-web-bootstrap-create.v1",
    }),
  });
  expect(response.status).toBe(201);
  const body = (await response.json()) as { grant: string };
  const url = new URL("/ui/", active.baseUrl);
  url.searchParams.set("grant", body.grant);
  return url.toString();
}

function textForm(page: Page, active: BrowserRuntime) {
  return page.locator(
    `[data-response-form][data-request-id="${active.seed.textRequestId}"]`,
  );
}

async function telegramAnswer(
  active: BrowserRuntime,
  updateId: number,
  answer: string,
): Promise<{ outcome?: unknown }> {
  const daemon = active.daemon;
  if (daemon === undefined) {
    throw new Error("browser test daemon is stopped");
  }
  const sessionId = active.seed.sessionIds[1];
  const topic = daemon.service.store
    .listSessionTopics()
    .find((candidate) => candidate.sessionId === sessionId);
  if (topic?.topicId === undefined) {
    throw new Error("demo request did not receive a fake Telegram topic");
  }
  const response = await fetch(`${active.baseUrl}/v1/telegram/updates`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      update_id: updateId,
      message: {
        message_id: updateId + 1_000,
        message_thread_id: Number(topic.topicId),
        from: { id: 7001 },
        chat: { id: 9001 },
        text: answer,
      },
    }),
  });
  expect(response.ok).toBe(true);
  return (await response.json()) as { outcome?: unknown };
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

test("refreshes, reopens, removes grant history, and rejects replay", async ({
  page,
}) => {
  const active = runtime;
  if (active === undefined) {
    throw new Error("browser runtime is unavailable");
  }
  const bootstrapUrl = await bootstrap(active);
  await page.goto(bootstrapUrl);
  await expect(page.locator("[data-console]")).toBeVisible();
  await expect(page).toHaveURL(`${active.baseUrl}/ui/`);
  await page.reload();
  await expect(page.locator("[data-console]")).toBeVisible();

  const context = page.context();
  await page.close();
  const reopened = await context.newPage();
  await reopened.goto(`${active.baseUrl}/ui/`);
  await expect(reopened.locator("[data-console]")).toBeVisible();
  const replay = await context.newPage();
  await replay.goto(bootstrapUrl);
  await expect(replay.locator("[data-connect-panel]")).toBeVisible();
  await expect(replay.locator("[data-connect-error]")).toContainText(
    "stale or already used",
  );
  expect(replay.url()).not.toContain("grant=");
  await replay.goBack();
  expect(replay.url()).not.toContain("grant=");
  await reopened.close();
  await replay.close();
});

test("retains the browser session and reports a post-authentication load failure accurately", async ({
  page,
}) => {
  const active = runtime;
  if (active === undefined) {
    throw new Error("browser runtime is unavailable");
  }
  await page.route("**/v1/web/sessions?*", async (route) => {
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ code: "synthetic-session-load-failure" }),
    });
  });
  await page.goto(await bootstrap(active));
  await expect(page.locator("[data-connect-panel]")).toBeVisible();
  await expect(page.locator("[data-connect-error]")).toContainText(
    "browser session is authenticated, but dashboard data could not load",
  );
  expect(page.url()).not.toContain("grant=");

  await page.unroute("**/v1/web/sessions?*");
  await page.reload();
  await expect(page.locator("[data-console]")).toBeVisible();
});

test("shows compact recovery and keeps manual credentials behind Advanced", async ({
  page,
}) => {
  const active = runtime;
  if (active === undefined) {
    throw new Error("browser runtime is unavailable");
  }
  await page.goto(`${active.baseUrl}/ui/`);
  const command = page.locator("[data-dashboard-command]");
  await expect(command).toBeVisible();
  await expect(command).toContainText("agent-relay dashboard --web");
  const bounds = await command.boundingBox();
  expect((bounds?.y ?? 1_000) + (bounds?.height ?? 1_000)).toBeLessThan(720);
  await expect(page.getByLabel("Local bearer token")).toBeHidden();
  await page
    .getByText("Advanced recovery: connect manually", { exact: true })
    .click();
  await page.getByLabel("Local bearer token").fill(active.credential.token);
  await page.getByLabel("Local CSRF token").fill(active.credential.csrfToken);
  await page.getByRole("button", { name: "Connect manually" }).click();
  await expect(page.locator("[data-console]")).toBeVisible();
  expect(
    await page.evaluate(() => ({
      local: Object.keys(localStorage),
      session: Object.keys(sessionStorage),
    })),
  ).toEqual({ local: [], session: [] });
});

test("shows sanitized concurrent fake sessions and requires a new launch after daemon restart", async ({
  page,
}) => {
  const active = runtime;
  if (active === undefined) {
    throw new Error("browser runtime is unavailable");
  }
  await connect(page, active);
  await expect(page.locator("[data-connection-label]")).toHaveText("Live");

  await expect(page.locator("[data-current-list] .session-card")).toHaveCount(
    5,
  );
  await expect(page.locator("[data-rail-list]")).toContainText("payments-api");
  await expect(page.locator("[data-attention-list]")).toContainText("Failed");
  await expect(page.locator("body")).not.toContainText("private transcript");

  const form = textForm(page, active);
  await form.locator('[name="response"]').fill("Synthetic page-memory draft");
  await active.daemon?.close();
  active.daemon = undefined;
  await expect(page.locator("[data-connection-label]")).toHaveText(
    "Reconnecting",
  );

  active.daemon = await launchDaemon(
    active.databasePath,
    active.credentialPath,
    active.port,
  );
  await expect(page.locator("[data-connect-panel]")).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.locator("[data-connect-error]")).toContainText(
    "browser session ended",
  );
  await page.goto(await bootstrap(active));
  await expect(page.locator("[data-connection-label]")).toHaveText("Live");
  await expect(textForm(page, active).locator('[name="response"]')).toHaveValue(
    "",
  );
  expect(
    active.daemon.service.getRequest(active.seed.textRequestId),
  ).toMatchObject({ state: "open" });
});

test("rejects a stale browser form after Telegram resolves the exact request", async ({
  page,
}) => {
  const active = runtime;
  if (active === undefined) {
    throw new Error("browser runtime is unavailable");
  }
  await page.route("**/v1/web/project-changes?*", async (route) => {
    await route.abort();
  });
  await connect(page, active);
  const form = textForm(page, active);
  await form.locator('[name="response"]').fill("Stale browser candidate");

  expect(
    await telegramAnswer(active, 51_001, "Synthetic Telegram winner"),
  ).toMatchObject({ outcome: "answered" });
  await form.getByRole("button", { name: "Submit response" }).click();

  await expect(textForm(page, active)).toHaveCount(0);
  await expect(page.locator("[data-notice-list]")).toContainText(
    "answered in telegram",
  );
  expect(
    active.daemon?.service.getRequest(active.seed.textRequestId),
  ).toMatchObject({
    state: "answered",
    resolvedBy: "telegram",
    answer: "Synthetic Telegram winner",
  });
});

test("allows only one winner in a simultaneous fake-Telegram and browser race", async ({
  page,
}) => {
  const active = runtime;
  if (active === undefined) {
    throw new Error("browser runtime is unavailable");
  }
  await connect(page, active);
  await expect(page.locator("[data-connection-label]")).toHaveText("Live");
  const form = textForm(page, active);
  await form.locator('[name="response"]').fill("Synthetic browser candidate");
  let releaseBrowserRequest = (): void => {
    throw new Error("browser request gate was not initialized");
  };
  let markBrowserRequestReady = (): void => {
    throw new Error("browser request readiness was not initialized");
  };
  const browserRequestGate = new Promise<void>((resolve) => {
    releaseBrowserRequest = resolve;
  });
  const browserRequestReady = new Promise<void>((resolve) => {
    markBrowserRequestReady = resolve;
  });
  await page.route(
    `**/v1/web/requests/${active.seed.textRequestId}/resolve`,
    async (route) => {
      markBrowserRequestReady();
      await browserRequestGate;
      await route.continue();
    },
  );
  const browserResponse = page.waitForResponse((response) =>
    response
      .url()
      .includes(`/v1/web/requests/${active.seed.textRequestId}/resolve`),
  );
  await form.getByRole("button", { name: "Submit response" }).click();
  await browserRequestReady;
  const telegramResultPromise = telegramAnswer(
    active,
    51_002,
    "Synthetic Telegram candidate",
  );
  releaseBrowserRequest();
  const [telegramResult, response] = await Promise.all([
    telegramResultPromise,
    browserResponse,
  ]);
  expect([200, 409]).toContain(response.status());
  expect(["answered", "duplicate", "no-eligible-request"]).toContain(
    telegramResult.outcome,
  );

  await expect(textForm(page, active)).toHaveCount(0);
  await expect(page.locator("[data-notice-list]")).toContainText("answered");
  const stored = active.daemon?.service.getRequest(active.seed.textRequestId);
  expect(stored).toMatchObject({ state: "answered" });
  expect(["telegram", "web"]).toContain(stored?.resolvedBy);
  expect([
    "Synthetic Telegram candidate",
    "Synthetic browser candidate",
  ]).toContain(stored?.answer);
});
