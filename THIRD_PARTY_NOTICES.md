# Third-party notices

The Agent Relay distribution depends at runtime on the following packages:

| Package          | Version | License |
| ---------------- | ------- | ------- |
| `better-sqlite3` | 13.0.1  | MIT     |
| `node-addon-api` | 8.9.0   | MIT     |
| `zod`            | 4.4.3   | MIT     |

Their license texts and source are available from their respective package
distributions and repositories. Agent Relay's own license is in `LICENSE`.

Build, test, and development dependencies are not included in the published
runtime package. The release pipeline generates an SPDX 2.3 SBOM from the exact
packed candidate, including every packed file and the frozen runtime dependency
closure, before any prerelease promotion.
