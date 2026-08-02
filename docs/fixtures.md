# Safe fixtures and compatibility evidence

Fixtures make native harness and transport contracts reviewable without
retaining private operator data. They are test inputs, not archives of a real
session.

## Create a fixture safely

Construct the sanitized fixture outside the repository. Never commit a raw hook
payload, callback, request, log, database extract, configuration file, or
transcript and then try to remove private values in a later commit.

Retain only fields needed to prove the contract. Replace all content with
obvious synthetic values:

- identifiers use names such as `session_fixture_0001`;
- prompts, summaries, answers, errors, and option labels describe themselves as
  synthetic;
- a necessary path uses `/workspace/...`, never a real home or repository path;
  and
- dates may be fixed, but must not identify a private session.

Delete credentials, authorization headers, cookies, callback secrets, account
and chat identifiers, usernames, hostnames, repository identities, source code,
tool input, process arguments, and private transcript content. Do not include a
SQLite database or raw log as a fixture.

## Manifest requirements

Every fixture root has a checked-in `manifest.json`. Add each JSON fixture to
the exact inventory and remove its entry when the fixture is removed. The
nearest manifest records:

- observation or recording date;
- primary source or contract;
- exact provider, harness, API, or contract version;
- evidence class, such as official-example-sanitized, local-help-observed,
  fake-proven, or live-proven; and
- a privacy/sanitization statement.

A fixture derived from an official example must say so. A local or live
observation records only bounded metadata; it does not make the fixture safe to
publish by itself. Compatibility claims follow the separate
[evidence ladder](compatibility.md).

Each JSON fixture, including its manifest, must be valid UTF-8 JSON, a regular
file rather than a symlink, and no larger than 64 KiB. A protocol can impose a
smaller bound.

Run:

```sh
pnpm fixtures:check
```

The checker validates inventories, required provenance metadata, file size, JSON
syntax, symlinks, traversal, common credential shapes, private-key material,
sensitive value keys, and machine-specific user paths. It is a backstop, not
permission to copy private content into the repository.

## Fixture roots

| Root                                                                        | Purpose                                     |
| --------------------------------------------------------------------------- | ------------------------------------------- |
| `packages/harnesses/fixtures`                                               | Sanitized native harness payload contracts  |
| `packages/telegram-transport/fixtures/telegram`                             | Sanitized Telegram Bot API request shapes   |
| `packages/protocol/fixtures/interactions`                                   | Synthetic provider-neutral interaction data |
| `packages/webhook-transport/fixtures/webhook`                               | Synthetic outbound webhook v1 envelopes     |
| `vendor/whooshbang-rc5`, `vendor/notifications-c0`, and `contracts/vendor/` | Pinned artifacts governed by contract locks |

The pinned WhooshBang archives are supply-chain inputs, not ordinary JSON
fixtures. Their immutable hashes, contents, and install behavior are enforced by
the WhooshBang contract lock and must not be added to a fixture manifest.

## Review checklist

Before committing a fixture:

1. inspect the staged diff as if the repository were already public;
2. verify every value is necessary and synthetic;
3. update the nearest manifest and capability evidence when applicable;
4. add positive, malformed, oversized, duplicate, stale, and isolation cases
   appropriate to the contract; and
5. run `pnpm fixtures:check`, the focused contract tests, and `pnpm check`.

If safe sanitization is uncertain, do not publish the payload. Describe the
shape privately to a maintainer and build a smaller synthetic reproduction.
