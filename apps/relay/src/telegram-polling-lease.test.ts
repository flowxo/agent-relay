import { once } from "node:events";
import { spawn } from "node:child_process";
import { createServer } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import {
  acquireTelegramPollingLease,
  defaultTelegramPollingLeasePort,
  TelegramPollingLeaseError,
} from "./telegram-polling-lease.js";

const leases: Array<{ release(): Promise<void> }> = [];

async function availablePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Synthetic lease port is unavailable");
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
  return address.port;
}

afterEach(async () => {
  await Promise.all(leases.splice(0).map(async (lease) => lease.release()));
});

describe("Telegram polling lease", () => {
  it("uses one canonical OS-user port across process environment changes", () => {
    const expected = defaultTelegramPollingLeasePort();
    const priorTmp = process.env["TMPDIR"];
    const priorHome = process.env["HOME"];
    process.env["TMPDIR"] = "/synthetic/alternate-tmp";
    process.env["HOME"] = "/synthetic/alternate-home";
    try {
      expect(defaultTelegramPollingLeasePort()).toBe(expected);
    } finally {
      if (priorTmp === undefined) delete process.env["TMPDIR"];
      else process.env["TMPDIR"] = priorTmp;
      if (priorHome === undefined) delete process.env["HOME"];
      else process.env["HOME"] = priorHome;
    }
  });

  it("coordinates isolated state roots without recording a provider identifier", async () => {
    const port = await availablePort();
    const first = await acquireTelegramPollingLease({ port });
    leases.push(first);

    await expect(acquireTelegramPollingLease({ port })).rejects.toMatchObject({
      code: "telegram-poller-already-owned",
      retryable: false,
    });

    await first.release();
    leases.splice(leases.indexOf(first), 1);
    const second = await acquireTelegramPollingLease({ port });
    await second.release();
  });

  it.skipIf(process.platform === "win32")(
    "recovers automatically after the owning process crashes",
    async () => {
      const port = await availablePort();
      const child = spawn(
        process.execPath,
        [
          "-e",
          `require("node:net").createServer().listen(${String(port)}, "127.0.0.1", () => process.stdout.write("ready\\n"))`,
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      await once(child.stdout, "data");
      await expect(
        acquireTelegramPollingLease({ port }),
      ).rejects.toBeInstanceOf(TelegramPollingLeaseError);

      child.kill("SIGKILL");
      await once(child, "exit");
      const recovered = await acquireTelegramPollingLease({ port });
      await recovered.release();
    },
  );

  it("makes concurrent release idempotent before a replacement acquires", async () => {
    const port = await availablePort();
    const first = await acquireTelegramPollingLease({ port });
    await Promise.all([first.release(), first.release()]);

    const replacement = await acquireTelegramPollingLease({ port });
    leases.push(replacement);
    await expect(acquireTelegramPollingLease({ port })).rejects.toBeInstanceOf(
      TelegramPollingLeaseError,
    );
  });

  it("rejects invalid injected coordination ports", async () => {
    await expect(acquireTelegramPollingLease({ port: 0 })).rejects.toThrow(
      "port is invalid",
    );
  });
});
