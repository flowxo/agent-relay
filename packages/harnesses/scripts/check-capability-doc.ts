import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { format } from "prettier";

import {
  HARNESS_COMPATIBILITY,
  renderCapabilityMatrix,
  renderSupportSummaryBlock,
} from "../src/capabilities.js";

const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(packageDir, "..", "..");
const matrixPath = join(root, "docs", "capability-matrix.md");
const expectedMatrix = await format(renderCapabilityMatrix(), {
  parser: "markdown",
  proseWrap: "always",
});
const expectedSummary = (
  await format(renderSupportSummaryBlock(), {
    parser: "markdown",
    proseWrap: "always",
  })
).trimEnd();
const summaryPattern =
  /<!-- BEGIN GENERATED HARNESS SUPPORT -->[\s\S]*?<!-- END GENERATED HARNESS SUPPORT -->/;
const write = process.argv.includes("--write");

function headingAnchorExists(path: string, anchor: string): boolean {
  const headings = readFileSync(path, "utf8").matchAll(/^#{1,6}\s+(.+)$/gm);
  for (const match of headings) {
    const heading = match[1];
    if (heading === undefined) {
      continue;
    }
    const slug = heading
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s-]/gu, "")
      .replace(/\s+/g, "-");
    if (slug === anchor) {
      return true;
    }
  }
  return false;
}

function assertEvidenceReference(reference: string): void {
  const [relativePath, anchor] = reference.split("#", 2);
  if (relativePath === undefined || relativePath.length === 0) {
    throw new Error(`invalid compatibility evidence reference: ${reference}`);
  }
  const path = resolve(root, relativePath);
  if (!existsSync(path)) {
    throw new Error(`missing compatibility evidence file: ${relativePath}`);
  }
  if (
    anchor !== undefined &&
    anchor.length > 0 &&
    !headingAnchorExists(path, anchor)
  ) {
    throw new Error(
      `missing compatibility evidence anchor: ${relativePath}#${anchor}`,
    );
  }
}

assertEvidenceReference(HARNESS_COMPATIBILITY.runtimeTarget.evidenceRecord);
for (const entry of HARNESS_COMPATIBILITY.records) {
  assertEvidenceReference(entry.evidence.record);
  for (const fixturePath of entry.evidence.fixturePaths) {
    const path = resolve(root, fixturePath);
    if (!existsSync(path)) {
      throw new Error(`missing compatibility fixture: ${fixturePath}`);
    }
  }
}

if (write) {
  writeFileSync(matrixPath, expectedMatrix, "utf8");
} else if (readFileSync(matrixPath, "utf8") !== expectedMatrix) {
  throw new Error(
    "docs/capability-matrix.md differs from the code-generated matrix",
  );
}

for (const relativePath of ["README.md", "SUPPORT.md"]) {
  const path = join(root, relativePath);
  const source = readFileSync(path, "utf8");
  const observed = source.match(summaryPattern)?.[0];
  if (observed === undefined) {
    throw new Error(`${relativePath} is missing the generated support block`);
  }
  if (write) {
    writeFileSync(
      path,
      source.replace(summaryPattern, expectedSummary),
      "utf8",
    );
  } else if (observed !== expectedSummary) {
    throw new Error(
      `${relativePath} support summary differs from the compatibility registry`,
    );
  }
}

process.stdout.write(
  write
    ? "Generated compatibility matrix and public support summaries.\n"
    : "Compatibility evidence, matrix, and public support summaries verified.\n",
);
