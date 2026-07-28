# AR1.2: Public product documentation

- **Linear:** FXO-1143
- **Status:** Implemented and locally verified
- **Implemented:** 2026-07-26

## Outcome

The repository landing page now explains the problem, evidence classes,
supported platform/runtime, harness continuation limits, local components,
outbound boundary, hook files, fake-first proof, uninstall, and private security
path without requiring the long control-plane design.

Nine focused public guides cover:

- architecture and threat boundaries;
- install, upgrade, uninstall, and erasure;
- direct Telegram;
- the local web companion;
- troubleshooting and doctor;
- compatibility and evidence;
- transport extensions;
- harness-adapter extensions; and
- the optional hosted Notifications boundary.

The living onboarding guide now uses the scripts-disabled install, exact
Notifications preflight, and approved native rebuild sequence before the quality
gate. The web API and evidence ledger link the public interpretation to the
detailed versioned contract and source evidence.

## Evidence

Current primary Codex, Claude Code, Cursor, and Telegram documentation was
rechecked on 2026-07-26. Public claims remain narrower than documented upstream
capability: exact local versions, sanitized fixtures, fake canaries, and bounded
live canaries determine `verified` behavior.

`pnpm docs:check` verifies the focused set, local Markdown links, key product
and threat-boundary statements, fake-canary-first order, hosted optionality, and
absence of token shapes, numeric Telegram identities, or real user paths. It is
part of `pnpm check`.

Packaging commands deliberately remain source-build-only until FXO-1144 proves
the exact publish artifact and package-scope owner confirms the registry name.
FXO-1146 will replace the current two-source capability/evidence interpretation
with one generated classified support summary.
