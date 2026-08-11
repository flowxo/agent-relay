import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import { assertFrozenEvidenceProvenance } from "../lib/v1-release-boundary.mjs";

const root = resolve(import.meta.dirname, "../..");
const boundary = JSON.parse(
  await readFile(resolve(root, "packaging/v1-release-boundary.json"), "utf8"),
);

test("freezes exact source and same-version package provenance", () => {
  assert.doesNotThrow(() => assertFrozenEvidenceProvenance(boundary));
  for (const mutate of [
    (candidate) => {
      candidate.sourceCandidateEnteringFreeze.mergeCommit = "a".repeat(40);
    },
    (candidate) => {
      candidate.evidenceArtifacts.retainedLiveReviewed.sha256 = "b".repeat(64);
    },
    (candidate) => {
      candidate.evidenceArtifacts.pullRequest40CredentialFreePackedProof.retained = true;
    },
  ]) {
    const candidate = JSON.parse(JSON.stringify(boundary));
    mutate(candidate);
    assert.throws(() => assertFrozenEvidenceProvenance(candidate), /differs/);
  }
});
