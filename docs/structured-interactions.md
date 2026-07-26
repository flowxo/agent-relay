# Structured interaction contract

Agent Relay's provider-neutral structured interaction boundary is
`agent-interaction.v1`. It represents an operator decision without Telegram
callback data, harness commands, provider credentials, transcripts, or machine
paths.

## Version 1 shapes

`agent-interaction-request.v1` contains one stable request ID, creation and
expiry timestamps, an ordered array of one through ten questions, and an
explicit presentation fallback policy. The supported question kinds are:

- `confirm`, with distinct stable confirm and decline option IDs;
- `single-select`, with two through twenty stable options;
- `multi-select`, with two through twenty options and explicit minimum and
  maximum selection counts; and
- `free-text`, with explicit length and multiline bounds.

Question IDs are unique within a request. Option IDs are unique across the
entire request, not merely within one question. The array is the deterministic
question order. Version 1 requires one final answer for every question; partial
answers belong to durable draft state and are not terminal answers.

`agent-interaction-answer.v1` contains a stable answer ID, the request ID,
submission time, and answers in request order. Runtime compatibility validation
rejects:

- another request or unknown question;
- a missing, duplicate, or reordered question answer;
- a question-kind mismatch;
- an unknown or duplicate option;
- a multi-select answer outside its declared selection bounds;
- free text outside its declared bounds; and
- an answer submitted before request creation or at/after expiry.

The request is capped at 32 KiB serialized. The answer is capped at 4,000 bytes
serialized so its canonical JSON can pass through the existing bounded pending
request, terminal command, and harness continuation path without truncation.
Individual free-text fields are capped at 3,000 characters; a mixed set may have
a smaller effective per-field budget because the final answer envelope is also
bounded.

## Lifecycle and durable authority

The shared lifecycle vocabulary is:

`pending → drafting → answered | expired | canceled | superseded | failed`

Every terminal state is immutable. A request may also move directly from
`pending` to a terminal state. Lifecycle records require an answer ID only for
`answered`, a replacement request ID only for `superseded`, and bounded failure
details only for `failed`.

The protocol does not create a second answer authority. A validated terminal
answer is encoded deterministically and committed through the existing SQLite
pending-request transition. The request ID is the existing correlation ID.
`RelayStore.resolveRequest` remains first-writer-wins, so Telegram, terminal,
and future hosted answers race through one durable row. Compatibility tests
close and reopen SQLite to prove the first terminal answer remains
authoritative. Draft persistence will extend this same request authority; it
will not resolve the parent request before Submit.

## Capabilities and fallback

`agent-interaction-capabilities.v1` provides a typed vocabulary for transport
and harness evidence:

- interaction features: confirm, single-select, multi-select, free-text, ordered
  sets, durable drafts, and message updates;
- presentation modes: buttons, direct text, numbered text, and local web
  handoff; and
- bounded provider limits for questions, options, text, and payload bytes.

Each request declares one preferred presentation plus an ordered, duplicate-free
fallback list. `reject` permits no alternatives; `use-alternative` requires at
least one. Later capability negotiation must choose from this declared order or
reject explicitly. It may not silently present an unsupported interaction.

## Relationship to Notifications contracts

[FXO-1048](https://linear.app/flowxo/issue/FXO-1048) will consume the exact
version-pinned `@flowxo/notifications-contracts` and `@flowxo/notifications`
artifacts after their C0-03/C0-05 dependencies publish them. Their draft
companion specification currently covers hosted `confirm`, `select`, and
`input`. Agent Relay does not copy that draft schema into this repository's
runtime contract.

The future adapter boundary is deliberately narrow:

| Agent Relay V1              | Notifications C0 projection |
| --------------------------- | --------------------------- |
| request ID                  | interaction correlation ID  |
| confirm                     | confirm                     |
| single-select               | select                      |
| free-text                   | input                       |
| option ID and label         | opaque value and label      |
| request expiry              | interaction/message expiry  |
| multi-select or ordered set | negotiated fallback/reject  |

Multi-select and ordered sets must not be flattened into an ambiguous C0
single-select answer. Until the pinned hosted contract advertises equivalent
capability, the declared numbered-text or local-web fallback applies, or the
request is rejected. A hosted response remains evidence only: Agent Relay
validates local request identity, question kind, options, ordering, and expiry,
then commits through the existing local first-writer-wins transition.

## Telegram single-choice projection

The tested Telegram boundary is Bot API 10.2. The current official
[InlineKeyboardButton](https://core.telegram.org/bots/api#inlinekeyboardbutton)
contract limits `callback_data` to 1–64 bytes, and
[CallbackQuery](https://core.telegram.org/bots/api#callbackquery) requires the
bot to answer a callback so the client can clear its progress indicator.
Telegram documents inline keyboards as arrays of button rows but does not
publish a total button-count limit.

Agent Relay therefore applies a product-level compactness budget:

- two through ten options render as inline buttons, two per row;
- callback data is `relay:` plus a random `decision_` token, bounded to 63 ASCII
  bytes; labels, option IDs, request IDs, paths, and credentials are never
  callback data;
- eleven through twenty options render as a numbered list with no choice
  buttons; the operator replies with one displayed number in the exact session
  topic or explicitly replies to the request card; and
- more than twenty options are rejected by the versioned protocol rather than
  being truncated.

The numbered fallback retains every option and uses the same durable option-ID
mapping as a button. Plain topic text is accepted only when the topic has one
eligible free-text, continuation, or numbered-choice request. An invalid number
leaves the request open and produces bounded guidance. An explicit reply may
identify the oversized request even when other requests are pending.

A button callback is authorized against the configured operator and chat, then
bound to the retained option token, delivered message ID, transport, session
identity, and ready topic ID. SQLite commits the first valid option ID before
`answerCallbackQuery` is called. The card is then edited to remove its keyboard
and show both terminal state and the selected label. Duplicate, expired,
unknown, malformed, wrong-topic, and cross-session callbacks never replace the
durable first answer.

## Telegram multi-select drafts

A one-question `multi-select` request projects to checkable option buttons plus
**Submit** and **Cancel**. SQLite creates the draft at event ingestion, before
delivery, with random submit/cancel tokens, explicit minimum and maximum
selection counts, a revision, and an ordered set of selected option IDs.

Option callbacks encode a desired state—select or unselect—not a blind toggle.
Repeating the same Telegram update is ignored by the durable update claim;
repeating a set/unset action under a different callback is an idempotent no-op.
Independent concurrent selections can both commit, while a selection beyond the
maximum is rejected without changing the draft. Each successful change edits the
card to show checkmarks and the current selection count.

Submit runs one SQLite transaction that rechecks request identity, delivered
message, expiry, lifecycle, and selection bounds. A valid ordered option-ID
array is encoded as bounded JSON and wins the existing pending-request
first-writer transition. The draft becomes `submitted` in that same transaction
before Telegram is acknowledged. If a terminal or another provider answered
first, the draft becomes `superseded` and cannot replace the answer.

Cancel is a distinct terminal transition: the pending request and draft become
`cancelled`, the answer remains null, and no empty selection is sent to the
harness. Submitted, canceled, expired, superseded, and failed cards remove their
controls and retain the selected labels for auditability.

Drafts and selections survive daemon restart in SQLite. Expiry synchronizes the
parent request and draft. Retention deletes terminal drafts with their parent
requests under the existing bounded maintenance limit and reports an
`interactionDrafts` count so cleanup is observable.

## Telegram ordered question sets

A `question-set` request projects to one in-place Telegram wizard card. SQLite
creates the complete ordered step ledger before delivery: stable question
ordinals, one current index, per-step Back/Next tokens, request-level Submit and
Cancel tokens, a revision, and answer rows keyed by stable question ID.

Confirm and single-select steps use one-choice buttons. Multi-select steps use
the same desired-state set/unset behavior as standalone drafts. **Next** is
available only for the current non-final step and refuses to advance until that
step has a valid answer. **Back** returns to the preceding step without dropping
later draft answers, so an operator can review and revise earlier choices.
Step-specific navigation tokens make a repeated old Next callback an explicit
invalid transition instead of accidentally skipping another question.

**Submit** is accepted only from the final step and only when every ordered
answer validates against the original provider-neutral request. One SQLite
transaction materializes any valid zero-selection answer, encodes the complete
`agent-interaction-answer.v1` envelope, wins the existing first-writer request
transition, and marks the wizard submitted before Telegram is acknowledged.
Partial drafts never resolve the parent request.

Cancel, expiry, terminal-first supersession, invalid transitions, selection
limit failures, and missing answers are explicit outcomes. Terminal cards remove
their controls but retain the ordered partial or final answer summary for
diagnosis. Drafts resume at the exact question and revision after daemon
restart; retention reports deleted parents and `questionSetDrafts` separately.
Callback authorization binds every action to the operator, chat, transport,
delivered message, session, and ready topic, so simultaneous wizards cannot
cross-answer.

Free-text questions are valid in the shared contract, but their Telegram capture
mode is intentionally completed by FXO-1064. Until then the wizard identifies a
free-text step as requiring text and refuses to advance or submit rather than
silently discarding it.

## Fixtures and compatibility

Sanitized fixtures live in `packages/protocol/fixtures/interactions`. They
contain a mixed ordered question set, its compatible answer, provider
capabilities, and a privacy/evidence manifest. Tests parse those files at
runtime and cover malformed, oversized, duplicate-ID, empty-option, stale, and
incompatible variants. All fixture content and identifiers are synthetic.

Sanitized Telegram Bot API 10.2 projections live in
`packages/core/fixtures/telegram`, including single-choice, multi-select, and
ordered question-set keyboards. Tokens, chat IDs, and content are synthetic;
credentials are never part of a fixture.
