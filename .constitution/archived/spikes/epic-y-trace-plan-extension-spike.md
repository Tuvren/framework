# Epic Y Trace Plan Extension Spike

## Status

Closed in current repo reality.

## Decision

Lifecycle-heavy conformance checks use optional `steps[]` on a conformance plan check. The plan still owns the behavior being asserted, while the shared runner owns step scheduling, prior-step references, assertion evaluation, required evidence, and trace-shaped evidence. Adapter hosts only execute neutral operations and return observations.

## Trace Model

- `steps[].stepId` names the runner-owned trace slot.
- `steps[].operation` names a neutral adapter operation declared by the authority packet.
- `steps[].input` may override the check input for that step.
- `steps[].controls` applies cancellation/deadline controls to that step only.
- `steps[].assertions` can assert the immediate step observation.
- `steps[].inspectState` can request a neutral state view after the step.
- Final assertions resolve against `$.state.trace.<stepId>` and `$.evidence.trace.<stepId>`.

The runner resolves path references against `$.input`, `$.fixture`, `$.scenario`, `$.result`, `$.events`, `$.state`, `$.evidence`, and prior `$.trace` entries. This keeps fixture comparisons and prior-step continuity in the plan and runner, not in adapters.

## Converted Checks

- `runtime-api.cancel-execution.failure`
- `runtime-api.approval-resolve.paused-resume`
- `runtime-api.branch-create.recovery`
- `runtime-api.context-transform.shared-summary`
- `runtime-api.recover-result.staged-result`
- `react-driver-callable.checkpoint`

These checks now require implementation-produced trace observations. Rust framework remains honestly red because its native adapter returns not-implemented adapter errors instead of manufacturing implementation results.

## Rejected Shapes

- No adapter receives `checkId`.
- No adapter emits check-scoped evidence.
- No trace check may pass by echoing controls.
- No trace check may pass by replaying a fixture as implementation proof.
- No adapter/protocol error may be mapped into `$.result.error`.
