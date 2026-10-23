---
id: ADR-0077
status: accepted
date: 2026-10-22
certainty: assumed
assumption: "Synthesized from two independent designs after the owner directed genuine certification in the 2026-10-22 session; settles by ruling when the owner approves this pass."
---
### ADR-0077 Harness Orchestration for Concurrency and Live Streams

- **Status:** accepted. Moves the conformance adapter protocol from 0.1.0 to 0.2.0.
- **Context:** The runner awaits each dispatch before advancing (`tools/conformance/harness/run.ts:452`). The TypeScript stdio host handles requests serially and collects whole event iterables before replying (`tools/conformance/adapter-protocol/stdio-host.ts:85-95,258-270`). Plan steps therefore cannot express overlapping writers, cancellation during an operation, eager subscription, backpressure, or a deadline before completion. Writer races diverge today: TypeScript races two backends, Go, Python, and Dart run the second writer after the first returns, and cancellation is adapter-initiated.
- **Decision:**
  1. **Operation handles.** Protocol 0.2.0 adds `startOperation -> operationHandle`, `awaitOperation`, and `cancelOperation {handle, reason}`, alongside the existing blocking `dispatch`. Hosts must keep processing requests while operations run. Bindings with synchronous native APIs use native workers or scheduler hooks; concurrency at the IPC layer alone proves nothing.
  2. **Live streams.** `subscribe {handle, channel} -> subscription` and `pull {subscription, credit}`. Events arrive as notifications carrying `subscription`, `sequence`, and the raw event. A terminal notification is distinct from stream exhaustion and from RPC failure. The runner stamps arrival order and monotonic time on every frame. Batch `events()` remains only for families not yet migrated.
  3. **Plan step actions.** `steps[]` gains typed actions: `start`, `await`, `cancel`, `subscribe`, `pull`, `barrier`, `release`, and lifecycle controls (ADR-0076). Plans supply participants, predicates, ordering, and limits; the runner supplies scheduling. An `arrival` assertion compares harness-recorded arrival order across steps.
  4. **Barriers live only in reviewed test seams** inside the implementation's dependency or persistence path, never in adapter logic. They are placed outside exclusive locks so they cannot manufacture deadlocks.
  5. **Racing writers.** A plan establishes a common head, starts the contenders, proves their invocation intervals overlapped from harness timestamps, and asserts raw outcomes and lineage. Exactly one contender succeeds, the other observes the typed lateral conflict, and the head equals the winner. Durable backends race from two processes attached to one `storageRef`; memory implementations race two instances in one process. Plans exercise both contender orderings.
  6. **Cancellation and deadlines.** The runner cancels after an observed event or a dependency-entry receipt while completion is still gated, releases the gate, then checks for prohibited late writes or events. Native deadline expiry is distinguished from the runner watchdog ending an experiment, and elapsed time is recorded in evidence.
  7. **Backpressure.** Plans control sink capacity through `pull` credit and assert recorded upstream pulls, buffered frames, and bytes from implementation-side observations. Protocol credit alone only bounds harness transport and is not proof of native backpressure.
- **Alternatives considered:**
  - Fable proposed same-`group` concurrent dispatch with acknowledgement-based backpressure. Codex proposed explicit operation handles with pull credit and barriers. Handles and pull credit were chosen because they compose with cancellation and lifecycle controls and keep scheduling explicit in the trace. Fable's two-process race on shared durable storage and its `arrival` assertion were adopted.
  - Sleep-based races and collected-array stream checks. Rejected by both designs: scheduling changes hide defects, and collected arrays cannot show liveness or ordering against requests.
- **Consequences:** Assumed until observed. Every language binding must implement a concurrent host. Schedules and both orderings appear in evidence. Mutants that delay subscription, ignore cancellation, or buffer without bound (ADR-0079) confirm the primitives detect what they claim to.
