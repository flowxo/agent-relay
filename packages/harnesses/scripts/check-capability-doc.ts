import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { renderCapabilityMatrix } from "../src/capabilities.js";

const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const checkedIn = readFileSync(
  join(packageDir, "..", "..", "docs", "capability-matrix.md"),
  "utf8",
);
const expected = renderCapabilityMatrix();

if (checkedIn !== expected) {
  process.stderr.write(
    "docs/capability-matrix.md differs from the code-generated matrix\n",
  );
  process.exitCode = 1;
}
