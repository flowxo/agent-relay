import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, resolve } from "node:path";
import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";
import { pathToFileURL, URL } from "node:url";

const root = resolve(import.meta.dirname, "..");
const { fetch, Headers, Request } = globalThis;
const release = JSON.parse(
  await readFile(resolve(root, "packaging/release.json"), "utf8"),
);
const contractLock = JSON.parse(
  await readFile(resolve(root, "contracts/contract-lock.json"), "utf8"),
);
const sensitiveValues = new Set();

const MACHINE_ID = "machine_synthetic_a";
const MACHINE_CLIENT_ID = "machine_client_synthetic_001";
const SUBSCRIBER_ID = "agent_relay_operator";
const NOTIFIER_ID = "default";
const BINDING_ID = "binding_synthetic_relay";
const PROJECT_ID = "project_synthetic";
const ACCOUNT_ID = "account_synthetic";
const DAEMON_TOKEN = `daemon_${randomBytes(24).toString("base64url")}`;
const TELEGRAM_TOKEN = [
  String(100_000 + Math.floor(Math.random() * 899_999)),
  randomBytes(24).toString("base64url"),
].join(":");
const TELEGRAM_CHAT_ID = "9001";
const TELEGRAM_OPERATOR_ID = "7001";

for (const value of [
  DAEMON_TOKEN,
  TELEGRAM_TOKEN,
  TELEGRAM_CHAT_ID,
  TELEGRAM_OPERATOR_ID,
  MACHINE_ID,
  MACHINE_CLIENT_ID,
  SUBSCRIBER_ID,
  BINDING_ID,
  PROJECT_ID,
  ACCOUNT_ID,
]) {
  sensitiveValues.add(value);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertEqual(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(message);
  }
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function sanitize(value, temporaryRoot) {
  let result = value;
  for (const [path, replacement] of [
    [temporaryRoot, "<isolated-hosted-proof>"],
    [root, "<checkout>"],
    [process.env.HOME ?? "", "<home>"],
  ]) {
    if (path.length > 0) {
      result = result.replaceAll(path, replacement);
    }
  }
  for (const sensitive of sensitiveValues) {
    if (sensitive.length > 0) {
      result = result.replaceAll(sensitive, "<redacted>");
    }
  }
  return result;
}

function childIsRunning(child) {
  return child.exitCode === null && child.signalCode === null;
}

async function run(
  executable,
  args,
  {
    cwd = root,
    env = process.env,
    input,
    timeoutMs = 180_000,
    temporaryRoot = "",
  } = {},
) {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, {
      cwd,
      env,
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout = `${stdout}${String(chunk)}`.slice(-512_000);
    });
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${String(chunk)}`.slice(-512_000);
    });
    if (input !== undefined) {
      child.stdin.end(input);
    }
    let hardKillTimer;
    let timeoutError;
    const timer = setTimeout(() => {
      timeoutError = new Error(
        sanitize(
          `${executable} ${args.join(" ")} exceeded ${String(timeoutMs)}ms`,
          temporaryRoot,
        ),
      );
      if (childIsRunning(child)) {
        child.kill("SIGTERM");
        hardKillTimer = setTimeout(() => {
          if (childIsRunning(child)) {
            child.kill("SIGKILL");
          }
        }, 1_000);
      }
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      clearTimeout(hardKillTimer);
      reject(new Error(sanitize(error.message, temporaryRoot)));
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      clearTimeout(hardKillTimer);
      if (timeoutError !== undefined) {
        reject(timeoutError);
        return;
      }
      if (code !== 0) {
        reject(
          new Error(
            sanitize(
              [
                `${executable} ${args.join(" ")} failed (${String(code ?? signal)})`,
                stdout,
                stderr,
              ]
                .filter((part) => part.length > 0)
                .join("\n"),
              temporaryRoot,
            ),
          ),
        );
        return;
      }
      resolvePromise({ code, signal, stdout, stderr });
    });
  });
}

function parseJson(value, label) {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`${label} did not return one JSON document`, {
      cause: error,
    });
  }
}

function assertAbsent(value, forbidden, label) {
  for (const [index, candidate] of forbidden.entries()) {
    if (candidate.length > 0 && value.includes(candidate)) {
      throw new Error(
        `${label} disclosed private proof data at check ${String(index + 1)}`,
      );
    }
  }
}

function safeRuntimeEnvironment({
  home,
  prefix,
  stateDirectory,
  daemonUrl,
  extra = {},
}) {
  return {
    HOME: home,
    PATH: `${resolve(prefix, "node_modules/.bin")}${delimiter}${process.env.PATH ?? ""}`,
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
    LANG: process.env.LANG ?? "C.UTF-8",
    AGENT_RELAY_STATE_DIR: stateDirectory,
    AGENT_RELAY_DAEMON_TOKEN: DAEMON_TOKEN,
    AGENT_RELAY_WEB_ENABLED: "0",
    AGENT_RELAY_COALESCE_WINDOW_MS: "0",
    ...(daemonUrl === undefined ? {} : { AGENT_RELAY_DAEMON_URL: daemonUrl }),
    ...extra,
  };
}

async function waitFor(label, check, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value !== undefined && value !== false) {
        return value;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new Error(`${label} did not complete within ${String(timeoutMs)}ms`, {
    cause: lastError,
  });
}

async function daemonRequest(baseUrl, path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      authorization: `Bearer ${DAEMON_TOKEN}`,
      ...(options.body === undefined
        ? {}
        : { "content-type": "application/json" }),
      ...options.headers,
    },
  });
  const body = await response.json().catch(() => undefined);
  if (!response.ok) {
    throw new Error(
      `packed daemon request ${path} failed with status ${String(response.status)}`,
    );
  }
  return body;
}

async function allocatePort() {
  const server = createServer();
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  assert(
    address !== null && typeof address !== "string",
    "could not allocate a loopback port",
  );
  await new Promise((resolvePromise, reject) => {
    server.close((error) => {
      if (error === undefined) {
        resolvePromise();
      } else {
        reject(error);
      }
    });
  });
  return address.port;
}

function startDaemon(binary, port, cwd, env, temporaryRoot) {
  const child = spawn(binary, ["daemon", "--port", String(port)], {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const capture = (chunk) => {
    output = `${output}${String(chunk)}`.slice(-512_000);
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  const baseUrl = `http://127.0.0.1:${String(port)}`;

  const exited = new Promise((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      resolvePromise({ code, signal });
    });
  });

  return {
    baseUrl,
    child,
    exited,
    output: () => output,
    async ready() {
      return await waitFor("packed daemon health", async () => {
        if (!childIsRunning(child)) {
          throw new Error(
            `packed daemon exited early: ${sanitize(output, temporaryRoot)}`,
          );
        }
        const status = await daemonRequest(baseUrl, "/v1/status");
        return status?.healthy === true ? status : undefined;
      });
    },
    async stop(signal = "SIGTERM") {
      const wasRunning = childIsRunning(child);
      if (wasRunning) {
        child.kill(signal);
      }
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("packed daemon did not stop in time")),
          10_000,
        );
      });
      const result = await Promise.race([exited, timeout]).finally(() => {
        clearTimeout(timer);
      });
      if (
        signal === "SIGKILL" &&
        (!wasRunning || result.signal !== "SIGKILL")
      ) {
        throw new Error("packed daemon crash simulation was not a SIGKILL");
      }
      if (
        signal === "SIGTERM" &&
        result.code !== 0 &&
        result.signal !== "SIGTERM"
      ) {
        throw new Error(
          `packed daemon stopped unexpectedly: ${sanitize(output, temporaryRoot)}`,
        );
      }
      return result;
    },
  };
}

async function readIncomingBody(request, maximumBytes = 1024 * 1024) {
  if (request.method === "GET" || request.method === "HEAD") {
    return undefined;
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.byteLength;
    if (length > maximumBytes) {
      throw new Error("loopback mock request exceeded its proof bound");
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

function nodeRequestHeaders(request) {
  const headers = new Headers();
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index];
    const value = request.rawHeaders[index + 1];
    if (name !== undefined && value !== undefined) {
      headers.append(name, value);
    }
  }
  return headers;
}

async function loadWhooshBangEvidenceModules() {
  const requireFromRelay = createRequire(
    resolve(root, "apps/relay/package.json"),
  );
  const requireFromTransport = createRequire(
    resolve(root, "packages/whooshbang-transport/package.json"),
  );
  const mockEntry = requireFromRelay.resolve("@whooshbang/contract-mock");
  const contractsEntry = requireFromTransport.resolve("@whooshbang/contracts");
  const mockModule = await import(pathToFileURL(mockEntry).href);
  const contractsModule = await import(pathToFileURL(contractsEntry).href);
  return {
    CONTRACT_MOCK_FIXTURE_CREDENTIALS:
      mockModule.CONTRACT_MOCK_FIXTURE_CREDENTIALS,
    createWhooshBangContractMock: mockModule.createWhooshBangContractMock,
    verifyMachineCredentialToken: contractsModule.verifyMachineCredentialToken,
  };
}

async function startAdaptiveWhooshBangMock(modules) {
  const counters = new Map();
  const clock = { now: () => new Date() };
  const idGenerator = (kind) => {
    if (kind === "machine_client") {
      return MACHINE_CLIENT_ID;
    }
    if (kind === "binding") {
      return BINDING_ID;
    }
    const next = (counters.get(kind) ?? 0) + 1;
    counters.set(kind, next);
    return `${kind}_packed_${String(next).padStart(3, "0")}`;
  };
  let mock = modules.createWhooshBangContractMock({
    clock,
    idGenerator,
    scenario: "nominal",
  });
  let registration;
  let narrowBearer;
  let adapted = false;
  let blockAcknowledgements = false;
  let droppedAcknowledgements = 0;
  let serverFailure;
  const deliveredBodies = [];
  const ackWaiters = [];

  const maybeAdaptCredential = async (headers) => {
    const authorization = headers.get("authorization");
    const match = /^Bearer (.+)$/u.exec(authorization ?? "");
    const bearer = match?.[1];
    if (
      bearer === undefined ||
      bearer === modules.CONTRACT_MOCK_FIXTURE_CREDENTIALS.projectTest ||
      adapted ||
      registration === undefined
    ) {
      return;
    }
    sensitiveValues.add(bearer);
    const verified = await modules.verifyMachineCredentialToken(bearer, {
      credentialId: registration.credentialId,
      secretSha256: registration.secretSha256,
    });
    if (!verified) {
      return;
    }
    assertEqual(
      registration.machineClientId,
      MACHINE_CLIENT_ID,
      "packed setup registered an unexpected machine client",
    );
    narrowBearer = bearer;
    sensitiveValues.add(bearer);
    mock = modules.createWhooshBangContractMock({
      clock,
      idGenerator,
      scenario: "nominal",
      credentials: [
        {
          accountId: ACCOUNT_ID,
          environment: "test",
          kind: "project",
          projectId: PROJECT_ID,
          scopes: [
            "subscriptions:write",
            "subscriptions:read",
            "messages:write",
            "messages:read",
            "machine-clients:write",
            "machine-clients:read",
            "capabilities:read",
          ],
          token: modules.CONTRACT_MOCK_FIXTURE_CREDENTIALS.projectTest,
        },
        {
          accountId: ACCOUNT_ID,
          bindingId: BINDING_ID,
          credentialId: registration.credentialId,
          environment: "test",
          kind: "machine",
          machineClientId: MACHINE_CLIENT_ID,
          machineId: MACHINE_ID,
          notifierId: NOTIFIER_ID,
          projectId: PROJECT_ID,
          scopes: [
            "machine-messages:write",
            "machine-messages:read",
            "machine-events:read",
            "machine-events:ack",
          ],
          status: "active",
          subscriberId: SUBSCRIBER_ID,
          token: bearer,
        },
      ],
    });
    adapted = true;
  };

  const server = createServer((incoming, outgoing) => {
    void (async () => {
      try {
        const body = await readIncomingBody(incoming);
        const headers = nodeRequestHeaders(incoming);
        const url = new URL(
          incoming.url ?? "/",
          `http://${incoming.headers.host ?? "127.0.0.1"}`,
        );
        const registrationMatch =
          /^\/v1\/machine-clients\/([^/]+)\/credentials$/u.exec(url.pathname);
        let registrationCandidate;
        if (
          incoming.method === "POST" &&
          url.pathname === "/v1/messages" &&
          body !== undefined
        ) {
          const value = JSON.parse(body.toString("utf8"));
          if (
            value.content?.type === "text" &&
            typeof value.content.text === "string"
          ) {
            deliveredBodies.push(value.content.text);
          }
        }
        if (
          incoming.method === "POST" &&
          registrationMatch !== null &&
          body !== undefined
        ) {
          const value = JSON.parse(body.toString("utf8"));
          registrationCandidate = {
            credentialId: value.credential_id,
            machineClientId: decodeURIComponent(registrationMatch[1]),
            secretSha256: value.secret_sha256,
          };
        }

        await maybeAdaptCredential(headers);
        if (
          incoming.method === "POST" &&
          /^\/v1\/machine-events\/[^/]+\/ack$/u.test(url.pathname) &&
          blockAcknowledgements
        ) {
          droppedAcknowledgements += 1;
          for (const resolvePromise of ackWaiters.splice(0)) {
            resolvePromise(droppedAcknowledgements);
          }
          outgoing.destroy();
          return;
        }

        const request = new Request(url, {
          method: incoming.method ?? "GET",
          headers,
          ...(body === undefined ? {} : { body }),
        });
        const response = await mock.fetch(request);
        if (
          registrationCandidate !== undefined &&
          response.status >= 200 &&
          response.status < 300
        ) {
          registration = registrationCandidate;
        }
        if (
          incoming.method === "GET" &&
          url.pathname === "/v1/machine-events"
        ) {
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
        }
        outgoing.statusCode = response.status;
        response.headers.forEach((value, name) => {
          outgoing.setHeader(name, value);
        });
        outgoing.end(new Uint8Array(await response.arrayBuffer()));
      } catch (error) {
        serverFailure = error;
        if (!outgoing.destroyed) {
          outgoing.statusCode = 500;
          outgoing.setHeader("content-type", "application/json");
          outgoing.end(
            JSON.stringify({
              error: "adaptive loopback mock failed safely",
            }),
          );
        }
      }
    })();
  });
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  assert(
    address !== null && typeof address !== "string",
    "adaptive loopback mock did not bind",
  );

  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    blockAcks() {
      blockAcknowledgements = true;
    },
    allowAcks() {
      blockAcknowledgements = false;
    },
    close: async () =>
      await new Promise((resolvePromise, reject) => {
        server.close((error) => {
          if (error === undefined) {
            resolvePromise();
          } else {
            reject(error);
          }
        });
        server.closeAllConnections();
      }),
    inspect: () => mock.inspect(),
    deliveredBodies: () => [...deliveredBodies],
    narrowBearer: () => narrowBearer,
    registration: () => registration,
    assertHealthy() {
      if (serverFailure !== undefined) {
        throw new Error("adaptive loopback mock recorded an internal failure", {
          cause: serverFailure,
        });
      }
      assert(adapted, "packed setup never proved its generated narrow bearer");
      assert(
        narrowBearer !== undefined,
        "packed setup did not establish a narrow bearer",
      );
    },
    submitInteraction: async (input) =>
      await mock.control.submitInteraction(input),
    waitForDroppedAck: async () => {
      if (droppedAcknowledgements > 0) {
        return droppedAcknowledgements;
      }
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                "packed hosted acknowledgement was not dropped within 15s",
              ),
            ),
          15_000,
        );
      });
      const dropped = new Promise((resolvePromise) => {
        ackWaiters.push(resolvePromise);
      });
      return await Promise.race([dropped, timeout]).finally(() => {
        clearTimeout(timer);
      });
    },
  };
}

function proofEvent(kind, index, privateValues) {
  const now = new Date();
  const suffix = `${kind}_${String(index).padStart(2, "0")}`;
  const correlationId = `request_packed_hosted_${suffix}_12345678`;
  const eventId = `event_packed_hosted_${suffix}_12345678`;
  const question = `${privateValues.promptPrefix} ${kind} ${String(index)}`;
  const request =
    kind === "select"
      ? {
          correlationId,
          kind,
          question,
          options: [
            { id: "option_packed_alpha_12345678", label: "Alpha" },
            { id: "option_packed_beta_12345678", label: "Beta" },
          ],
          expiresAt: new Date(now.getTime() + 60 * 60_000).toISOString(),
        }
      : {
          correlationId,
          kind,
          question,
          expiresAt: new Date(now.getTime() + 60 * 60_000).toISOString(),
        };
  return {
    event: {
      schema: "agent-attention.v1",
      eventId,
      occurredAt: now.toISOString(),
      sequence: index,
      machineId: MACHINE_ID,
      bridgeSessionId: `bridge_packed_hosted_${suffix}_12345678`,
      harness: "codex",
      surface: "cli",
      harnessVersion: "packed-proof",
      sessionId: `session_packed_hosted_${suffix}_12345678`,
      turnId: `turn_packed_hosted_${suffix}_12345678`,
      project: {
        displayName: "packed-hosted-proof",
        cwdHash: `sha256:${"a".repeat(64)}`,
      },
      type: "input.required",
      summary:
        `${"bounded private summary excerpt ".repeat(55)}` +
        privateValues.hiddenTail,
      lastAssistantMessage: `Bounded packed hosted ${kind} proof`,
      request,
      capabilities: {
        inlineContinue: true,
        lateResume: true,
        activeSteer: false,
        permissionDecision: true,
      },
    },
    correlationId,
    eventId,
  };
}

async function ingestAndDeliver(baseUrl, event, mock) {
  const before = mock.inspect().messages.length;
  const ingest = await daemonRequest(baseUrl, "/v1/events", {
    method: "POST",
    body: JSON.stringify(event),
  });
  assert(ingest.inserted === true, "packed hosted event was not inserted");
  const drain = await daemonRequest(baseUrl, "/v1/deliveries/drain", {
    method: "POST",
    body: JSON.stringify({ limit: 50 }),
  });
  const failedStatus =
    drain.retrying === 0 && drain.deadLettered === 0
      ? undefined
      : await daemonRequest(baseUrl, "/v1/status");
  assert(
    drain.retrying === 0 && drain.deadLettered === 0,
    `packed hosted delivery did not complete cleanly: ${JSON.stringify({
      claimed: drain.claimed,
      delivered: drain.delivered,
      retrying: drain.retrying,
      deadLettered: drain.deadLettered,
      errorCode:
        failedStatus?.transportRuntime?.whooshbang?.delivery?.lastError?.code,
    })}`,
  );
  const request = await waitFor("packed hosted delivery receipt", async () => {
    const result = await daemonRequest(
      baseUrl,
      `/v1/requests/${encodeURIComponent(event.request.correlationId)}`,
    );
    return result.request?.transportMessageId === undefined
      ? undefined
      : result.request;
  });
  assert(
    mock.inspect().messages.length === before + 1,
    "packed hosted delivery did not create one logical message",
  );
  return request;
}

async function waitForAnswered(baseUrl, correlationId, expectedAnswer) {
  return await waitFor("packed hosted local answer", async () => {
    const result = await daemonRequest(
      baseUrl,
      `/v1/requests/${encodeURIComponent(correlationId)}`,
    );
    const request = result.request;
    if (request?.state !== "answered") {
      return undefined;
    }
    assertEqual(
      request.answer,
      expectedAnswer,
      "packed hosted answer differs from the local request",
    );
    assertEqual(
      request.resolvedBy,
      "whooshbang",
      "packed hosted answer has the wrong local authority",
    );
    return request;
  });
}

function telegramPreloadSource() {
  return `
const originalFetch = globalThis.fetch.bind(globalThis);
let nextMessageId = 100;
let nextTopicId = 1000;
let nextUpdateId = 1;
const updates = [];
let scopedCommands = [];
const reply = ["relay", "canary", "ok"].join("-");
const json = (value) => new Response(JSON.stringify(value), {
  headers: { "content-type": "application/json" },
});
globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  if (!url.startsWith("https://api.telegram.org/")) {
    return await originalFetch(input, init);
  }
  const method = new URL(url).pathname.split("/").at(-1);
  const body = typeof init.body === "string" ? JSON.parse(init.body) : {};
  if (method === "getMe") {
    return json({ ok: true, result: {
      id: 10002, is_bot: true, has_topics_enabled: true,
    } });
  }
  if (method === "getChat") {
    return json({ ok: true, result: { id: 9001, type: "private" } });
  }
  if (method === "getWebhookInfo") {
    return json({ ok: true, result: { url: "", pending_update_count: 0 } });
  }
  if (method === "setMyCommands") {
    if (
      body.scope?.type !== "chat" ||
      String(body.scope.chat_id) !== "9001" ||
      !Array.isArray(body.commands)
    ) {
      throw new Error("invalid synthetic Telegram command registration");
    }
    scopedCommands = body.commands;
    return json({ ok: true, result: true });
  }
  if (method === "getMyCommands") {
    if (
      body.scope?.type !== "chat" ||
      String(body.scope.chat_id) !== "9001"
    ) {
      throw new Error("invalid synthetic Telegram command verification");
    }
    return json({ ok: true, result: scopedCommands });
  }
  if (method === "createForumTopic") {
    const topicId = nextTopicId++;
    return json({ ok: true, result: {
      message_thread_id: topicId,
      name: typeof body.name === "string" ? body.name : "topic",
    } });
  }
  if (method === "sendMessage") {
    const messageId = nextMessageId++;
    updates.push({
      update_id: nextUpdateId++,
      message: {
        message_id: nextMessageId++,
        message_thread_id: body.message_thread_id,
        from: { id: 7001 },
        chat: { id: 9001, type: "private" },
        text: reply,
        reply_to_message: { message_id: messageId },
      },
    });
    return json({ ok: true, result: { message_id: messageId, date: 0 } });
  }
  if (method === "getUpdates") {
    if (updates.length === 0) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    }
    if (init.signal?.aborted) {
      throw new DOMException("aborted", "AbortError");
    }
    return json({ ok: true, result: updates.splice(0) });
  }
  if (method === "editMessageText") {
    return json({ ok: true, result: {
      message_id: typeof body.message_id === "number" ? body.message_id : 0,
    } });
  }
  if (method === "answerCallbackQuery") {
    return json({ ok: true, result: true });
  }
  throw new Error("unexpected synthetic Telegram method");
};
`;
}

await run(
  process.execPath,
  [resolve(root, "contracts/scripts/verify-whooshbang.mjs")],
  { timeoutMs: 30_000 },
);

if (process.platform !== "darwin") {
  process.stdout.write(
    `Packed hosted runtime proof skipped on unsupported ${process.platform}/${process.arch}; exact WhooshBang artifact preflight passed and package:check remains mandatory.\n`,
  );
  process.exitCode = 0;
} else {
  const temporaryRoot = await mkdtemp(
    resolve(tmpdir(), "agent-relay-hosted-package-"),
  );
  let hostedDaemon;
  let recoveryDaemon;
  let fakeDaemon;
  let telegramDaemon;
  let whooshbangMock;
  const daemonOutputs = [];
  try {
    const tarball = resolve(temporaryRoot, "agent-relay.tgz");
    await run("pnpm", ["pack", "--out", tarball], {
      temporaryRoot,
      timeoutMs: 180_000,
    });
    const packageSha256 = createHash("sha256")
      .update(await readFile(tarball))
      .digest("hex");
    const prefix = resolve(temporaryRoot, "consumer");
    const isolatedHome = resolve(temporaryRoot, "home");
    const stateDirectory = resolve(isolatedHome, ".agent-relay");
    await mkdir(prefix, { recursive: true });
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    await writeFile(
      resolve(prefix, "package.json"),
      `${JSON.stringify({ name: "hosted-package-proof", private: true })}\n`,
      "utf8",
    );
    await run(
      "pnpm",
      ["--dir", prefix, "add", "--ignore-scripts", "--offline", tarball],
      { temporaryRoot },
    );
    await run("pnpm", ["--dir", prefix, "rebuild", "better-sqlite3"], {
      temporaryRoot,
    });

    const installedPackage = resolve(
      prefix,
      "node_modules/@flowxo/agent-relay",
    );
    const installedRealPath = await realpath(installedPackage);
    const prefixRealPath = await realpath(prefix);
    const rootRealPath = await realpath(root);
    assert(
      installedRealPath.startsWith(`${prefixRealPath}/`) &&
        !installedRealPath.startsWith(`${rootRealPath}/`),
      "packed hosted proof resolved to a workspace or sibling checkout",
    );
    const binary = resolve(prefix, "node_modules/.bin/agent-relay");
    const installedManifest = parseJson(
      await readFile(resolve(installedPackage, "package.json"), "utf8"),
      "installed package manifest",
    );
    assertEqual(
      installedManifest.version,
      release.version,
      "installed hosted package version differs from the release candidate",
    );
    const cliSource = await readFile(
      resolve(installedPackage, "dist/cli.js"),
      "utf8",
    );
    assert(
      cliSource.includes("1.0.0-rc.4") &&
        cliSource.includes("whooshbang connect") &&
        !cliSource.includes("@whooshbang/contract-mock"),
      "packed CLI omitted the hosted adapter or bundled the test-only mock",
    );

    const help = await run(binary, ["whooshbang", "--help"], {
      env: safeRuntimeEnvironment({
        home: isolatedHome,
        prefix,
        stateDirectory,
      }),
      temporaryRoot,
    });
    assert(
      help.stdout.includes("whooshbang connect") &&
        help.stdout.includes("whooshbang disconnect"),
      "packed WhooshBang command surface is incomplete",
    );

    const modules = await loadWhooshBangEvidenceModules();
    sensitiveValues.add(modules.CONTRACT_MOCK_FIXTURE_CREDENTIALS.projectTest);
    whooshbangMock = await startAdaptiveWhooshBangMock(modules);
    await writeFile(resolve(stateDirectory, "machine-id"), `${MACHINE_ID}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await chmod(resolve(stateDirectory, "machine-id"), 0o600);
    const commandEnvironment = safeRuntimeEnvironment({
      home: isolatedHome,
      prefix,
      stateDirectory,
    });
    const connect = await run(
      binary,
      [
        "whooshbang",
        "connect",
        "--credential-stdin",
        "--base-url",
        whooshbangMock.baseUrl,
        "--subscriber-id",
        SUBSCRIBER_ID,
        "--notifier-id",
        NOTIFIER_ID,
        "--wait-seconds",
        "0",
      ],
      {
        env: commandEnvironment,
        input: `${modules.CONTRACT_MOCK_FIXTURE_CREDENTIALS.projectTest}\n`,
        temporaryRoot,
      },
    );
    const connected = parseJson(connect.stdout, "packed hosted connect");
    assert(
      connected.status === "connected" &&
        connected.configured === true &&
        connected.credentialPresent === true &&
        connected.canary === "accepted",
      "packed hosted setup did not prove a narrow connection",
    );
    whooshbangMock.assertHealthy();
    const registration = whooshbangMock.registration();
    assert(
      registration !== undefined &&
        /^sha256:[a-f0-9]{64}$/u.test(registration.secretSha256),
      "packed setup did not register an exact credential digest",
    );
    sensitiveValues.add(registration.secretSha256);
    const narrowBearer = whooshbangMock.narrowBearer();
    assert(
      narrowBearer !== undefined,
      "packed hosted setup did not retain its generated narrow credential",
    );
    sensitiveValues.add(registration.credentialId);
    assertAbsent(
      `${connect.stdout}\n${connect.stderr}`,
      [
        modules.CONTRACT_MOCK_FIXTURE_CREDENTIALS.projectTest,
        narrowBearer,
        SUBSCRIBER_ID,
        MACHINE_CLIENT_ID,
        BINDING_ID,
      ],
      "packed hosted setup output",
    );
    const credentialPath = resolve(
      stateDirectory,
      "whooshbang-credential.json",
    );
    const configurationPath = resolve(stateDirectory, "whooshbang.json");
    const credentialMetadata = await stat(credentialPath);
    const configurationMetadata = await stat(configurationPath);
    assert(
      (credentialMetadata.mode & 0o077) === 0 &&
        (configurationMetadata.mode & 0o077) === 0,
      "packed hosted setup files are not private",
    );
    const credentialFile = await readFile(credentialPath, "utf8");
    const configurationFile = await readFile(configurationPath, "utf8");
    assert(
      credentialFile.includes(narrowBearer) &&
        !credentialFile.includes(
          modules.CONTRACT_MOCK_FIXTURE_CREDENTIALS.projectTest,
        ) &&
        !configurationFile.includes(narrowBearer),
      "packed hosted credential lifecycle crossed its storage boundary",
    );

    const selected = parseJson(
      (
        await run(binary, ["transport", "select", "whooshbang"], {
          env: commandEnvironment,
          temporaryRoot,
        })
      ).stdout,
      "packed hosted transport selection",
    );
    assert(
      selected.selectedTransport === "whooshbang" &&
        selected.durableSelection === "whooshbang" &&
        selected.transports?.whooshbang?.ready === true,
      "packed hosted transport selection is not ready",
    );

    const hiddenValues = [
      `PRIVATE_TRANSCRIPT_${randomBytes(10).toString("hex")}`,
      `/synthetic/private/worktree/${randomBytes(8).toString("hex")}`,
      `PRIVATE_EXECUTABLE_${randomBytes(10).toString("hex")}`,
    ];
    const privateValues = {
      promptPrefix: `PRIVATE_PROMPT_${randomBytes(10).toString("hex")}`,
      answer: `PRIVATE_ANSWER_${randomBytes(10).toString("hex")}`,
      hiddenValues,
      hiddenTail: hiddenValues.join(" "),
    };
    for (const value of [
      privateValues.promptPrefix,
      privateValues.answer,
      ...privateValues.hiddenValues,
    ]) {
      sensitiveValues.add(value);
    }
    const hostedPort = await allocatePort();
    const hostedEnvironment = safeRuntimeEnvironment({
      home: isolatedHome,
      prefix,
      stateDirectory,
    });
    hostedDaemon = startDaemon(
      binary,
      hostedPort,
      isolatedHome,
      hostedEnvironment,
      temporaryRoot,
    );
    const hostedStatus = await hostedDaemon.ready();
    assert(
      hostedStatus.selectedTransport === "whooshbang" &&
        hostedStatus.transport === "whooshbang",
      "packed daemon did not start with the selected hosted transport",
    );

    const confirm = proofEvent("confirm", 1, privateValues);
    const confirmRequest = await ingestAndDeliver(
      hostedDaemon.baseUrl,
      confirm.event,
      whooshbangMock,
    );
    const confirmBody = whooshbangMock.deliveredBodies().at(-1);
    const hiddenValuesAbsent =
      confirmBody !== undefined &&
      privateValues.hiddenValues.every((value) => !confirmBody.includes(value));
    assert(
      confirmBody !== undefined &&
        hiddenValuesAbsent &&
        confirmBody.includes("truncated"),
      `packed hosted delivery did not enforce its private text bound: ${JSON.stringify(
        {
          bodyPresent: confirmBody !== undefined,
          hiddenValuesAbsent,
          truncationMarkerPresent: confirmBody?.includes("truncated") ?? false,
          bodyLength: confirmBody?.length ?? 0,
        },
      )}`,
    );
    const confirmCommits = whooshbangMock.inspect().cursorCommits.length;
    const confirmSubmitted = await whooshbangMock.submitInteraction({
      messageId: confirmRequest.transportMessageId,
      response: { type: "confirm", value: true },
    });
    assert(
      confirmSubmitted.eventCreated === true,
      "packed confirm interaction did not create an exact hosted event",
    );
    await waitForAnswered(
      hostedDaemon.baseUrl,
      confirm.correlationId,
      "yes_option",
    );
    await waitFor("packed confirm acknowledgement", async () =>
      whooshbangMock.inspect().cursorCommits.length === confirmCommits + 1
        ? true
        : undefined,
    );

    const select = proofEvent("select", 2, privateValues);
    const selectRequest = await ingestAndDeliver(
      hostedDaemon.baseUrl,
      select.event,
      whooshbangMock,
    );
    const beta = selectRequest.options.find(
      (option) => option.optionId === "option_packed_beta_12345678",
    );
    assert(beta !== undefined, "packed hosted select token is unavailable");
    const beforeCrashCommits = whooshbangMock.inspect().cursorCommits.length;
    whooshbangMock.blockAcks();
    const selectSubmitted = await whooshbangMock.submitInteraction({
      messageId: selectRequest.transportMessageId,
      response: { type: "select", value: beta.token },
    });
    assert(
      selectSubmitted.eventCreated === true,
      "packed select interaction did not create an exact hosted event",
    );
    await whooshbangMock.waitForDroppedAck();
    await waitForAnswered(
      hostedDaemon.baseUrl,
      select.correlationId,
      "option_packed_beta_12345678",
    );
    assertEqual(
      whooshbangMock.inspect().cursorCommits.length,
      beforeCrashCommits,
      "provider acknowledgement committed before the simulated crash",
    );
    await hostedDaemon.stop("SIGKILL");
    daemonOutputs.push(hostedDaemon.output());
    hostedDaemon = undefined;

    whooshbangMock.allowAcks();
    const recoveryPort = await allocatePort();
    recoveryDaemon = startDaemon(
      binary,
      recoveryPort,
      isolatedHome,
      hostedEnvironment,
      temporaryRoot,
    );
    await recoveryDaemon.ready();
    await waitFor("packed crash-before-ack replay", async () =>
      whooshbangMock.inspect().cursorCommits.length === beforeCrashCommits + 1
        ? true
        : undefined,
    );
    await waitForAnswered(
      recoveryDaemon.baseUrl,
      select.correlationId,
      "option_packed_beta_12345678",
    );

    const input = proofEvent("input", 3, privateValues);
    const inputRequest = await ingestAndDeliver(
      recoveryDaemon.baseUrl,
      input.event,
      whooshbangMock,
    );
    const beforeInputCommits = whooshbangMock.inspect().cursorCommits.length;
    const inputSubmitted = await whooshbangMock.submitInteraction({
      messageId: inputRequest.transportMessageId,
      response: { type: "input", value: privateValues.answer },
    });
    assert(
      inputSubmitted.eventCreated === true,
      "packed input interaction did not create an exact hosted event",
    );
    await waitForAnswered(
      recoveryDaemon.baseUrl,
      input.correlationId,
      privateValues.answer,
    );
    await waitFor("packed input acknowledgement", async () =>
      whooshbangMock.inspect().cursorCommits.length === beforeInputCommits + 1
        ? true
        : undefined,
    );
    assertEqual(
      whooshbangMock.inspect().cursorCommits.length,
      confirmCommits + 3,
      "packed hosted proof observed a duplicate provider cursor commit",
    );
    const finalHostedStatus = await waitFor(
      "packed hosted presentation diagnosis",
      async () => {
        const status = await daemonRequest(
          recoveryDaemon.baseUrl,
          "/v1/status",
        );
        return status.transportRuntime?.whooshbang?.presentation?.blocked === 3
          ? status
          : undefined;
      },
    );
    assert(
      finalHostedStatus.transportRuntime.whooshbang.presentation.capability ===
        "unsupported" &&
        finalHostedStatus.transportRuntime.whooshbang.presentation.updated ===
          0 &&
        finalHostedStatus.transportRuntime.whooshbang.polling
          .unacknowledgedEventCount === 0,
      "packed hosted presentation or acknowledgement diagnosis is unsafe",
    );
    const rawCursor = whooshbangMock
      .inspect()
      .cursorCommits.at(-1)?.committedCursor;
    const hostedMessageIds = whooshbangMock
      .inspect()
      .messages.map((message) => message.id);
    const hostedEventIds = whooshbangMock
      .inspect()
      .logicalEvents.map((event) => event.eventId);
    for (const value of [
      ...(rawCursor === undefined ? [] : [rawCursor]),
      ...hostedMessageIds,
      ...hostedEventIds,
    ]) {
      sensitiveValues.add(value);
    }
    assertAbsent(
      JSON.stringify(finalHostedStatus),
      [
        narrowBearer,
        SUBSCRIBER_ID,
        MACHINE_CLIENT_ID,
        BINDING_ID,
        privateValues.promptPrefix,
        privateValues.answer,
        ...privateValues.hiddenValues,
        rawCursor ?? "",
        ...hostedMessageIds,
      ],
      "packed hosted status",
    );
    await recoveryDaemon.stop();
    daemonOutputs.push(recoveryDaemon.output());
    recoveryDaemon = undefined;

    const disconnected = parseJson(
      (
        await run(
          binary,
          [
            "whooshbang",
            "disconnect",
            "--revoke",
            "--erase-credential",
            "--erase-configuration",
            "--credential-stdin",
          ],
          {
            env: commandEnvironment,
            input: `${modules.CONTRACT_MOCK_FIXTURE_CREDENTIALS.projectTest}\n`,
            temporaryRoot,
          },
        )
      ).stdout,
      "packed hosted disconnect",
    );
    assertEqual(
      disconnected,
      {
        configured: false,
        localConfigurationErased: true,
        localCredentialErased: true,
        remoteRevocationProven: true,
        status: "revoked",
      },
      "packed hosted disconnect did not revoke and erase explicitly",
    );
    assert(
      !(await exists(credentialPath)) &&
        !(await exists(configurationPath)) &&
        whooshbangMock
          .inspect()
          .machineClients.find(
            (candidate) => candidate.id === MACHINE_CLIENT_ID,
          )?.status === "revoked",
      "packed hosted disconnect left active connection material",
    );

    const fakePort = await allocatePort();
    fakeDaemon = startDaemon(
      binary,
      fakePort,
      isolatedHome,
      safeRuntimeEnvironment({
        home: isolatedHome,
        prefix,
        stateDirectory,
        extra: { AGENT_RELAY_TRANSPORT: "fake" },
      }),
      temporaryRoot,
    );
    await fakeDaemon.ready();
    for (const [correlationId, expectedAnswer] of [
      [confirm.correlationId, "yes_option"],
      [select.correlationId, "option_packed_beta_12345678"],
      [input.correlationId, privateValues.answer],
    ]) {
      const retained = await daemonRequest(
        fakeDaemon.baseUrl,
        `/v1/requests/${encodeURIComponent(correlationId)}`,
      );
      assert(
        retained.request?.state === "answered" &&
          retained.request.answer === expectedAnswer,
        "transport disconnect changed retained local authority",
      );
    }
    await fakeDaemon.stop();
    daemonOutputs.push(fakeDaemon.output());
    fakeDaemon = undefined;

    const telegramEnvironment = safeRuntimeEnvironment({
      home: isolatedHome,
      prefix,
      stateDirectory,
      extra: {
        AGENT_RELAY_TELEGRAM_TOKEN: TELEGRAM_TOKEN,
        AGENT_RELAY_TELEGRAM_CHAT_ID: TELEGRAM_CHAT_ID,
        AGENT_RELAY_TELEGRAM_OPERATOR_ID: TELEGRAM_OPERATOR_ID,
        AGENT_RELAY_TELEGRAM_UPDATE_MODE: "poll",
      },
    });
    const telegramSelection = parseJson(
      (
        await run(binary, ["transport", "select", "telegram"], {
          env: telegramEnvironment,
          temporaryRoot,
        })
      ).stdout,
      "packed Telegram selection",
    );
    assert(
      telegramSelection.selectedTransport === "telegram" &&
        telegramSelection.transports?.telegram?.ready === true,
      "packed direct Telegram selection is not ready",
    );
    const telegramPreload = resolve(temporaryRoot, "telegram-preload.mjs");
    await writeFile(telegramPreload, telegramPreloadSource(), "utf8");
    const telegramPort = await allocatePort();
    const telegramDaemonEnvironment = {
      ...telegramEnvironment,
      NODE_OPTIONS: `--import=${telegramPreload}`,
    };
    telegramDaemon = startDaemon(
      binary,
      telegramPort,
      isolatedHome,
      telegramDaemonEnvironment,
      temporaryRoot,
    );
    const directStatus = await telegramDaemon.ready();
    assert(
      directStatus.selectedTransport === "telegram" &&
        directStatus.transport === "telegram",
      "packed daemon did not start the direct Telegram transport",
    );
    const directCanary = parseJson(
      (
        await run(
          binary,
          ["telegram-canary", "--wait-ms", "10000", "--poll-interval-ms", "50"],
          {
            env: safeRuntimeEnvironment({
              home: isolatedHome,
              prefix,
              stateDirectory,
              daemonUrl: telegramDaemon.baseUrl,
            }),
            temporaryRoot,
            timeoutMs: 30_000,
          },
        )
      ).stdout,
      "packed direct Telegram canary",
    );
    assert(
      directCanary.outcome === "answered" &&
        directCanary.resolvedBy === "telegram" &&
        directCanary.drain?.delivered === 1,
      "packed direct Telegram canary did not complete one round trip",
    );
    await telegramDaemon.stop();
    daemonOutputs.push(telegramDaemon.output());
    telegramDaemon = undefined;

    const installed = parseJson(
      (
        await run(binary, ["install", "--root", isolatedHome], {
          env: commandEnvironment,
          temporaryRoot,
        })
      ).stdout,
      "packed install",
    );
    assert(installed.changed === true, "packed install made no owned changes");
    const uninstalled = parseJson(
      (
        await run(binary, ["uninstall", "--root", isolatedHome], {
          env: commandEnvironment,
          temporaryRoot,
        })
      ).stdout,
      "packed uninstall",
    );
    assert(
      uninstalled.changed === true,
      "packed uninstall removed no owned changes",
    );
    assert(
      !(await exists(resolve(stateDirectory, "bin/agent-relay"))) &&
        !(await exists(resolve(stateDirectory, "install.json"))) &&
        (await exists(resolve(stateDirectory, "relay.sqlite"))),
      "packed uninstall removed retained state or left owned installation files",
    );

    const daemonLog = await readFile(
      resolve(stateDirectory, "relay.ndjson"),
      "utf8",
    );
    const privateLogValues = [
      modules.CONTRACT_MOCK_FIXTURE_CREDENTIALS.projectTest,
      narrowBearer,
      SUBSCRIBER_ID,
      MACHINE_CLIENT_ID,
      MACHINE_ID,
      BINDING_ID,
      PROJECT_ID,
      ACCOUNT_ID,
      registration.credentialId,
      registration.secretSha256,
      privateValues.promptPrefix,
      privateValues.answer,
      ...privateValues.hiddenValues,
      TELEGRAM_TOKEN,
      TELEGRAM_CHAT_ID,
      TELEGRAM_OPERATOR_ID,
      ...(rawCursor === undefined ? [] : [rawCursor]),
      ...hostedMessageIds,
      ...hostedEventIds,
      root,
      temporaryRoot,
    ];
    assertAbsent(
      `${daemonOutputs.join("\n")}\n${daemonLog}`,
      privateLogValues,
      "packed daemon logs",
    );
    assertAbsent(cliSource, privateLogValues, "packed package contents");
    whooshbangMock.assertHealthy();

    await run("pnpm", ["--dir", prefix, "remove", release.name], {
      temporaryRoot,
    });
    assert(
      !(await exists(binary)) && !(await exists(installedPackage)),
      "package-manager removal left the packed executable",
    );

    const notificationArtifacts = contractLock.dependencies.filter((artifact) =>
      [
        "@whooshbang/sdk",
        "@whooshbang/contracts",
        "@whooshbang/contract-mock",
      ].includes(artifact.artifact),
    );
    assert(
      notificationArtifacts.length === 3 &&
        notificationArtifacts.every(
          (artifact) =>
            artifact.version === "1.0.0-rc.4" &&
            /^[a-f0-9]{64}$/u.test(artifact.sha256) &&
            /^[a-f0-9]{40}$/u.test(artifact.source_commit),
        ),
      "packed hosted proof is not paired with exact WhooshBang pins",
    );
    const lockSha256 = createHash("sha256")
      .update(await readFile(resolve(root, "contracts/contract-lock.json")))
      .digest("hex");
    process.stdout.write(
      `${JSON.stringify({
        schema: "agent-relay-hosted-package-proof.v1",
        package: {
          name: release.name,
          version: release.version,
          sha256: packageSha256,
        },
        whooshbang: {
          contractVersion: "1.0.0-rc.4",
          contractLockSha256: lockSha256,
          exactArtifacts: notificationArtifacts.length,
          setup: "narrow-credential-proven",
          interactions: ["confirm", "select", "input"],
          crashBeforeAckReplay: "passed",
          presentation: "unsupported-safe",
          disconnect: "revoked-and-erased",
        },
        directTelegramCanary: "answered",
        retainedLocalAuthority: "passed",
        uninstall: "owned-files-removed-state-retained",
        privacyScan: "passed",
      })}\n`,
    );
  } finally {
    for (const daemon of [
      hostedDaemon,
      recoveryDaemon,
      fakeDaemon,
      telegramDaemon,
    ]) {
      if (daemon !== undefined && childIsRunning(daemon.child)) {
        daemon.child.kill("SIGTERM");
        await daemon.exited.catch(() => undefined);
      }
    }
    await whooshbangMock?.close().catch(() => undefined);
    await rm(temporaryRoot, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 50,
    });
  }
}
