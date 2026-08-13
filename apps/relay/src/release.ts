declare const __AGENT_RELAY_BUILD_VERSION__: string | undefined;

const sourceVersion = "0.1.0-alpha.3";

export const AGENT_RELAY_VERSION =
  typeof __AGENT_RELAY_BUILD_VERSION__ === "string"
    ? __AGENT_RELAY_BUILD_VERSION__
    : sourceVersion;
