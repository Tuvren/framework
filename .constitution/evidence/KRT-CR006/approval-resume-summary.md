# KRT-CR006 approval-resume identity proof

The behavioral test in `typescript/runtime/test/runtime-core.approval-basics.test.ts` drives a real runtime Turn through an approval pause and `resolveApproval` continuation.

- `turn.start` supplies the original `turnId`.
- `approval.requested` supplies the original `callId` (`call-approved-effect`).
- The tool has not executed before approval.
- At the actual approved dispatch, `ToolExecutionContext.callId` is unchanged and `ToolExecutionContext.idempotencyKey` equals `deriveIdempotencyKey(originalTurnId, originalCallId)`.
- The paused `input_validated` audit and resumed `output_validated` audit carry different `runId` values.
- The resumed audit retains the original `turnId`, and the Turn completes.

Lead verification passed framework runtime typecheck, all 522 runtime tests, runtime lint, and `bun run check` under the wave's shared verification lock. The initial sandboxed Nx attempt could not write its cache directory; the authorized reruns used the same checkout and all exited successfully.
