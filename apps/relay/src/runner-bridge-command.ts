import {
  diagnoseRunnerBridge,
  RunnerBridgeStore,
  runnerBridgeStatus,
} from "@agent-relay/runner-bridge";

import {
  eraseDisabledRunnerBridgeState,
  readRunnerBridgeConfiguration,
  runnerBridgeDatabaseExists,
  runnerBridgePaths,
  writeRunnerBridgeConfiguration,
} from "./runner-bridge-config.js";

export const RUNNER_BRIDGE_COMMAND_USAGE = `Agent Relay Runner Bridge (experimental)

Usage:
  agent-relay runner-bridge status
  agent-relay runner-bridge enable
  agent-relay runner-bridge disable
  agent-relay runner-bridge erase --confirm

The bridge remains off unless explicitly enabled. EH-03 provides the durable
protocol component and fake structured-harness composition only. Enabling the
selection before a native adapter is installed makes daemon startup fail closed.
`;

export interface RunnerBridgeCommandRuntime {
  readonly args: readonly string[];
  readonly stateDirectory: string;
  readonly now?: () => Date;
}

async function status(stateDirectory: string) {
  const paths = runnerBridgePaths(stateDirectory);
  const configuration = await readRunnerBridgeConfiguration(
    paths.configuration,
  );
  const databasePresent = await runnerBridgeDatabaseExists(paths.database);
  if (!databasePresent) {
    return {
      schema: "agent-relay-runner-bridge-status.v1",
      configured: configuration !== undefined,
      enabled: configuration?.enabled ?? false,
      adapter: "not-installed",
      state:
        configuration?.enabled === true
          ? "configuration-incomplete"
          : "disabled",
      databasePresent: false,
      releaseEligibleProtocolArtifact: false,
    };
  }
  const store = new RunnerBridgeStore(paths.database);
  try {
    return {
      schema: "agent-relay-runner-bridge-status.v1",
      configured: configuration !== undefined,
      enabled: configuration?.enabled ?? false,
      adapter: "not-installed",
      databasePresent: true,
      releaseEligibleProtocolArtifact: false,
      bridge: runnerBridgeStatus(store),
      doctor: diagnoseRunnerBridge(store),
    };
  } finally {
    store.close();
  }
}

export async function runRunnerBridgeCommand(
  runtime: RunnerBridgeCommandRuntime,
): Promise<unknown> {
  const [subcommand, ...args] = runtime.args;
  if (
    subcommand === undefined ||
    subcommand === "help" ||
    subcommand === "--help" ||
    subcommand === "-h"
  ) {
    return { help: RUNNER_BRIDGE_COMMAND_USAGE };
  }
  const paths = runnerBridgePaths(runtime.stateDirectory);
  if (subcommand === "status") {
    if (args.length !== 0) {
      throw new Error("Runner bridge status does not accept arguments.");
    }
    return await status(runtime.stateDirectory);
  }
  if (subcommand === "enable" || subcommand === "disable") {
    if (args.length !== 0) {
      throw new Error(`Runner bridge ${subcommand} does not accept arguments.`);
    }
    const enabled = subcommand === "enable";
    await writeRunnerBridgeConfiguration(
      paths.configuration,
      enabled,
      runtime.now?.() ?? new Date(),
    );
    return {
      ...(await status(runtime.stateDirectory)),
      restartRequired: true,
      nativeAdapterRequired: enabled,
      standaloneAttentionStateRetained: true,
    };
  }
  if (subcommand === "erase") {
    if (args.length !== 1 || args[0] !== "--confirm") {
      throw new Error("Runner bridge erase requires exactly --confirm.");
    }
    const removed = await eraseDisabledRunnerBridgeState(paths);
    return {
      erased: true,
      removed,
      recoverable: false,
      standaloneAttentionStateRetained: true,
    };
  }
  throw new Error("Unknown runner bridge subcommand.");
}
