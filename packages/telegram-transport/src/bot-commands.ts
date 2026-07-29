export const AGENT_RELAY_TELEGRAM_BOT_COMMANDS = [
  {
    command: "purge",
    description: "Review inactive session topics for deletion",
  },
  {
    command: "cleanup",
    description: "Review ended session topics for deletion",
  },
] as const;
