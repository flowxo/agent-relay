# Generated Harness Capability Matrix

<!-- Generated from packages/harnesses/src/capabilities.ts. -->

| Harness | Surface    | Stop | Inline continue | Permission decision | Late resume | Active steer | Failure signal | Process exit proof | Notes                                                                    |
| ------- | ---------- | ---- | --------------- | ------------------- | ----------- | ------------ | -------------- | ------------------ | ------------------------------------------------------------------------ |
| codex   | cli        | Yes  | Yes             | Yes                 | Yes         | No           | No             | No                 | Late resume uses codex exec resume; crash proof requires supervision.    |
| codex   | app-server | Yes  | Yes             | Yes                 | Yes         | Yes          | Yes            | No                 | App Server exposes thread resume, turn start, steer, and completion.     |
| claude  | cli        | Yes  | Yes             | Yes                 | Yes         | No           | Yes            | No                 | StopFailure is observable; process crashes still require supervision.    |
| claude  | sdk        | Yes  | Yes             | Yes                 | Yes         | Yes          | Yes            | No                 | Streaming SDK input can steer an owned active session.                   |
| cursor  | cli        | Yes  | Yes             | Yes                 | Yes         | No           | Yes            | No                 | Interactive CLI Stop and --resume are proven; --print did not emit Stop. |
| cursor  | ide        | Yes  | Yes             | Yes                 | No          | No           | Yes            | No                 | Returned IDE stop hooks cannot be resumed safely through Cursor CLI.     |

A `No` for process exit proof is intentional: native hooks cannot prove a crash.
That capability becomes true only for sessions owned by the Milestone 3
supervisor.
