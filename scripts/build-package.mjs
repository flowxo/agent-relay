import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

import { build } from "esbuild";

const root = resolve(import.meta.dirname, "..");
const stage = resolve(root, ".artifacts/package");
const rootPackage = JSON.parse(
  await readFile(resolve(root, "package.json"), "utf8"),
);
const release = JSON.parse(
  await readFile(resolve(root, "packaging/release.json"), "utf8"),
);
const releaseSource = await readFile(
  resolve(root, "apps/relay/src/release.ts"),
  "utf8",
);

if (
  release.schema !== "agent-relay-release-candidate.v1" ||
  rootPackage.name !== release.name ||
  rootPackage.version !== release.version ||
  rootPackage.private !== true
) {
  throw new Error(
    "root package identity must remain the approved private alpha candidate",
  );
}
if (!releaseSource.includes(`const sourceVersion = "${release.version}";`)) {
  throw new Error("source-build version differs from packaging/release.json");
}

await rm(stage, { recursive: true, force: true });
await mkdir(resolve(stage, "dist/web"), { recursive: true });

await build({
  absWorkingDir: root,
  entryPoints: [resolve(root, "apps/relay/src/cli.ts")],
  outfile: resolve(stage, "dist/cli.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  treeShaking: true,
  sourcemap: false,
  legalComments: "none",
  minifyWhitespace: true,
  minifySyntax: true,
  minifyIdentifiers: false,
  define: {
    __AGENT_RELAY_BUILD_VERSION__: JSON.stringify(release.version),
  },
  external: ["better-sqlite3", "zod"],
  alias: {
    "@agent-relay/core": resolve(root, "packages/core/src/index.ts"),
    "@agent-relay/harnesses": resolve(root, "packages/harnesses/src/index.ts"),
    "@agent-relay/protocol": resolve(root, "packages/protocol/src/index.ts"),
  },
  logLevel: "warning",
});
await chmod(resolve(stage, "dist/cli.js"), 0o755);

const webAssets = [
  "app.js",
  "index.html",
  "state.js",
  "styles.css",
  "version.js",
];
for (const asset of webAssets) {
  await copyFile(
    resolve(root, "apps/relay/web", asset),
    resolve(stage, "dist/web", asset),
  );
}

for (const [source, destination] of [
  ["packaging/README.md", "README.md"],
  ["LICENSE", "LICENSE"],
  ["CHANGELOG.md", "CHANGELOG.md"],
  ["THIRD_PARTY_NOTICES.md", "THIRD_PARTY_NOTICES.md"],
]) {
  await copyFile(resolve(root, source), resolve(stage, destination));
}

const packageManifest = {
  name: release.name,
  version: release.version,
  private: true,
  description: rootPackage.description,
  license: rootPackage.license,
  type: "module",
  bin: {
    "agent-relay": "./dist/cli.js",
  },
  files: [
    "dist",
    "README.md",
    "LICENSE",
    "CHANGELOG.md",
    "THIRD_PARTY_NOTICES.md",
  ],
  os: release.os,
  cpu: release.cpu,
  engines: {
    node: release.node,
  },
  repository: rootPackage.repository,
  bugs: rootPackage.bugs,
  homepage: rootPackage.homepage,
  keywords: rootPackage.keywords,
  dependencies: release.dependencies,
  publishConfig: {
    access: "public",
    provenance: true,
  },
};

await writeFile(
  resolve(stage, "package.json"),
  `${JSON.stringify(packageManifest, null, 2)}\n`,
  "utf8",
);

process.stdout.write(
  `Built ${packageManifest.name}@${packageManifest.version} in .artifacts/package (source maps omitted).\n`,
);
