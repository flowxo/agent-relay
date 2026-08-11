# Third-party notices

The Agent Relay distribution depends at runtime on the following packages:

| Package          | Version | License |
| ---------------- | ------- | ------- |
| `better-sqlite3` | 13.0.1  | MIT     |
| `node-addon-api` | 8.9.0   | MIT     |
| `zod`            | 4.4.3   | MIT     |

Their license texts and source are available from their respective package
distributions and repositories. Agent Relay's own license is in `LICENSE`.

The bundled CLI also contains code from these exact WhooshBang components:

| Component               | Version     | Source evidence                            | Declared license |
| ----------------------- | ----------- | ------------------------------------------ | ---------------- |
| `@whooshbang/contracts` | 1.0.0-rc.12 | `50de931fed8d819d1a70ec27201351b09f0ef251` | `NOASSERTION`    |
| `@whooshbang/sdk`       | 1.0.0-rc.13 | `50de931fed8d819d1a70ec27201351b09f0ef251` | `NOASSERTION`    |

Their exact archive SHA-256 values are frozen in `packaging/release.json` and
the generated SPDX SBOM. `NOASSERTION` is not a license grant: an owner-approved
distributable license and notice decision is required before public
distribution. Publication remains blocked and Agent Relay does not infer that
decision.

Other build, test, and development dependencies—including the exact
`@whooshbang/contract-mock@1.0.0-rc.15` verifier—are not included in the runtime
package. The release pipeline generates an SPDX 2.3 SBOM from the exact packed
candidate, including every packed file and the frozen runtime dependency
closure, before any prerelease promotion.
