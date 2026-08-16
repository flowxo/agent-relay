#!/usr/bin/env node
/**
 * FXO-1611 interactive TUI reconnect live-check against isolated web-demo.
 *
 * Starts web-demo on 127.0.0.1:4318, drives the real dashboard store through
 * kill → reconnecting → restart → press `r` → online, and retains sanitized
 * frame captures. Everyday daemon on 4317 is never touched.
 */

import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const evidenceRoot = resolve(root, ".artifacts/fxo-1611");
const capturePath = resolve(
  evidenceRoot,
  "captures/tui-reconnect-livecheck.txt",
);
const resultPath = resolve(
  evidenceRoot,
  "machine/tui-reconnect-livecheck.json",
);
const cli = resolve(root, "apps/relay/dist/cli.js");
const nativeNode = process.env.AGENT_RELAY_NATIVE_NODE ?? process.execPath;
const demoPort = 4318;
const demoUrl = `http://127.0.0.1:${demoPort}`;
const stateDirectory = resolve(process.env.HOME ?? "", ".agent-relay/web-demo");

const secretPatterns = [
  /webboot_[A-Za-z0-9_-]+/g,
  /Bearer\s+\S+/gi,
  /\/Users\/\S+/g,
  /csrf[_-]?token["'=:\s]+\S+/gi,
];

function sanitize(text) {
  let cleaned = text;
  for (const pattern of secretPatterns) {
    cleaned = cleaned.replace(pattern, "<redacted>");
  }
  cleaned = cleaned.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
  return cleaned.replaceAll("\x1b", "");
}

async function portInUse(port) {
  return await new Promise((resolvePromise) => {
    const socket = createServer()
      .once("error", () => resolvePromise(true))
      .once("listening", () => {
        socket.close(() => resolvePromise(false));
      })
      .listen(port, "127.0.0.1");
  });
}

async function waitUntil(predicate, timeoutMs, label) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return;
    await delay(50);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function stopListeners(port) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      "lsof",
      ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.on("error", reject);
    child.on("close", () => {
      const pids = stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => /^\d+$/.test(line))
        .map(Number);
      for (const pid of pids) {
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          // already gone
        }
      }
      resolvePromise(pids);
    });
  });
}

async function ensurePortFree(port) {
  await stopListeners(port);
  await waitUntil(
    async () => !(await portInUse(port)),
    10_000,
    `port ${port} free`,
  );
}

function startDemo() {
  return spawn(nativeNode, [cli, "web-demo"], {
    cwd: root,
    env: {
      ...process.env,
      PATH: `${dirname(nativeNode)}:${process.env.PATH ?? ""}`,
      AGENT_RELAY_TRANSPORT: "fake",
    },
    stdio: "ignore",
  });
}

async function waitForDemo(child) {
  await waitUntil(
    async () => {
      if (child.exitCode !== null) {
        throw new Error(`web-demo exited early with ${child.exitCode}`);
      }
      return await portInUse(demoPort);
    },
    20_000,
    "web-demo listen",
  );
  await delay(400);
}

async function main() {
  await mkdir(dirname(capturePath), { recursive: true });
  await mkdir(dirname(resultPath), { recursive: true });

  const { createDashboardClient } =
    await import("../apps/relay/dist/tui/client.js");
  const { renderDashboardFrame, containsSecret } =
    await import("../apps/relay/dist/tui/frame.js");
  const { handleDashboardKey } =
    await import("../apps/relay/dist/tui/input.js");
  const { DashboardStore } = await import("../apps/relay/dist/tui/store.js");
  const { readWebCredential } =
    await import("../apps/relay/dist/web-credential.js");

  const steps = [];
  const frames = [];
  let demo;
  let passed = false;
  let failure;

  try {
    if (!(await portInUse(4317))) {
      steps.push({
        step: "everyday-daemon-4317",
        result: "warn",
        note: "4317 was not listening; qualification continues on 4318 only",
      });
    } else {
      steps.push({
        step: "everyday-daemon-4317",
        result: "pass",
        untouched: true,
      });
    }

    await ensurePortFree(demoPort);
    demo = startDemo();
    await waitForDemo(demo);
    steps.push({ step: "start-web-demo", result: "pass", port: demoPort });

    const credential = await readWebCredential(
      resolve(stateDirectory, "web-credential.json"),
    );
    const client = await createDashboardClient({
      daemonUrl: demoUrl,
      stateDirectory,
    });
    const store = new DashboardStore({ client, pollIntervalMs: 40 });
    await store.start();
    if (store.state.connection !== "online") {
      throw new Error(`expected online, got ${store.state.connection}`);
    }
    frames.push(renderDashboardFrame(store.state, 100, 32));
    steps.push({
      step: "store-online-initial",
      result: "pass",
      selectedSession: store.state.selectedSession?.sessionKey
        ? "present"
        : "none",
    });

    const killed = await stopListeners(demoPort);
    if (demo.exitCode === null) {
      demo.kill("SIGTERM");
      await delay(200);
    }
    demo = undefined;
    steps.push({ step: "kill-web-demo", result: "pass", killed });

    await waitUntil(
      () => store.state.connection === "reconnecting",
      15_000,
      "store reconnecting",
    );
    frames.push(renderDashboardFrame(store.state, 100, 32));
    if (!frames.at(-1)?.includes("reconnecting")) {
      throw new Error("reconnecting frame missing reconnecting label");
    }
    if (!frames.at(-1)?.includes("last safe snapshot")) {
      throw new Error("reconnecting frame missing last safe snapshot");
    }
    steps.push({ step: "observe-reconnecting", result: "pass" });

    demo = startDemo();
    await waitForDemo(demo);
    steps.push({ step: "restart-web-demo", result: "pass" });

    const keyResult = await handleDashboardKey(store, {
      name: "char",
      value: "r",
    });
    if (keyResult !== "continue") {
      throw new Error(`unexpected key result ${keyResult}`);
    }
    steps.push({ step: "press-r", result: "pass" });

    await waitUntil(
      () => store.state.connection === "online",
      15_000,
      "store online after r",
    );
    frames.push(renderDashboardFrame(store.state, 100, 32));
    if (!frames.at(-1)?.includes("online")) {
      throw new Error("recovered frame missing online label");
    }
    steps.push({ step: "recover-online", result: "pass" });

    const joined = frames.join("\n-----\n");
    if (
      containsSecret(joined, [
        credential.token,
        credential.csrfToken,
        "webboot_",
      ])
    ) {
      throw new Error("capture contained a secret pattern");
    }
    await store.close();
    passed = true;
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    steps.push({ step: "failure", result: "fail", error: failure });
  } finally {
    if (demo && demo.exitCode === null) {
      demo.kill("SIGTERM");
    }
    try {
      if (!(await portInUse(demoPort))) {
        const replacement = startDemo();
        await waitForDemo(replacement);
        steps.push({ step: "leave-web-demo-running", result: "pass" });
      } else {
        steps.push({
          step: "leave-web-demo-running",
          result: "pass",
          reused: true,
        });
      }
    } catch (error) {
      steps.push({
        step: "leave-web-demo-running",
        result: "fail",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const capture = sanitize(frames.join("\n-----\n"));
  await writeFile(capturePath, `${capture}\n`, "utf8");
  const payload = {
    schema: "agent-relay-fxo-1611-tui-reconnect-livecheck.v1",
    result: passed ? "pass" : "fail",
    testedAt: new Date().toISOString(),
    node: {
      path: nativeNode,
      version: process.version,
      arch: process.arch,
    },
    port: demoPort,
    noColor: true,
    steps,
    capturePath: ".artifacts/fxo-1611/captures/tui-reconnect-livecheck.txt",
    failure: failure ?? null,
    limitations: [
      "Synthetic web-demo only; no live Telegram or vendor-provider traffic.",
      "Frames are rendered by the shared TUI renderer bound to the live 4318 store.",
      "Ink alternate-screen bytes are not retained; Ink launch is covered by a separate smoke.",
    ],
  };
  await writeFile(resultPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  process.stdout.write(
    `${JSON.stringify({ result: payload.result, steps: steps.length, failure: failure ?? null })}\n`,
  );
  process.exitCode = passed ? 0 : 1;
}

await main();
