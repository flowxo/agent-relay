# Third-party notices

The Agent Relay distribution depends at runtime on the following packages:

| Package                    | Version | License        |
| -------------------------- | ------- | -------------- |
| `@alcalzone/ansi-tokenize` | 0.3.0   | MIT            |
| `ansi-escapes`             | 7.3.0   | MIT            |
| `ansi-regex`               | 6.3.0   | MIT            |
| `ansi-styles`              | 6.2.3   | MIT            |
| `auto-bind`                | 5.0.1   | MIT            |
| `better-sqlite3`           | 13.0.1  | MIT            |
| `chalk`                    | 5.6.2   | MIT            |
| `cli-boxes`                | 4.0.1   | MIT            |
| `cli-cursor`               | 4.0.0   | MIT            |
| `cli-truncate`             | 6.1.1   | MIT            |
| `code-excerpt`             | 4.0.0   | MIT            |
| `convert-to-spaces`        | 2.0.1   | MIT            |
| `environment`              | 1.1.0   | MIT            |
| `es-toolkit`               | 1.50.0  | MIT            |
| `escape-string-regexp`     | 2.0.0   | MIT            |
| `get-east-asian-width`     | 1.6.0   | MIT            |
| `indent-string`            | 5.0.0   | MIT            |
| `ink`                      | 7.1.1   | MIT            |
| `is-fullwidth-code-point`  | 5.1.0   | MIT            |
| `is-in-ci`                 | 2.0.0   | MIT            |
| `mimic-fn`                 | 2.1.0   | MIT            |
| `node-addon-api`           | 8.9.0   | MIT            |
| `onetime`                  | 5.1.2   | MIT            |
| `patch-console`            | 2.0.0   | MIT            |
| `react`                    | 19.2.8  | MIT            |
| `react-reconciler`         | 0.33.0  | MIT            |
| `restore-cursor`           | 4.0.0   | MIT            |
| `scheduler`                | 0.27.0  | MIT            |
| `signal-exit`              | 3.0.7   | ISC            |
| `slice-ansi`               | 9.0.0   | MIT            |
| `stack-utils`              | 2.0.6   | MIT            |
| `string-width`             | 8.2.2   | MIT            |
| `strip-ansi`               | 7.1.2   | MIT            |
| `tagged-tag`               | 1.0.0   | MIT            |
| `terminal-size`            | 4.0.1   | MIT            |
| `type-fest`                | 5.8.0   | MIT OR CC0-1.0 |
| `widest-line`              | 6.0.0   | MIT            |
| `wrap-ansi`                | 10.0.0  | MIT            |
| `ws`                       | 8.21.3  | MIT            |
| `yoga-layout`              | 3.2.1   | MIT            |
| `zod`                      | 4.4.3   | MIT            |

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
