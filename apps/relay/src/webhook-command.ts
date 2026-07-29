import {
  removeWebhookConfiguration,
  resolveWebhookConfiguration,
  webhookConfigurationPath,
  writeWebhookConfiguration,
} from "./webhook-config.js";

export const WEBHOOK_COMMAND_USAGE = `Agent Relay Outbound Webhook

Usage:
  agent-relay webhook configure --url <https-url> --secret-stdin [--timeout-ms <milliseconds>]
  agent-relay webhook status
  agent-relay webhook disconnect

The shared secret is accepted only on stdin and is stored in a mode-0600 local
configuration file. Configuring credentials does not select the transport; run
"agent-relay transport select webhook" and restart the daemon when ready.
`;

export interface WebhookCommandRuntime {
  args: string[];
  environment?: Readonly<Record<string, string | undefined>>;
  now?: () => Date;
  readStdin?: () => Promise<string>;
  stateDirectory: string;
}

function flag(args: string[], name: string): string | undefined {
  const indexes = args.flatMap((argument, index) =>
    argument === name ? [index] : [],
  );
  if (indexes.length > 1) {
    throw new Error(`${name} may be provided only once`);
  }
  const index = indexes[0];
  if (index === undefined) {
    return undefined;
  }
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function configuredFlags(args: string[]): Set<number> {
  const used = new Set<number>();
  for (const name of ["--url", "--timeout-ms"]) {
    const index = args.indexOf(name);
    if (index !== -1) {
      used.add(index);
      used.add(index + 1);
    }
  }
  const secretIndex = args.indexOf("--secret-stdin");
  if (secretIndex !== -1) {
    used.add(secretIndex);
  }
  return used;
}

function normalizedSecret(value: string): string {
  return value.replace(/\r?\n$/, "");
}

export async function runWebhookCommand(
  runtime: WebhookCommandRuntime,
): Promise<unknown> {
  const [subcommand, ...args] = runtime.args;
  if (
    subcommand === undefined ||
    subcommand === "help" ||
    subcommand === "--help" ||
    subcommand === "-h"
  ) {
    return { help: WEBHOOK_COMMAND_USAGE };
  }
  const environment = runtime.environment ?? process.env;
  if (subcommand === "status") {
    if (args.length !== 0) {
      throw new Error("Webhook status does not accept arguments");
    }
    return (
      await resolveWebhookConfiguration({
        stateDirectory: runtime.stateDirectory,
        environment,
      })
    ).readiness;
  }
  if (subcommand === "configure") {
    const used = configuredFlags(args);
    if (used.size !== args.length) {
      throw new Error("Webhook configure received an unknown argument");
    }
    const endpoint = flag(args, "--url");
    if (endpoint === undefined) {
      throw new Error("Webhook configure requires --url");
    }
    if (!args.includes("--secret-stdin")) {
      throw new Error("Webhook configure requires --secret-stdin");
    }
    if (args.filter((argument) => argument === "--secret-stdin").length > 1) {
      throw new Error("--secret-stdin may be provided only once");
    }
    if (runtime.readStdin === undefined) {
      throw new Error("Webhook secret stdin is unavailable");
    }
    const timeoutRaw = flag(args, "--timeout-ms");
    const timeoutMs = timeoutRaw === undefined ? undefined : Number(timeoutRaw);
    const secret = normalizedSecret(await runtime.readStdin());
    await writeWebhookConfiguration(
      webhookConfigurationPath(runtime.stateDirectory),
      {
        endpoint,
        secret,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      },
      runtime.now?.() ?? new Date(),
    );
    const readiness = (
      await resolveWebhookConfiguration({
        stateDirectory: runtime.stateDirectory,
        environment: {},
      })
    ).readiness;
    return {
      ...readiness,
      configured: true,
      restartRequired: true,
      transportSelectionUnchanged: true,
    };
  }
  if (subcommand === "disconnect") {
    if (args.length !== 0) {
      throw new Error("Webhook disconnect does not accept arguments");
    }
    const removed = await removeWebhookConfiguration(
      webhookConfigurationPath(runtime.stateDirectory),
    );
    const environmentActive =
      environment["AGENT_RELAY_WEBHOOK_URL"] !== undefined ||
      environment["AGENT_RELAY_WEBHOOK_SECRET"] !== undefined ||
      environment["AGENT_RELAY_WEBHOOK_TIMEOUT_MS"] !== undefined;
    return {
      disconnected: removed,
      environmentActive,
      restartRequired: removed,
      transportSelectionUnchanged: true,
    };
  }
  throw new Error("Unknown webhook subcommand");
}
