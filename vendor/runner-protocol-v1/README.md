# Runner protocol v1 pinned artifacts

These archives are immutable inputs for the default-off Agent Relay runner
bridge. They were deterministically packed from the exact clean source revision
recorded in `contracts/runner-protocol-lock.json`.

`contracts/runner-protocol-lock.json` records the exact archive digests and
fixture inventory. The producer built both packages twice with byte-identical
output, and the cross-repository verifier matched the consumer result to the
producer manifest.

EH-06 owns future cross-repository compatibility updates and any package or
protocol release decision.
