# Third-party notices

The Agent Relay distribution depends at runtime on the following packages:

| Package          | Version | License |
| ---------------- | ------- | ------- |
| `better-sqlite3` | 13.0.1  | MIT     |
| `zod`            | 4.4.3   | MIT     |

Their license texts and source are available from their respective package
distributions and repositories. Agent Relay's own license is in `LICENSE`.

Build, test, and development dependencies are not included in the published
runtime package. A release pipeline must generate the artifact SBOM from the
exact packed candidate before any prerelease promotion.
