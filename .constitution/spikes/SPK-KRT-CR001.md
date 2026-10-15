# Spike report: KRT-CR001 branch head after a cold crash mid-iterate

## Effort budget

- **Budget:** 2 story points, the effort assigned to KRT-CR001.
- **Spent:** 2 story points. The research covered every certified kernel implementation, the shared authority, the framework recovery path, and both tool-result staging paths.
- **Cut:** Nothing. The evidence answers every acceptance question.

## Question

- **Owner:** KRT-CR001.
- **Decision:** Define the durable state that stale-running recovery gives the framework after a process dies mid-`iterate`. Define how recovery matches each original `callId` to a fulfilled result.

## Decision summary

Every official kernel covered by `tuvren.kernel.run-liveness` produces the same shape after a successful stale-running preemption:

- The kernel creates a reactive-checkpoint `TurnNode` and advances the Branch head to that node.
- The node's `consumedStagedResults` contains the assistant message and every tool-result message that the dead run staged.
- `RecoveryState.lastTurnNodeHash` equals the Branch head.
- `RecoveryState.uncommittedStagedResults` is empty.
- The stale Run is `failed`, its `preemptionReason` is `stale_running_recovery`, and its lease is cleared.

The conformance plan requires this shape. Its stale-preemption check requires zero uncommitted results, a recovery head equal to the Branch head, and preservation of the staged `assistant_message` task (`spec/conformance/kernel/plans/kernel-run-liveness.json:62-105`). All seven certified implementations pass that check:

- TypeScript memory: `reports/compatibility/evidence/certification-harness.kernel-typescript-certification.json:2870-2977`.
- TypeScript SQLite: `reports/compatibility/evidence/certification-harness.kernel-typescript-sqlite-certification.json:3229-3336`.
- TypeScript PostgreSQL: `reports/compatibility/evidence/certification-harness.kernel-typescript-postgres-certification.json:3360-3467`.
- Rust: `reports/compatibility/evidence/certification-harness.kernel-rust-certification.json:2385-2390`.
- Go: `reports/compatibility/evidence/certification-harness.kernel-go-certification.json:2870-2977`.
- Python: `reports/compatibility/evidence/certification-harness.kernel-python-certification.json:2870-2977`.
- Dart: `reports/compatibility/evidence/certification-harness.kernel-dart-certification.json:2870-2977`.

The stop condition doesn't apply. No official kernel loses both committed and recoverable staged assistant work.

## Authority basis

The machine-readable kernel packet registers `tuvren.kernel.run-liveness` version `0.3.0` (`spec/kernel/authority-packet.json:50-65`). Its binding projections name TypeScript, Rust, Go, Python, and Dart as the official kernel lines (`spec/kernel/authority-packet.json:82-87`). The certification fleet adds the three TypeScript backends and one project for each other language (`tools/conformance/certification/certified-projects.json:7-13`). Each adapter advertises `kernel.run-liveness`:

- TypeScript memory: `typescript/kernel/conformance-adapter/adapter.json:11-25`.
- TypeScript SQLite: `typescript/kernel/conformance-adapter/adapter-sqlite.json:11-25`.
- TypeScript PostgreSQL: `typescript/kernel/conformance-adapter/adapter-postgres.json:11-25`.
- Rust: `rust/kernel-conformance-adapter/adapter.json:11-17`.
- Go: `go/kernel-conformance-adapter/adapter.json:11-18`.
- Python: `python/kernel-conformance-adapter/adapter.json:11-27`.
- Dart: `dart/kernel-conformance-adapter/adapter.json:11-18`.

The kernel specification defines reactive checkpointing for unanchored staged work (`docs/KrakenKernelSpecification.md:504-514`). It defines recovery as committed `consumedStagedResults` plus durable, uncommitted `uncommittedStagedResults` (`docs/KrakenKernelSpecification.md:516-541`, `docs/KrakenKernelSpecification.md:598-607`). Recovery can't expose the same work as both committed and uncommitted (`docs/KrakenKernelSpecification.md:500-502`).

Framework recovery must derive unfinished calls from committed or recovered staged state. It must skip completed calls by `callId` (`docs/KrakenFrameworkSpecification.md:1011-1027`). The crash-recovery flow likewise requires the recovered runtime to distinguish committed work from incomplete work (`.constitution/architecture/flows/flow-crash-mid-checkpoint-recovery.md:22-33`). The preemption flow requires a replacement owner to present the original `(turnId, callId)` identity (`.constitution/architecture/flows/flow-preemption-idempotent-side-effect.md:22-38`). ADR-0065 makes `(turnId, callId)` the logical call identity and records cold recovery as its open obligation (`.constitution/tech-spec/adrs/ADR-0065-idempotency-identity-is-call-identity-not-authority-epoch.md:19-30`). ADR-0052 requires recovery to use durably staged results by `callId` (`.constitution/tech-spec/adrs/ADR-0052-side-effect-once-under-preemption-idempotency-envelope.md:10-15`).

## Measured kernel results

The following table records implementation evidence in addition to the shared conformance result.

| Official kernel | Measured preemption behavior | Head after preemption |
| :--- | :--- | :--- |
| TypeScript memory | `preemptExpired` loads staged results, passes them to `maybeCheckpoint`, returns the created node's consumed results, and returns an empty uncommitted list (`typescript/kernel/runtime/src/lib/runtime-kernel-runs.ts:438-505`). `maybeCheckpoint` clears staging after the checkpoint (`typescript/kernel/runtime/src/lib/runtime-kernel-lineage.ts:1011-1027`). | Reactive-checkpoint node is the Branch head. Recovery points to it. Assistant and partial tool results are committed. |
| TypeScript SQLite | Uses the same runtime implementation as memory. The adapter selects the SQLite backend and advertises run liveness (`typescript/kernel/conformance-adapter/adapter-sqlite.json:11-25`). The shared scenario compares the recovery head with the Branch head and counts uncommitted results (`typescript/kernel/conformance-adapter/src/host.ts:1583-1656`). | Same committed-head shape; `uncommittedStagedResults` is empty. |
| TypeScript PostgreSQL | Uses the same runtime implementation as memory. The adapter selects PostgreSQL and advertises run liveness (`typescript/kernel/conformance-adapter/adapter-postgres.json:11-27`). The shared scenario runs through the configured backend (`typescript/kernel/conformance-adapter/src/host.ts:1583-1663`). | Same committed-head shape; `uncommittedStagedResults` is empty. |
| Rust | Preemption incorporates all staged results, creates a node, updates head references, clears staging, and returns the node as recovery with an empty uncommitted list (`rust/kernel/src/memory.rs:1024-1136`). The adapter projects the consumed task IDs and head equality (`rust/kernel-conformance-adapter/src/main.rs:785-860`). | Reactive-checkpoint node is the Branch head. Recovery points to it. Assistant and partial tool results are committed. |
| Go | `PreemptStaleRun` drains staging and checkpoints it before marking the Run failed (`go/kernel/lease.go:176-250`). `RecoveryState` reads consumed results from the active node and any remaining staging (`go/kernel/kernel_runtime.go:1085-1112`). The preservation test asserts an advanced head, consumed `assistant_message`, empty staging, and recovery-head equality (`go/kernel/lease_and_recovery_test.go:475-504`). | Reactive-checkpoint node is the Branch head. Recovery points to it. Assistant and partial tool results are committed. |
| Python | `preempt_stale` incorporates staged results, commits the checkpoint, records the node on the Run, clears staging, and then fails the Run (`python/kernel/src/tuvren_kernel/runtime.py:804-940`). `recover` returns the Run's last node and remaining staging (`python/kernel/src/tuvren_kernel/runtime.py:1285-1303`). The test asserts consumed `assistant_message`, empty staging, and head equality (`python/kernel/tests/test_run_liveness.py:254-296`). | Reactive-checkpoint node is the Branch head. Recovery points to it. Assistant and partial tool results are committed. |
| Dart | `preemptStaleRun` drains staging and commits it before failing the Run (`dart/kernel/lib/src/lease.dart:155-222`). `recoveryState` reads the active node and remaining staging (`dart/kernel/lib/src/kernel_runtime.dart:1129-1149`). The test asserts the message object in the committed tree and an empty uncommitted list (`dart/kernel/test/lease_test.dart:215-248`). | Reactive-checkpoint node is the Branch head. Recovery points to it. Assistant and partial tool results are committed. |

### Can `uncommittedStagedResults` be non-empty?

For a successful `preemptExpired` operation in an official kernel, no. Each implementation checkpoints and clears staging before returning recovery state. The shared plan fixes the returned count at zero (`spec/conformance/kernel/plans/kernel-run-liveness.json:75-104`).

The protocol still permits a non-empty list outside this successful preemption result. `RecoveryState` contains separate committed and uncommitted arrays (`spec/kernel/cddl/kernel-records.cddl:152-158`). An ordinary crash before checkpoint can leave durable staging, as kernel recovery class 2 describes (`docs/KrakenKernelSpecification.md:520-525`). Framework lifecycle conformance also exercises an ordinary recovery result with one uncommitted message (`spec/conformance/engine/plans/runtime-api-lifecycle.json:152-185`).

KRT-CR002 must therefore support both protocol-valid input shapes in its recovery-plan unit tests. Its real stale-preemption characterization test must expect the committed-head shape. A failed or torn preemption doesn't establish a successful `preemptExpired` return with uncommitted results; the kernel must finish or reconcile that checkpoint first.

## Fulfillment matching rule

Fulfillment is an exact `callId` join over decoded durable messages:

1. Read committed message objects from the recovered Branch head. Also read message objects referenced by `RecoveryState.uncommittedStagedResults`, when that array is non-empty.
2. Fetch each object through `store.get`, decrypt it through the configured payload codec, and decode it as a `TuvrenMessage`. The existing committed-head path performs those steps in `loadHeadState` (`typescript/runtime/src/lib/runtime-core-head-state.ts:61-102`) and `readMessage` (`typescript/runtime/src/lib/runtime-core-head-state.ts:317-362`). KRT-CR002 must use the same codec seam for uncommitted objects (`typescript/runtime/src/lib/payload-codec-seam.ts:59-91`).
3. Read original calls only from decoded assistant-message parts whose `type` is `tool_call`. Read fulfilled IDs only from decoded tool-message parts whose `type` is `tool_result`.
4. Mark an original call fulfilled when any durable `ToolResultPart.callId` exactly equals its `ToolCallPart.callId`. Dispatch only original call IDs absent from that fulfilled set.

The contract gives both part types the same required `callId` field (`spec/core/typespec/main.tsp:60-75`). The runtime's existing tool-call extractor also reads assistant parts by type and retains their `callId` values (`typescript/runtime/src/lib/runtime-core-iteration.ts:441-462`).

Never infer fulfillment from `StagedResult.taskId`. The kernel record contains `taskId`, `objectHash`, and `objectType`, but no call identity field (`spec/kernel/cddl/kernel-records.cddl:84-100`). The main execution path writes `tool_result_<orderIndex>_<callId>` (`typescript/runtime/src/lib/runtime-core-hosts.ts:955-963`). The approval-resume path writes `tool_message_<zero-padded-orderIndex>_<callId>` (`typescript/runtime/src/lib/runtime-core-tool-resume.ts:515-523`, `typescript/runtime/src/lib/runtime-core-response.ts:43-54`). Parsing either string would couple recovery to two inconsistent implementation details. The decoded `ToolResultPart.callId` is the contract.

After KRT-CR003 resumes a missing call, its dispatch must use `deriveIdempotencyKey(turnId, callId)`. The derivation is the canonical JSON array of those two values hashed with SHA-256 (`typescript/runtime/src/lib/idempotency-identity.ts:56-63`). The tool execution context calls that function directly (`typescript/runtime/src/lib/tool-execution-helpers.ts:191-216`).

## Exact characterization test for KRT-CR002

KRT-CR002 must extend the stale-iterate recovery seam in `typescript/runtime/test/runtime-core.recovery.test.ts:357-452`. The test must use the configured payload codec for every staged message so that it exercises the same bytes as runtime persistence.

The test must perform these steps:

1. Create a thread and Turn. Commit the matching user signal before the stale iteration so the iteration Run starts from a head that already contains the user message.
2. Create a leased Run on that Turn and Branch with one step: `{ id: "iterate", deterministic: false, sideEffects: true }`. Begin the step. Set its lease to expire under the injected clock.
3. Stage one assistant message with three ordered `tool_call` parts. Give them stable IDs `call_completed_main`, `call_completed_second`, and `call_missing`.
4. Stage a tool message for `call_completed_main` with task ID `tool_result_0_call_completed_main`.
5. Stage a tool message for `call_completed_second` with task ID `tool_result_1_call_completed_second`.
6. Leave `call_missing` without a result. Don't call the iteration artifact completion path. This omission models process death after partial tool execution. It also leaves the iteration manifest and iteration runtime status unstaged because those writes occur after the tool batch (`typescript/runtime/src/lib/runtime-core-iteration.ts:795-840`, `typescript/runtime/src/lib/runtime-core-runner.ts:454-503`).
7. Advance the clock beyond lease expiry. Start a fresh runtime instance over the same kernel and codec, then call `executeTurn` with the same signal.
8. Capture the `RecoveryState` returned by the preemption call before the runtime continues.

Before the replacement iteration runs, the test must assert this recovered shape:

- The stale Run is `failed`, has reason `stale_running_recovery`, and has no lease.
- `recovery.lastTurnNodeHash` equals the Branch head.
- `recovery.uncommittedStagedResults` is empty.
- `recovery.consumedStagedResults` contains the staged assistant message and both staged result messages in staging order.
- Reading the Branch messages through the runtime's durable read path returns the original user message, the original assistant message, and the two tool messages in order.
- Decoding the two tool messages yields fulfilled IDs `call_completed_main` and `call_completed_second`. `call_missing` remains the only missing ID.
- No iteration manifest or iteration runtime-status update from the dead iteration appears at the recovered head.

In a separate constructed recovery-plan case, reuse the same decoded tool result under task ID `tool_message_000001_call_completed_second`. The fulfilled set must remain unchanged. This case isolates the approval-resume task-ID spelling without making the mid-iterate crash reproduce an approval resume that belongs to another Run.

KRT-CR002 characterizes the behavior before resume is implemented. After recovery, it must assert that the runner executes for the recovered iteration and emits a replacement assistant call with a `callId` different from all three original IDs. It must also assert that the runtime doesn't dispatch `call_missing`. The present flow classifies an `iterate` crash as `skip_fresh_prelude` (`typescript/runtime/src/lib/runtime-core-recovery.ts:274-303`), then enters the ordinary loop (`typescript/runtime/src/lib/runtime-core-startup.ts:324-335`, `typescript/runtime/src/lib/runtime-core-loop.ts:292-298`) and calls the runner (`typescript/runtime/src/lib/runtime-core-iteration.ts:654-688`). KRT-CR003 flips these assertions: the runner isn't called for that recovered iteration, and only `call_missing` is dispatched with its original identity.

## Options and trade-offs

### Treat preemption recovery as uncommitted staging

This option follows the issue's original assumption and reads only `uncommittedStagedResults`. It fails on all official kernels because successful preemption returns that list empty. It would miss the committed assistant and tool-result messages.

### Treat preemption recovery as committed history only

This option matches every official stale-preemption implementation and the shared conformance plan. It is insufficient as the only recovery-plan input because the protocol and framework specification also permit ordinary recovery with durable uncommitted staging.

### Normalize both durable shapes

This option reads decoded committed messages and decoded uncommitted staged message objects into one recovery plan. It matches measured stale-preemption behavior and preserves the broader recovery contract. It also keeps the fulfillment rule independent of staging task IDs.

## Recommendation

KRT-CR002 must normalize both durable shapes. For the real expired-run path, it must build the plan from the committed reactive-checkpoint head returned by preemption. For constructed protocol-valid states, it must also accept uncommitted staged messages.

Use only durable message bytes decoded through the configured codec. Match completion by `ToolResultPart.callId`. Preserve the original assistant message and its `ToolCallPart.callId` values. If no durable assistant tool-call message exists, retain model re-inference for a crash during the model stream. If the interrupted assistant payload is missing or erased, fail explicitly as KRT-CR002 specifies.

## Downstream impact

- **ADRs to update:** None in KRT-CR001. KRT-CR003 closes ADR-0065 open obligation 1. The epic's spec-only milestone updates ADR-0065 and ADR-0052 after implementation evidence exists.
- **Tickets unblocked:** KRT-CR002.
- **Register entry closed:** None.
- **Tickets to add or split:** None for the recovery implementation.
- **Spec edits required by this decision:** None before implementation. KRT-CR005 amends framework specification section 4.9 and the owned lifecycle authority after conformance coverage lands.

## Recorded drift

The required kernel authority packet contains a stale narrative. Its run-liveness description says the idempotency identity uses `(runId, callId, fencingToken)` (`spec/kernel/authority-packet.json:96-97`). ADR-0065 replaced that tuple with `(turnId, callId)` (`.constitution/tech-spec/adrs/ADR-0065-idempotency-identity-is-call-identity-not-authority-epoch.md:19-24`), and the framework specification uses the replacement tuple (`docs/KrakenFrameworkSpecification.md:991-1000`). This drift doesn't change the measured crash-head shape. `spec/kernel/` is outside EPIC-CR scope, so this spike records the conflict for upstream routing and doesn't edit the packet.
