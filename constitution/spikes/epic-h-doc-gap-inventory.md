# Epic H Framework Decision Inventory

## Status

This is a non-authoritative research note that records the current docs-first decisions for resetting Epic H.

Authoritative behavioral meaning belongs in:

- [docs/KrakenKernelSpecification.md](../../docs/KrakenKernelSpecification.md)
- [docs/KrakenFrameworkSpecification.md](../../docs/KrakenFrameworkSpecification.md)

This note exists to preserve the conclusions reached while unwinding the long-running `epic/h-shared-framework-foundations` branch. It is intentionally self-contained so it can serve as a staging artifact while the authoritative framework spec is being rewritten.

## 1. Framework-Owned Semantic Lineage

**Decision**

- Semantic turn lineage is a first-class framework-owned schema path.
- It lives in `turn.lineage`.
- It is not stored in `runtime.status`.
- It is not hidden inside checkpoint event payloads.

**Rationale**

- The framework needs one durable and explicit source of truth for implicit `parentTurnId` inference on an active Branch.
- That concern is semantic lineage, not prompt context and not host status.
- Keeping it as an explicit framework path is cleaner than deriving it from unrelated metadata.

**Boundary**

- `turn.lineage` is framework-owned metadata for semantic parent-turn inference only.
- It is not prompt context.
- It is not application-owned state.
- It is not an observability payload.

## 2. Runtime Status

**Decision**

- `runtime.status` is a minimal framework-owned lifecycle record.
- Its preferred shape is:
  - `state`
  - `activeAgent?`
  - `pauseReason?`
  - `partial?`

**Rationale**

- Shared core should own canonical execution lifecycle semantics, not a catch-all telemetry surface.
- Hosts, recovery, pause/resume, and orchestration all need a stable durable execution-state record.
- Richer observability belongs above the shared core.

**Boundary**

- `runtime.status` is for recovery, host status, approval resume, and orchestration ownership.
- It is not a provider/model telemetry bag.
- It is not the place for iteration counters or general execution diagnostics.
- General non-approval pause metadata is out of scope unless later promoted explicitly.

## 3. Approval Pause and Resume

**Decision**

- Epic H pause semantics are HITL approval pauses only.
- Pause is always local to the specific Run that requested approval.
- If the main Run pauses, workers may continue.
- If a worker pauses, the parent and sibling workers may continue.
- `resolveApproval(...)` returns a new handle.
- The old paused handle becomes exhausted/inert as an execution token.

**Rejection and Cancel Semantics**

- Canceling a paused HITL run is semantically equivalent to rejecting the pending tool calls.
- It is not a framework-owned automatic failure transition.
- Shared core owns the canonical meaning of approval rejection.
- The host chooses between the two rejection paths through the existing paused-handle controls:
  - `resolveApproval(...)` with explicit `reject` decisions feeds the canonical rejection results back into the model on the same Turn.
  - `cancel()` on the paused handle stages the canonical rejection results durably and stops without re-entering the model on the same Turn.

**Boundary**

- Steering queue management around a pause is host policy, not shared-core policy.
- Approval resolution must not reinterpret or clear already accepted steering implicitly.
- Pause/rejection semantics should not be widened to unrelated pause categories unless explicitly specified later.

## 4. Tool Execution Semantics

### 4.1 Execution Mode

**Decision**

- The driver chooses whether a tool batch executes sequentially or in parallel.
- The shared framework core owns the canonical ordering semantics once a mode is chosen.
- The driver expresses that choice through the shared driver seam when it requests tool calls, not through runtime-core construction-time policy wiring.

**Core Guarantees**

- Sequential mode:
  - `tool.start` and `tool.result` follow original tool-call order.
- Parallel mode:
  - all executable `tool.start` events emit first in original tool-call order
  - each `tool.result` emits as that specific tool finishes
  - durable final ordering remains original tool-call order

### 4.2 Known Non-Executed Outcomes

**Decision**

- Non-executed outcomes that are already known may surface and stage as soon as they are known.
- They are not delayed behind slower executable siblings.

**Boundary**

- The runtime may synthesize rejection or error `tool_result` values for tool calls the model already requested.
- The shared core must never invent synthetic `tool_call` / `tool_result` pairs that were not rooted in an existing model-requested call ID.

### 4.3 Sibling Failure Policy

**Decision**

- Sibling failure policy in a mixed or parallel batch is not fixed by the shared framework core.

**Boundary**

- Drivers or hosts may choose to reject or stop remaining sibling work.
- Drivers or hosts may choose to continue collecting sibling outcomes, including failures.
- Shared core only guarantees trace integrity, call-ID ownership, and ordering/durability semantics for whichever results are actually produced.

### 4.4 Timeout Ownership

**Decision**

- Timeout ownership belongs to the framework or host layer, not to the shared core as a forced-termination guarantee.
- Shared core provides the reliable semantics that occur after timeout is triggered.

**Core Guarantees After Timeout**

- abort runtime-owned signals where available
- fence runtime-owned callbacks and event injection surfaces
- ignore late results that arrive after the timeout boundary
- prevent late timeout-losing work from re-entering durable framework state

**Boundary**

- Shared core does not guarantee forced termination of arbitrary user code or tool logic.
- Stronger timeout enforcement may exist in hosts, sandboxes, or concrete drivers above the core.

### 4.5 Approval Resume Batches

**Decision**

- Approval-resume batches follow the same execution-mode, ordering, and durability semantics as initial tool batches.
- Resume is not a separate tool execution model.

**Boundary**

- The only resume-specific additions are decision context and exclusion of already-resolved calls from re-execution.

## 5. Driver / Runtime Contract

### 5.1 Shared Driver Result Shape

**Decision**

- `DriverExecutionResult` should not carry a shared `response` field.
- The shared seam is history-first and resolution-first.

**Preferred Shape**

- `resolution`
- `messages?`
- `partial?`

**Boundary**

- Richer transient iteration artifacts belong in driver-local or runtime-internal layers unless a future shared-core use case proves otherwise.

### 5.2 Driver Execution Context

**Decision**

- `DriverExecutionContext` exposes immutable snapshots of framework-owned state plus explicit capability ports.

**Primitive Shape**

- snapshots in
- capabilities through ports
- explicit results out

**Implications**

- `messages`, `manifest`, and `config` are read-only snapshots
- tool access is a read-only driver-facing view
- event emission, cancellation awareness, and handoff-plan construction are explicit ports
- drivers do not mutate framework-owned state by aliasing context objects in place

### 5.3 Minimum Valid Driver Result

**Decision**

- Keep the shared type minimal and enforce stronger rules in docs and validators rather than encoding a heavy ReAct-shaped discriminated union in the public contract.

**Semantic Rules**

- `resolution` is always required
- `messages` are required whenever the iteration produces durable assistant history
- `messages` may contain at most one assistant message per iteration
- `messages` may be absent only for:
  - pure control outcomes with no durable assistant-history contribution
  - failures before any durable assistant output was staged
- `partial` is valid only for failed execution results that stage an assistant message
- `toolExecutionMode` is required when driver messages request tool calls and omitted otherwise, because the driver must choose sequential vs. parallel execution through the shared seam rather than through out-of-band runtime wiring

**Clarification**

- An “empty assistant turn” is not treated as a normal happy-path shared-contract case merely because a model API is request/response shaped.
- No-`messages` results are non-history outcomes, not ordinary assistant turns with empty content.

### 5.4 Active Agent Ownership

**Decision**

- `activeAgent` does not belong on the shared `DriverExecutionResult`.

**Rationale**

- Active-agent lifecycle is framework-owned rather than driver-owned.
- The right control carriers already exist:
  - `resolution.handoff.targetAgent`
  - framework-owned `runtime.status.activeAgent`

## 6. Handoff Semantics

**Decision**

- Shared framework core owns handoff logic and semantic guarantees.
- Exact wording and formatting of default builders are implementation-defined.

**Normative Shared Guarantees**

- handoff is a control transition, not ordinary tool execution
- handoff rewrites the active `messages` path on the same Turn and Branch
- active agent changes durably
- active execution scope is rebuilt from the target agent configuration
- prior full history remains recoverable through prior TurnNodes rather than in-place raw replay

**Mode-Level Invariants**

- `preserve_trace`
  - preserves a chronological summarized trace
  - does not expose raw history
  - does not expose raw tool-call inputs
  - does not leak incompatible prior tool surfaces
- `last_output_only`
  - carries only the previous agent’s final visible output parts
  - does not carry provider continuity metadata across the role transition

**Implementation-Defined**

- exact wrapper wording
- exact section headings
- exact text formatting of summaries and tool outcomes
- exact prose templates used by default builders

## 7. Ordered Pipelines / Sequence

**Decision**

- Sequence semantics do not belong in the shared framework core.
- Ordered pipelines are a thin driver-level pattern built on top of the shared handoff mechanism.

**Boundary**

- Shared core keeps handoff primitives and guarantees.
- Pipeline progression, sequence validation, and sequence-specific progression policy belong above the core.
- If reusable sequence-like logic is justified later, it can be added above the primitives after concrete driver experience, not before.

## 8. Minimal Core Orchestration

### 8.1 Why It Exists

**Decision**

- Keep orchestration support in the shared framework core, but only as a minimal primitive.

**Rationale**

- The shared core should provide reusable logic for parent/worker coordination and real-time worker event plumbing so drivers do not have to reinvent it independently.

### 8.2 Preferred Surface

**Decision**

- The minimum core orchestration surface is handle/tree-based rather than runtime-global worker-registry-based.

**Preferred Primitive Surface**

- a way to spawn child execution from a handle
- the normal execution-handle control surface on the child
- one aggregated subtree event stream in addition to self-only `events()`

**Boundary**

- runtime-global worker lookup by ID is not the primary contract
- `parentEvents()` and `workerEvents(workerId)` are not core primitives
- rich session-retention and ambiguity-resolution semantics are not part of the minimal core surface

### 8.3 Recursive Trees

**Decision**

- Parent/worker relationships are explicit execution-tree capabilities:
  - a parent handle can spawn child handles
  - child handles are ordinary execution handles, so pause/resume/cancel semantics stay local to the child
  - any child may itself spawn children, allowing recursive parent/worker trees

## 9. Worker Result Projection

**Decision**

- Shared core does not define a canonical parent-context worker-result payload.

**Shared-Core Provides**

- child execution handles
- child/subtree events
- child completion access
- steering as a separate primitive already available to higher layers

**Higher-Layer Choices**

- a driver may inject the child result through steering
- a driver may expose a sync tool that waits for a child and returns its result
- a driver may choose not to inject the child result into parent conversational context at all

**Safety Boundary**

- any higher-layer projection of child completion into parent context should be based only on the child’s visible final result surface
- internal reasoning and hidden trace details are not shared-core projection semantics

## 10. Observability versus Correctness

**Decision**

- Keep observability minimal and pluggable in the shared core.
- Treat this as a tracing and audit integration concern, not as a client-consumption correctness surface.

**Boundary**

- correctness-critical semantics live in kernel records and explicit framework state paths
- observability surfaces remain optional, non-authoritative, and replaceable

**Implication**

- checkpoint event objects and optional snapshot/checkpoint events are observability aids, not hidden semantic state channels
- the shared core must remain compatible with pluggable observability layers such as OpenTelemetry, Langfuse, or custom tracing stacks

## 11. Delegated / External Framework Execution Mode

**Decision**

- Remove delegated or external framework execution mode from the authoritative framework semantics for now.

**Rationale**

- the term is too fuzzy to carry normative weight
- it looks like a composition or implementation concern rather than a core semantic
- defining it now would force premature decisions about ownership of execution, schema, driver selection, and handoff behavior

If a real need emerges later, it can be specified from concrete usage rather than speculative abstraction.

## Recommended Rewrite Order for `docs/`

1. state schema and lifecycle
   - `messages`
   - `context.manifest`
   - `turn.lineage`
   - `runtime.status`
2. execution-handle lifecycle
   - lazy start
   - cancel
   - steer
   - approval pause/resume
3. driver contract
4. tool execution contract
5. handoff semantics
6. minimal orchestration
7. observability boundary

## What Still Waits Until `constitution/`

These are not `docs/`-first questions:

- package layout and Nx target shape
- package export subpaths and facade structure
- test suite partitioning
- runtime-core internal module boundaries
- build tooling and smoke-test posture

Those belong in `constitution/TechSpec.md` and `constitution/Tasks.md` only after the authoritative `docs/` layer is settled.
