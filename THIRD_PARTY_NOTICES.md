# Third-party notices

The Agent Relay distribution depends at runtime on the following packages:

| Package          | Version | License |
| ---------------- | ------- | ------- |
| `better-sqlite3` | 13.0.1  | MIT     |
| `node-addon-api` | 8.9.0   | MIT     |
| `zod`            | 4.4.3   | MIT     |
| `ink`            | 7.1.1   | MIT     |
| `react`          | 19.2.8  | MIT     |

Their license texts and source are available from their respective package
distributions and repositories. Agent Relay's own license is in `LICENSE`.

The bundled CLI also contains code from these exact WhooshBang components:

| Component               | Version     | Source evidence                            | Declared license |
| ----------------------- | ----------- | ------------------------------------------ | ---------------- |
| `@whooshbang/contracts` | 1.0.0-rc.12 | `50de931fed8d819d1a70ec27201351b09f0ef251` | MIT              |
| `@whooshbang/sdk`       | 1.0.0-rc.13 | `50de931fed8d819d1a70ec27201351b09f0ef251` | MIT              |

Their exact archive SHA-256 values are frozen in `packaging/release.json` and
the generated SPDX SBOM. The owner-approved FXO-1568 decision licenses these
exact bundled artifacts under MIT and approves this shipped notice:

> Copyright (c) 2026 Flow XO, LLC

The MIT terms in Agent Relay's `LICENSE` apply to those exact bundled
components. The approval does not extend to a different WhooshBang version,
archive, digest, or source commit without a new review.

Other build, test, and development dependencies—including the exact
`@whooshbang/contract-mock@1.0.0-rc.15` verifier—are not included in the runtime
package. The release pipeline generates an SPDX 2.3 SBOM from the exact packed
candidate, including every packed file and the frozen runtime dependency
closure, before any prerelease promotion.
