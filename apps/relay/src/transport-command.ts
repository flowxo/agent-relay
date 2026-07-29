import {
  AgentRelayTransportSchema,
  inspectTransportReadiness,
  resolveTransportSelection,
  transportSelectionPath,
  writeTransportSelection,
} from "./transport-config.js";

import type { TelegramReadinessInput } from "./transport-config.js";

export const TRANSPORT_COMMAND_USAGE = `Agent Relay Transport Selection

Usage:
  agent-relay transport status
  agent-relay transport select <fake|telegram|whooshbang|webhook>

Selection is durable and affects a daemon after its next start. Credentials
never select a transport. A daemon-only --transport override takes precedence
without changing this file.
`;

export interface TransportCommandRuntime {
  args: string[];
  environment?: Readonly<Record<string, string | undefined>>;
  now?: () => Date;
  stateDirectory: string;
}

function environmentValue(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
): string | undefined {
  const value = environment[name];
  return value === undefined || value.length === 0 ? undefined : value;
}

export function telegramReadinessInputFromEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): TelegramReadinessInput {
  const token = environmentValue(environment, "AGENT_RELAY_TELEGRAM_TOKEN");
  const chatId = environmentValue(environment, "AGENT_RELAY_TELEGRAM_CHAT_ID");
  const operatorId = environmentValue(
    environment,
    "AGENT_RELAY_TELEGRAM_OPERATOR_ID",
  );
  const replyChatId = environmentValue(
    environment,
    "AGENT_RELAY_TELEGRAM_CHAT_ID",
  );
  const updateMode = environmentValue(
    environment,
    "AGENT_RELAY_TELEGRAM_UPDATE_MODE",
  );
  const webhookSecret = environmentValue(
    environment,
    "AGENT_RELAY_TELEGRAM_WEBHOOK_SECRET",
  );
  return {
    ...(token === undefined ? {} : { token }),
    ...(chatId === undefined ? {} : { chatId }),
    ...(operatorId === undefined ? {} : { operatorId }),
    ...(replyChatId === undefined ? {} : { replyChatId }),
    ...(updateMode === undefined ? {} : { updateMode }),
    ...(webhookSecret === undefined ? {} : { webhookSecret }),
  };
}

async function status(
  runtime: TransportCommandRuntime,
  environment: Readonly<Record<string, string | undefined>>,
) {
  const environmentOverride = environmentValue(
    environment,
    "AGENT_RELAY_TRANSPORT",
  );
  const selection = await resolveTransportSelection({
    stateDirectory: runtime.stateDirectory,
    ...(environmentOverride === undefined ? {} : { environmentOverride }),
  });
  return await inspectTransportReadiness({
    selection,
    stateDirectory: runtime.stateDirectory,
    telegram: telegramReadinessInputFromEnvironment(environment),
    webhookEnvironment: environment,
  });
}

export async function runTransportCommand(
  runtime: TransportCommandRuntime,
): Promise<unknown> {
  const [subcommand, ...args] = runtime.args;
  if (
    subcommand === undefined ||
    subcommand === "help" ||
    subcommand === "--help" ||
    subcommand === "-h"
  ) {
    return { help: TRANSPORT_COMMAND_USAGE };
  }
  const environment = runtime.environment ?? process.env;
  if (subcommand === "status") {
    if (args.length !== 0) {
      throw new Error("Transport status does not accept arguments");
    }
    return await status(runtime, environment);
  }
  if (subcommand === "select") {
    if (args.length !== 1) {
      throw new Error(
        "Transport select requires exactly fake, telegram, whooshbang, or webhook",
      );
    }
    const selected = AgentRelayTransportSchema.parse(args[0]);
    await writeTransportSelection(
      transportSelectionPath(runtime.stateDirectory),
      selected,
      runtime.now?.() ?? new Date(),
    );
    const report = await status(runtime, environment);
    return {
      ...report,
      durableSelection: selected,
      restartRequired: true,
      retainedLocalState: true,
    };
  }
  throw new Error("Unknown transport subcommand");
}
