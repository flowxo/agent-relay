# Telegram transport

This private workspace package owns direct Telegram integration: Bot API
requests, topic delivery, callback codecs, authenticated update routing,
correlated replies, confirmed proven-dead topic cleanup, provider error
classification, confirmed inactive-topic pruning, and sanitized Bot API
fixtures. Operator maintenance commands echo their authenticated private-topic
context so controls and callbacks remain in the thread where the operator
started them.

It implements `@agent-relay/notification-contracts` and may depend inward on
core application/store services to submit a validated candidate answer. Core
does not import this package. `apps/relay` selects and assembles the adapter.
These internals remain part of the single bundled `@flowxo/agent-relay` CLI.
