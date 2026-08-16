# AR5.11: Qualify the complete local operator experience

- **Linear:** FXO-1611
- **Status:** In progress (local qualification evidence retained; repository
  gate pending)
- **Started:** 2026-08-16
- **Platform:** native macOS arm64 (Darwin 25.5.0), Node.js 22.23.1 arm64 for
  livechecks; everyday toolchain Node 23.10.0 x64 for Vitest/Playwright matching
  installed optional deps
- **Frozen harnesses:** Codex CLI `0.145.0`, Claude Code `2.1.219`, Cursor CLI
  `2026.07.23-e383d2b`
- **TUI:** Ink 7.1.1 / React 19.2.8 (do not reopen OpenTUI)

## Outcome

Bounded, credential-free qualification of the complete local operator journey
across install lifecycle, web, TUI, and frozen harness activation. Material
Claude activation defects found against the frozen CLI were fixed and committed
locally. Everyday daemon on `127.0.0.1:4317` was never mutated; isolated
`web-demo` on `127.0.0.1:4318` / `~/.agent-relay/web-demo` was used for surface
checks.

## Machine-readable evidence

Ignored under `.artifacts/fxo-1611/` (sanitized; no credentials, prompts, or
transcripts):

| Artifact                                                 | Result                                          |
| -------------------------------------------------------- | ----------------------------------------------- |
| `machine/environment.json`                               | host/runtime observation                        |
| `machine/provision-harnesses.log`                        | frozen darwin/arm64 harness provision           |
| `machine/tui-reconnect-livecheck.json`                   | kill 4318 → reconnecting → press `r` → online   |
| `captures/tui-reconnect-livecheck.txt`                   | sanitized reconnect frames                      |
| `machine/web-tui-parity.json`                            | shared projects/attention/current online parity |
| `captures/tui-parity-frame.txt` / `tui-narrow-frame.txt` | sanitized TUI frames                            |
| `machine/browser-e2e.log`                                | Chromium E2E 22/22 passed                       |
| `machine/package-integrations-frozen.log`                | packed vendor lifecycle with frozen PATH        |
| `machine/usability-scenarios.json`                       | eight operator scenarios                        |

## Usability scenarios (new operator)

| #   | Scenario                                             | Result | Notes                                                       |
| --- | ---------------------------------------------------- | ------ | ----------------------------------------------------------- |
| 1   | Install/configure without hand-editing               | pass   | `integrations install` with frozen Claude/Codex             |
| 2   | Open TUI or web through discoverable command         | pass   | `dashboard`, `dashboard --web`, `--json`, `--demo`          |
| 3   | Identify project and exact session needing attention | pass   | web + TUI rail/attention                                    |
| 4   | Distinguish canonical activity states                | pass   | observed `working`, `needs_input`, `idle`, `failed` on demo |
| 5   | Answer structured question to exact session          | pass   | browser E2E + operator-question e2e; TUI bind by requestId  |
| 6   | Disconnected/muted ≠ execution state                 | pass   | TUI reconnect labels keep last snapshot                     |
| 7   | Recover stopped daemon / expired browser session     | pass   | livecheck + browser E2E restart/recovery                    |
| 8   | Uninstall without damaging unrelated config          | pass   | packed vendor lifecycle preservation                        |

## Findings closed

1. **Claude frozen activation used unsupported `-y`** on `plugin install` for
   Claude Code 2.1.219 (`unknown option '-y'`). Fixed: install without `-y`,
   retry with `-y` only when a newer CLI demands non-TTY confirmation.
2. **Settings.json alone does not load the local marketplace** on 2.1.219.
   Fixed: `claude plugin marketplace add <owned-root>` before install; remove
   marketplace on uninstall.
3. **Disable failed when Claude already reported disabled.** Fixed: treat
   “already disabled/installed/not found” as success.
4. **`resolveCommand` used a login shell (`-lc`)** that can rewrite PATH. Fixed:
   use `-c` with the current process PATH.
5. **TUI interactive reconnect live-check** (kill 4318, press `r`) was missing
   from FXO-1609. Added store-level integration coverage plus
   `scripts/fxo-1611-tui-reconnect-livecheck.mjs`.

## Acceptance mapping

- Repository gate: `pnpm check:pr` passed (16 checks) after these fixes.
- Each frozen harness journey: provisioned exact versions; vendor package
  lifecycle exercised against them.
- Web/TUI same projects/attention/states: parity evidence pass.
- Concurrent same-project isolation: `operator-question-e2e` pass.
- Install/reinstall/repair/disable/uninstall preservation: packed vendor check
  pass.
- Accessibility / narrow / reconnect / large-data: browser E2E + TUI frames +
  reconnect livecheck.
- Docs: `docs/vendor-integrations.md` updated for Claude marketplace add.
- No live Telegram/provider traffic; no publication or registry mutation.

## Unclaimed

- Real Telegram or vendor-provider canary (requires separate owner
  authorization).
- Vendor marketplace/directory publication (FXO-1614).
- Raising the product Node engines floor (stays `>=22`).
- Reopening Ink vs OpenTUI.
