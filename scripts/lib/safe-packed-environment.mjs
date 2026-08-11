import { delimiter, resolve } from "node:path";

const allowedPackageProofEnvironmentNames = [
  "AR",
  "ARCHFLAGS",
  "ASDF_DATA_DIR",
  "ASDF_DIR",
  "ASDF_NODEJS_VERSION",
  "CC",
  "CFLAGS",
  "COREPACK_HOME",
  "CPP",
  "CPPFLAGS",
  "CXX",
  "CXXFLAGS",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LDFLAGS",
  "MACOSX_DEPLOYMENT_TARGET",
  "MAKE",
  "MAKEFLAGS",
  "PATH",
  "PNPM_HOME",
  "SDKROOT",
  "SHELL",
  "TZ",
];

export function packageProofToolEnvironment({
  ambientEnvironment,
  home,
  temporaryRoot,
  userConfigPath,
  overrides = {},
}) {
  const environment = Object.fromEntries(
    allowedPackageProofEnvironmentNames.flatMap((name) => {
      const value = ambientEnvironment[name];
      return value === undefined ? [] : [[name, value]];
    }),
  );
  const asdfDataDirectory =
    ambientEnvironment.ASDF_DATA_DIR ??
    (ambientEnvironment.HOME === undefined
      ? undefined
      : resolve(ambientEnvironment.HOME, ".asdf"));
  return {
    ...environment,
    ...(asdfDataDirectory === undefined
      ? {}
      : { ASDF_DATA_DIR: asdfDataDirectory }),
    HOME: home,
    USERPROFILE: home,
    TMPDIR: temporaryRoot,
    TEMP: temporaryRoot,
    TMP: temporaryRoot,
    NPM_CONFIG_USERCONFIG: userConfigPath,
    CI: "1",
    NO_COLOR: "1",
    ...overrides,
  };
}

export function safePackedRuntimeEnvironment({
  home,
  pathEntries,
  stateDirectory,
  temporaryRoot,
  webEnabled,
  daemonUrl,
}) {
  return {
    PATH: pathEntries.join(delimiter),
    HOME: home,
    USERPROFILE: home,
    TMPDIR: temporaryRoot,
    SHELL: "/bin/sh",
    LANG: "C",
    LC_ALL: "C",
    CI: "1",
    NO_COLOR: "1",
    AGENT_RELAY_STATE_DIR: stateDirectory,
    AGENT_RELAY_TRANSPORT: "fake",
    AGENT_RELAY_WEB_ENABLED: webEnabled ? "1" : "0",
    ...(daemonUrl === undefined ? {} : { AGENT_RELAY_DAEMON_URL: daemonUrl }),
  };
}

export function packedRuntimePathEntries({ prefix, harnessBin, systemPath }) {
  return [
    ...(harnessBin === undefined ? [] : [harnessBin]),
    resolve(prefix, "node_modules/.bin"),
    systemPath,
  ];
}
