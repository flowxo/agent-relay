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
least one.

Before delivering a structured request, the relay now validates one
`agent-interaction-provider-observation.v1` for the transport and derives a
version-scoped harness observation from the validated attention event.
Observations distinguish `proven` behavior from `assumed` behavior and record
their evidence class, observed version, sanitized fixture, and official
documentation where applicable. Assumed capability records cannot activate an
interaction.

Negotiation derives the required question features and bounds, verifies that the
harness can accept a continuation (and a permission decision when applicable),
then tries only the request's declared modes in order. The selected mode is
persisted on the SQLite draft before transport delivery, so restart and
subsequent message edits cannot change presentation silently. The implemented
Telegram modes are:

- `buttons` for compact confirm, single-select, and multi-select steps, with
  topic-bound text on mixed free-text steps;
- `direct-text` for sets containing free-text steps, with compact buttons for
  companion choice steps; and
- `numbered-text` for confirm/single-select sets, including ordered sets.

An oversized single-select first rejects the compact button attempt, then may
use numbered text only when that alternative was declared. The displayed number
maps back to the current step's durable option token and remains bound to the
exact request, delivered card, session, and topic. It updates the draft but does
not bypass final Submit.

`web-handoff` is now implemented by the authenticated loopback companion, not by
pretending the Telegram or fake notification transport gained a new presentation
mode. Those transports still do not advertise it, and their delivery negotiator
still rejects a synthetic transport claim. The local web read model
independently projects the retained provider-neutral contract when the harness
can continue. A notification transport without a valid typed record, an assumed
record, an incapable harness, a provider-limit violation, or an exhausted
fallback list is still dead-lettered with a durable diagnostic before any
interactive card is sent.

## Relationship to Notifications contracts

[FXO-1048](https://linear.app/flowxo/issue/FXO-1048) consumes the exact
version-pinned `@flowxo/notifications-contracts`, `@flowxo/notifications`, and
executable mock `1.0.0-rc.1` tarballs through the immutable consumer fixture
under `vendor/notifications-c0`. The focused gate revalidates their
owner-produced SHA-256 digests before running. Agent Relay does not copy that
schema or generated type into its runtime contract, and CI has no
sibling-checkout dependency.

The adapter boundary is deliberately narrow:

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

The canonical delivery boundary now carries one optional `DeliveryInteraction`;
the earlier top-level `correlationId` and `choices` aliases are removed. Direct
Telegram renders the same opaque values as before. The hosted adapter accepts at
most the pinned Notifications select limit and fails before HTTP for wider
selects, multi-select, or ordered sets so their declared local fallback remains
authoritative.

Hosted answer validation is a pure pre-SQLite step. It requires schema,
signature, authenticated stream, configured machine, hosted message/interaction,
correlation, local machine/harness/session/turn, local kind/choice, occurrence,
and expiry evidence. The consumer harness then uses the existing
`RelayStore.resolveRequest` transaction with resolution source `notifications`.
SQLite commit or a safe durable quarantine precedes hosted acknowledgement.
Crash-before-ack replay resolves no second local answer or resume command.

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
`answerCallbackQuery` is called. The callback acknowledgement and compact
`✅ <selected label>` edit then start together, removing the stale keyboard
without waiting for continuation or delivery work. Duplicate, expired, unknown,
malformed, wrong-topic, and cross-session callbacks never replace the durable
first answer or receive a false success checkmark.

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
harness. Accepted Submit and Cancel actions replace the controls with
`✅ Submit` or `✅ Cancel`; rejected and externally superseded actions retain an
explicit terminal status instead. The selected option IDs remain in the durable
draft for auditability even though the compact terminal Telegram message does
not repeat them.

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
limit failures, and missing answers are explicit outcomes. Accepted terminal
buttons remove their controls and collapse to `✅ <button label>`; stale,
expired, failed, and externally superseded actions retain an explicit terminal
summary for diagnosis. The ordered answers remain durable even when Telegram
uses compact accepted feedback. Drafts resume at the exact question and revision
after daemon restart; retention reports deleted parents and `questionSetDrafts`
separately. Callback authorization binds every action to the operator, chat,
transport, delivered message, session, and ready topic, so simultaneous wizards
cannot cross-answer.

## Telegram free-text capture

An active free-text step visibly shows the interaction title, question ordinal,
prompt, minimum and maximum length, multiline policy, and whether a draft is
already saved. The operator can send ordinary text in the session topic when
that topic has exactly one compatible active text request. If several text
requests are open in the same topic, ordinary text is rejected as ambiguous and
an explicit reply to the intended request card identifies it.

Before persistence, carriage returns are normalized to line feeds and outer
whitespace is trimmed. Empty text, text outside the declared bounds, or multiple
lines for a single-line field are rejected without changing the draft. A second
valid message on the same active field replaces the prior draft; the same
normalized value is an idempotent no-op. Text received after the wizard moves to
another kind of question is out of order and cannot change an earlier answer.
Like button answers, text changes never resolve the parent request before final
Submit.

Private draft text is stored only in SQLite's `question_set_answers` row so it
can survive restart and become part of the validated terminal response. It is
not placed in callback data, diagnostics, daemon logs, or Telegram card edits;
cards show only that text is saved and its character count after resolution.
Submitted text also exists in the canonical pending-request answer used by the
harness. Canceled, expired, superseded, and submitted records follow the same
bounded request-retention window (30 days by default), after which the parent,
draft, and answer rows are deleted together. Telegram's retention of the
operator's original chat message is outside Agent Relay's local retention
control.

## Local web structured responses

The loopback companion projects the same stable questions and option IDs into
free-text, single-select, bounded multi-select, and ordered mixed question-set
forms. It does not mutate Telegram's durable wizard draft step by step. Instead,
it keeps unfinished browser values only in page memory, then submits one typed
terminal response. Standalone multi-select IDs are validated and reordered
against the retained request. Ordered sets are wrapped in
`agent-interaction-answer.v1` and passed through the shared compatibility
validator before their canonical JSON is committed.

Every submission carries a stable session key and durable operation ID.
Cross-session forms, reordered or missing question answers, duplicate or unknown
options, expired requests, and changed operation replays are rejected. The final
transition is still `RelayStore.resolveRequest`, so simultaneous Telegram,
terminal, and browser answers have one first-writer authority. Whichever surface
loses receives the terminal state without receiving or repeating the winner's
private answer. A browser winner removes controls from the interactive
notification card; edit failures preserve the committed answer and create a
sanitized durable diagnostic.

## Fixtures and compatibility

Sanitized fixtures live in `packages/protocol/fixtures/interactions`. They
contain a mixed ordered question set, its compatible answer, provider
capabilities, a Telegram Bot API 10.2 observation, and a privacy/evidence
manifest. Tests parse those files at runtime and cover malformed, oversized,
duplicate-ID, empty-option, stale, and incompatible variants. All fixture
content and identifiers are synthetic.

Sanitized Telegram Bot API 10.2 projections live in
`packages/telegram-transport/fixtures/telegram`, including single-choice,
multi-select, and ordered question-set keyboards. Tokens, chat IDs, and content
are synthetic; credentials are never part of a fixture.
