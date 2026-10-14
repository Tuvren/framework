# Spike report: KRT-CR001 Branch head after a cold crash mid-iterate

## Effort budget

- **Budget:** 2 story points (the effort of ticket KRT-CR001); the research stops when the question is answered or the budget is spent, whichever comes first
- **Spent:** not started; filled by the worker during execution, in the same units, with one line on what was cut if the budget ran out

## Question

- **Owner:** KRT-CR001
- **Decision this spike must produce:** which durable state shapes stale-running recovery hands the framework after a process dies mid-`iterate`, and the rule that matches each original `callId` to a fulfilled result, so KRT-CR002 builds the recovery plan against observed state rather than against the issue's assumption that `uncommittedStagedResults` carries the work

## Context and objective

- **Triggering upstream file or section:** `docs/KrakenFrameworkSpecification.md` §4.9 (crash after model call, before tools; crash mid tool execution), and `.constitution/tech-spec/adrs/ADR-0065-idempotency-identity-is-call-identity-not-authority-epoch.md`, Consequences, open obligation 1
- **Target:** the branch head, `RecoveryState.consumedStagedResults`, and `RecoveryState.uncommittedStagedResults` returned by `runLiveness.preemptExpired` for a run that staged an assistant tool-call message and some tool results, per official kernel
- **Archetype / surface:** framework runtime recovery (Library/SDK), TypeScript only; kernels are read, never changed

## Codebase baseline

- **State today:** planning-time inspection (issue 156 planning pass) found that the TypeScript kernel's `preemptExpired` (`typescript/kernel/runtime/src/lib/runtime-kernel-runs.ts`) always reactively checkpoints the stale run's un-anchored staged results, so the assistant message and staged tool results become committed history and `uncommittedStagedResults` comes back empty; the runtime never calls `run.recover()`, reads only `stepSequence[0]` in `classifyRecoveredExecutionMode` (`typescript/runtime/src/lib/runtime-core-recovery.ts`), and re-invokes the runner, which mints fresh `callId`s. The manifest and runtime status are staged only after tools finish, so they are absent from that checkpoint. To be confirmed by the worker; the Rust, Go, Python, and Dart kernels were not inspected.
- **Discovered constraints:** tool results are staged with two task id formats (`tool_result_<orderIndex>_<callId>` on the main path, `tool_message_<nnnnnn>_<callId>` on the approval-resume path); `StagedResult` carries no role or order field, so matching must decode message bytes through the payload codec seam

## Options and trade-offs

- To be filled by the worker.

## Recommendation

- To be filled by the worker.

## Downstream impact

- **ADRs to write or update:** none expected; ADR-0065's open obligation 1 is closed by KRT-CR003 and KRT-CR004, and its Consequences are updated through the epic's patchable list only if the evidence contradicts it
- **Tickets unblocked:** KRT-CR002
- **Register entry closed:** none
- **Tickets to add or split:** to be filled by the worker
- **Spec edits required:** to be filled by the worker
