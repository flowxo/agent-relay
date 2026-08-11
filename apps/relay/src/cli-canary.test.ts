import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { main } from "./cli.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

describe("CLI fake canary boundary", () => {
  it("checks daemon transport before creating state or ingesting", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-relay-cli-canary-"));
    temporaryDirectories.push(root);
    const stateDirectory = join(root, "state");
    const requests: string[] = [];
    const server = createServer((request, response) => {
      requests.push(`${request.method ?? ""} ${request.url ?? ""}`);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ selectedTransport: "telegram" }));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("synthetic canary server did not bind");
    }
    const originalStateDirectory = process.env["AGENT_RELAY_STATE_DIR"];
    const originalDaemonUrl = process.env["AGENT_RELAY_DAEMON_URL"];
    process.env["AGENT_RELAY_STATE_DIR"] = stateDirectory;
    process.env["AGENT_RELAY_DAEMON_URL"] =
      `http://127.0.0.1:${String(address.port)}`;

    try {
      await expect(main(["canary"])).rejects.toMatchObject({
        code: "fake-transport-not-selected",
      });
      expect(requests).toEqual(["GET /v1/status"]);
      await expect(
        import("node:fs/promises").then(
          async ({ stat }) => await stat(stateDirectory),
        ),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) =>
          error === undefined ? resolve() : reject(error),
        );
      });
      if (originalStateDirectory === undefined) {
        delete process.env["AGENT_RELAY_STATE_DIR"];
      } else {
        process.env["AGENT_RELAY_STATE_DIR"] = originalStateDirectory;
      }
      if (originalDaemonUrl === undefined) {
        delete process.env["AGENT_RELAY_DAEMON_URL"];
      } else {
        process.env["AGENT_RELAY_DAEMON_URL"] = originalDaemonUrl;
      }
    }
  });
});

describe("CLI web-demo boundary", () => {
  it.each(["--db", "--log"])(
    "rejects %s before touching the requested target",
    async (option) => {
      const root = await mkdtemp(join(tmpdir(), "agent-relay-cli-demo-"));
      temporaryDirectories.push(root);
      const stateDirectory = join(root, "state");
      const target = join(root, "synthetic-existing-target");
      await writeFile(target, "preserve-synthetic-target\n", "utf8");
      const originalStateDirectory = process.env["AGENT_RELAY_STATE_DIR"];
      process.env["AGENT_RELAY_STATE_DIR"] = stateDirectory;
      try {
        await expect(main(["web-demo", option, target])).rejects.toThrow(
          "web-demo fixes its database, log, and host",
        );
        expect(await readFile(target, "utf8")).toBe(
          "preserve-synthetic-target\n",
        );
      } finally {
        if (originalStateDirectory === undefined) {
          delete process.env["AGENT_RELAY_STATE_DIR"];
        } else {
          process.env["AGENT_RELAY_STATE_DIR"] = originalStateDirectory;
        }
      }
    },
  );

  it("rejects a non-loopback host override", async () => {
    await expect(main(["web-demo", "--host", "0.0.0.0"])).rejects.toThrow(
      "web-demo fixes its database, log, and host",
    );
  });
});
