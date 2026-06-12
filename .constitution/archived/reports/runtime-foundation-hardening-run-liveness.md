# Runtime Foundation Hardening Run Liveness

## Scope

This report closes `KRT-J004`.

No liveness schema fields or runtime operations are implemented in this pass.
That is intentional. Run liveness is a kernel/framework contract decision, not a
SQLite-only optimization. The required semantics are now recorded in the
authoritative Kernel and Framework specs, and the physical implementation gate
is recorded in `constitution/TechSpec.md`.

## Current Semantics

The Kernel Spec defines `running`, `paused`, `completed`, and `failed` Runs. It
also requires one active Run per Branch, where both `running` and `paused` block
new Run creation on the Branch.

The Framework Spec defines pause as approval-only. A paused Turn has already
checkpointed pending work, emits `approval.requested`, ends with `paused`, and
resumes through `resolveApproval(...)`. The old paused handle becomes inert and
the kernel records the old paused Run as `failed` before the continuation Run
starts.

Current `StoredRun` records have timestamps, but no execution owner, lease
expiry, heartbeat, fencing token, or stale-run preemption operation.

## Spec Delta

The specs now distinguish two active ownership modes:

- `running`: execution ownership. A concrete runtime owner is doing work and
  must hold a renewable lease.
- `paused`: approval ownership. Work is intentionally suspended and the Branch
  remains blocked until a host decision resolves or abandons the approval.

`paused` must not be treated as an expired execution lease. Approval wait time
is host policy, and automatic timeout behavior must be explicit host/framework
policy rather than an implicit kernel cleanup.

For stale `running` Runs, the Kernel Spec now defines an explicit preemption
protocol instead of expecting cooperative cancellation from a dead process. The
preemption operation must atomically:

- Verify that the current owner lease is expired and that the caller has a valid
  takeover/fencing token.
- Preserve durable staged work by applying the same reactive-checkpoint rules
  used by `run.complete(...)` when verifiable staged results exist.
- Mark the superseded Run as `failed` with a durable preemption reason.
- Return the resulting Branch head and recovery state needed to create the
  replacement Run.

The replacement Run must be a new Run. Reopening a stale Run is illegal because
it weakens the Run transition model and makes audit history ambiguous.

## Landed Spec Changes

Kernel Spec:

- Defines `running` as execution-owned and `paused` as approval-owned.
- Defines leased `running` ownership with owner identity, expiry, and fencing
  token semantics.
- Defines stale-running preemption as the only valid takeover path after lease
  expiry.
- Defines failed-by-preemption as a valid `running -> failed` transition.
- Defines crash recovery for leased `running` Runs.

Framework Spec:

- Defines runtime owner identity and lease policy requirements before claiming
  durable stale-run recovery.
- Defines active lease renewal responsibility and handle invalidation after
  token loss or preemption.
- Defines startup stale-running recovery scanning.
- Keeps approval resume separate from execution lease renewal.
- Excludes paused approval Runs from stale-running recovery.

TechSpec:

- Records the liveness extension gate without changing the current physical
  `StoredRun` shape.
- Lists the fields, access paths, backend operations, validators, and conformance
  coverage that must move together when lease/preemption implementation begins.

Runtime contracts:

- The current exported runtime contracts are unchanged in this pass.
- Future implementation must add host/runtime configuration for execution owner
  identity and lease policy, plus typed errors or events for stale-owner handle
  invalidation.

## Non-Goals

This pass does not add leases, background cleaners, automatic approval expiry,
or SQLite-specific stale-run repair. The behavioral specification now exists,
but implementation remains a separate cross-boundary change so schemas,
contracts, validators, and conformance tests move together.

## Validation

This pass changes docs and constitution guidance only for liveness. The
workspace validation still passes with `bun run typecheck` and `bun run lint`;
no partial protocol, schema, or runtime lease implementation was introduced.
