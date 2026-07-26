import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { stdout } from "node:process";
import { fileURLToPath } from "node:url";

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureDirectory = resolve(
  packageDirectory,
  "../../vendor/notifications-c0",
);
const manifest = JSON.parse(
  readFileSync(resolve(fixtureDirectory, "artifacts.json"), "utf8"),
);
const productionSourceDirectory = resolve(packageDirectory, "src");

if (manifest.schema !== "agent-relay.notifications-c0-artifacts.v1") {
  throw new Error("Notifications artifact manifest schema is not recognized.");
}
if (manifest.contractVersion !== "1.0.0-draft.1") {
  throw new Error("Notifications artifact version changed unexpectedly.");
}

const expectedFiles = new Set(
  manifest.artifacts.map((artifact) => artifact.file),
);
const actualTarballs = readdirSync(fixtureDirectory)
  .filter((file) => file.endsWith(".tgz"))
  .sort();
if (
  actualTarballs.length !== expectedFiles.size ||
  actualTarballs.some((file) => !expectedFiles.has(file))
) {
  throw new Error(
    "Notifications artifact fixture contains an unpinned tarball.",
  );
}

for (const artifact of manifest.artifacts) {
  const artifactPath = resolve(fixtureDirectory, artifact.file);
  const digest = createHash("sha256")
    .update(readFileSync(artifactPath))
    .digest("hex");
  if (digest !== artifact.sha256) {
    throw new Error(`Digest mismatch for ${artifact.file}.`);
  }

  const entries = execFileSync("tar", ["-tzf", artifactPath], {
    encoding: "utf8",
  })
    .trim()
    .split("\n");
  if (
    entries.some(
      (entry) =>
        entry.startsWith("/") ||
        entry.split("/").some((segment) => segment === ".."),
    )
  ) {
    throw new Error(`Unsafe archive path in ${artifact.file}.`);
  }

  const packageJson = JSON.parse(
    execFileSync("tar", ["-xOzf", artifactPath, "package/package.json"], {
      encoding: "utf8",
    }),
  );
  if (
    packageJson.name !== artifact.package ||
    packageJson.version !== manifest.contractVersion
  ) {
    throw new Error(`Package identity mismatch for ${artifact.file}.`);
  }
  if (
    packageJson.dependencies?.["@flowxo/notifications-contracts"] !==
      undefined &&
    packageJson.dependencies["@flowxo/notifications-contracts"] !==
      manifest.contractVersion
  ) {
    throw new Error(`Contract dependency drift in ${artifact.file}.`);
  }
  const dependencyValues = Object.values({
    ...packageJson.dependencies,
    ...packageJson.optionalDependencies,
    ...packageJson.peerDependencies,
  });
  if (
    dependencyValues.some(
      (value) =>
        typeof value === "string" &&
        (/^(?:file|link|workspace):/u.test(value) || value.includes("../")),
    )
  ) {
    throw new Error(`Mutable dependency reference in ${artifact.file}.`);
  }
  if (
    ["preinstall", "install", "postinstall"].some(
      (name) => packageJson.scripts?.[name] !== undefined,
    )
  ) {
    throw new Error(`Install-time script in ${artifact.file}.`);
  }
}

for (const file of readdirSync(productionSourceDirectory).filter(
  (entry) => entry.endsWith(".ts") && !entry.endsWith(".test.ts"),
)) {
  const source = readFileSync(resolve(productionSourceDirectory, file), "utf8");
  if (
    /(?:from|import)\s*["'][^"']*(?:store|sqlite|telegram|cloudflare|apps\/relay)[^"']*["']/iu.test(
      source,
    ) ||
    /(?:from|import)\s*["']node:/u.test(source) ||
    /(?:\.\.\/){2,}(?:flowxo-notifications|agent-relay)/u.test(source) ||
    /from\s*["']@agent-relay\/core["']/u.test(source)
  ) {
    throw new Error(
      `Production boundary import violation in notifications-transport/${file}.`,
    );
  }
}

stdout.write(
  `Notifications C0 artifacts verified: ${String(manifest.artifacts.length)} packages at ${manifest.contractVersion}.\n`,
);
