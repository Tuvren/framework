# Epic H Doc Gap Inventory

## Status

This is a non-authoritative research note.

Its purpose is to preserve insights from the long-running `epic/h-shared-framework-foundations` branch without treating that branch as the correct source of truth. The authoritative sources remain:

- [docs/KrakenKernelSpecification.md](../../docs/KrakenKernelSpecification.md)
- [docs/KrakenFrameworkSpecification.md](../../docs/KrakenFrameworkSpecification.md)

The intent is to help reset Epic H back to a docs-first posture.

## Method

This note compares:

- the pre-branch framework spec on `master` (`Kraken Framework Specification v0.15`)
- the current branch's spec text and implementation history

The goal is not to bless the branch decisions. The goal is to answer a narrower question:

> What semantics did the branch keep having to invent, refine, or harden because the original `docs/` layer did not define them clearly enough?

The kernel spec did not materially change in this branch. The drift is concentrated in the framework spec.

## What Epic H Kept Trying To Define

### 1. Framework-owned semantic lineage

**Original gap in `docs/`:**

- The default schema had only `messages`, `context.manifest`, and `runtime.status`.
- The framework spec did not clearly define where implicit `parentTurnId` inference should come from on an existing branch.

**What the branch kept discovering:**

- Runtime-core needs a durable, framework-owned semantic lineage source that is separate from raw message history.
- Putting lineage into hidden `runtime.status` fields or checkpoint event payloads created contract drift and review churn.

**Current branch answer:**

- Add a dedicated `turn.lineage` path with `activeTurnId`.

**Docs-first decision to make explicitly:**

- Whether semantic-turn lineage is a first-class framework path.
- If yes, what exact schema shape and lifecycle it has.

This is the cleanest example of a concept the branch should not have been forced to derive ad hoc.

**Working decision:**

- Treat semantic-turn lineage as a first-class framework-owned schema path.
- Keep it out of `runtime.status` and out of checkpoint event payload conventions.
- Keep it narrowly scoped to semantic parent-turn inference rather than prompt context, host status, or application-owned state.

LangGraph was a useful comparison point here: its `thread_id` lives outside graph state as execution/checkpointer config, which reinforces the need to keep operational addressing and framework state distinct. The analogy is not exact, though: Kraken's semantic turn lineage is not session addressing, so the cleaner answer is an explicit framework-owned lineage path rather than hidden derivation from unrelated metadata.

### 2. Runtime status as execution state, not catch-all metadata

**Original gap in `docs/`:**

- `runtime.status` existed, but its exact ownership and lifecycle were underdefined once approval pause/resume, cancellation, orchestration, and handoffs became real.

**What the branch kept discovering:**

- Hosts, orchestration, and recovery all need a stable meaning for `runtime.status`.
- The runtime needed clear rules for:
  - when `running` is restaged
  - when `paused` is durable
  - when `completed` or `failed` is final
  - whether `activeAgent` is framework-owned
  - how interrupted output is signaled durably

**Current branch answer:**

- Keep `runtime.status` framework-owned.
- Add explicit `partial: true` semantics for interrupted assistant output.
- Treat paused-turn cancellation as a durable failure transition, not as a no-op abort.

**Docs-first decision to make explicitly:**

- The exact lifecycle contract for `runtime.status`.
- Which fields are normative versus optional observability.
- Whether partial-output durability is part of Epic H or deferred.

**Working decision:**

- Keep `runtime.status` as a minimal framework-owned lifecycle record.
- Treat it as canonical execution-state metadata for recovery, host status, approval resume, and orchestration ownership only.
- Leave richer observability to concrete drivers and extensions rather than standardizing it in the shared framework core.

Current preferred minimal shape:

- `state`
- `activeAgent?`
- `pauseReason?`
- `partial?`

Current non-goals for shared `runtime.status`:

- provider/model telemetry
- iteration counters as observability
- catch-all execution diagnostics

`resumptionSchema` should be treated as a separate question tied to whether Epic H wants general non-approval pause semantics in the shared core. It is not part of the current minimal lifecycle record by default.

### 3. Approval pause and resume semantics

**Original gap in `docs/`:**

- Approval pause existed conceptually, but the host/runtime lifecycle around resume was not defined tightly enough.

**What the branch kept discovering:**

- A paused handle cannot simply become "running" again in place without creating ownership bugs.
- The old paused handle must be exhausted and replaced.
- Pause cancellation, steering carry-forward, and approval replay safety all need explicit behavior.

**Current branch answer:**

- `resolveApproval(...)` returns a new handle.
- The old paused handle becomes exhausted.
- The framework, not the driver, owns paused-turn cancellation semantics.

**Docs-first decision to make explicitly:**

- Whether handle replacement is normative.
- Which paused-handle responsibilities remain valid after replacement.
- What durable state must exist before resumed work begins.

**Working direction so far:**

- The only shared-core pause semantics in Epic H are HITL approval pauses.
- A pause is scoped to the specific Run that requested approval. It does not implicitly pause sibling workers, the parent Run, or the rest of the orchestration runtime.
- If the main Run pauses, workers may continue.
- If a worker pauses, the main Run and other workers may continue.
- Steering queue management around a pause is host policy, not shared-core policy.
- Approval resolution must not implicitly clear or reinterpret steering that was already accepted before the pause.
- Canceling a HITL pause is semantically equivalent to rejecting the pending tool calls. It is not a framework-owned failure transition.

**Explicit correction against the branch drift:**

- The framework core should not auto-convert a paused Turn into `failed` by its own pause-time criteria.
- A paused Turn may remain paused until an explicit approval decision is executed.

**Working split of responsibility:**

- Shared core owns the canonical meaning of approval rejection.
- Host policy may decide whether a rejection is fed directly back into the model on the same Turn or whether the paused execution stops and a later host request continues from the durably staged rejection outcome.

The remaining design questions inside this topic are therefore narrower:

- whether `resolveApproval(...)` returns a replacement handle
- what parts of the old paused handle become invalid after approval handoff
- whether paused-handle `cancel()` is specified as a rejection shortcut directly or left as a host-level mapping onto explicit rejection semantics

**Working decision:**

- `resolveApproval(...)` returns a new handle rather than mutating the paused one in place.
- This fits the kernel-oriented ownership model better: the paused handle represents the completed paused execution token, while the resumed execution proceeds through a fresh handle.
- After approval handoff, the old paused handle is exhausted/inert as an execution token and must not remain a second active owner of resume or further control flow.

### 4. Parallel tool execution semantics

**Original gap in `docs/`:**

- The framework spec described tool events and approvals, but it did not pin down enough behavior for concurrent batches.

**What the branch kept discovering:**

- Hosts need clear guarantees for:
  - `tool.start` ordering under concurrency
  - when `tool.result` may surface
  - whether already-known invalid results are emitted immediately or held until the slowest sibling finishes
  - what happens to sibling tools when one tool causes a batch-level failure
  - whether timeouts cancel or merely race the underlying work

**Current branch answer:**

- All `tool.start` events occur before any `tool.result`.
- Completed results surface and stage as each tool finishes.
- Batch-level failures abort and join sibling work instead of letting side effects run after failure.
- Runtime-owned callbacks are fenced after timeout.

**Docs-first decision to make explicitly:**

- The full concurrency contract for tool execution and approval resume.
- The durability boundary for per-tool completion versus whole-batch checkpointing.

**Working decision (sub-aspect 1):**

- The driver chooses the tool execution mode for a batch: sequential or parallel.
- The shared framework core owns the canonical ordering semantics once a mode is chosen.

Current preferred ordering contract:

- **Sequential mode:** execute and emit `tool.start` / `tool.result` in original tool-call order.
- **Parallel mode:** emit all executable `tool.start` events first in original tool-call order, then emit each `tool.result` as soon as that specific tool finishes.
- In parallel mode, the durable conversation order at checkpoint time remains the original tool-call order rather than completion order.

This keeps execution policy flexible at the driver layer while keeping event and durability semantics canonical in the shared core.

**Working decision (sub-aspect 2):**

- Non-executed outcomes that are already known may surface and stage as soon as they are known; they should not be artificially delayed behind slower executable siblings.
- The runtime may synthesize rejection or error `tool_result` values for tool calls that the model already requested.
- The shared core must never invent synthetic `tool_call` / `tool_result` pairs that were not rooted in an existing model-requested call ID.

This keeps the boundary clean:

- `tool_call` is model-owned
- `tool_result` is runtime-owned
- but only for already-requested calls that exist in the trace

**Working decision (sub-aspect 3):**

- Sibling failure policy in a mixed or parallel tool batch is not fixed by the shared framework core.
- Concrete drivers or hosts may choose different policies, for example:
  - reject or stop all remaining sibling work when one call fails
  - continue collecting sibling outcomes and feed the model both the successful results and the failure result for the failed call
- The shared core should provide the primitives needed for either policy while preserving canonical trace integrity and the existing call-ID ownership rules.

This keeps the core focused on durable semantics and leaves batch-level recovery or continuation strategy to the concrete execution model above it.

**Working decision (sub-aspect 4):**

- Timeout ownership belongs to the framework or host layer, not to the shared core as a forced-termination guarantee.
- The shared core provides the reliable semantics that occur after timeout is triggered.

Current preferred shared-core guarantees after timeout:

- abort runtime-owned signals where available
- fence runtime-owned callbacks and event injection surfaces
- ignore late results that arrive after the timeout boundary
- prevent late timeout-losing work from re-entering durable framework state

The shared core does **not** guarantee forced termination of arbitrary user code or tool logic. Stronger timeout enforcement may exist in specific hosts, sandboxes, or concrete driver deployments above the core.

**Working decision (sub-aspect 5):**

- Approval-resume batches follow the same execution-mode, ordering, and durability semantics as initial tool batches.
- Resume is not a separate tool execution model; it is a continuation of the same canonical tool execution semantics with only unfinished calls eligible to continue.

That means:

- the same driver-chosen sequential or parallel mode applies
- the same shared-core `tool.start` / `tool.result` ordering guarantees apply
- known non-executed outcomes may still surface as soon as they are known
- durable final ordering remains original tool-call order

The only resume-specific additions are decision context and the exclusion of already-resolved calls from re-execution.

### 5. Driver/runtime contract ownership

**Original gap in `docs/`:**

- The driver seam was still too thin for a real shared runtime implementation.
- The framework spec did not fully specify what a driver must return versus what the framework owns.

**What the branch kept discovering:**

- Runtime-core needed explicit shared semantics for:
  - `DriverExecutionContext`
  - handoff plan construction
  - `response` versus staged `messages`
  - partial output signaling
  - immutable execution snapshots

**Current branch answer:**

- The driver contract now includes richer execution context, handoff helpers, optional `response`, and `partial`.
- Driver validators were moved onto the shared `driver-api` seam.

**Docs-first decision to make explicitly:**

- What the minimum valid driver result is.
- Whether `response` may ever exist without durable assistant messages.
- Which pieces of driver context are snapshots versus live objects.

This is one of the highest-value doc areas to settle before any Epic I driver work.

**Working decision (sub-aspect 1):**

- `DriverExecutionResult` should not carry a shared `response` field at all.
- The shared driver seam should stay history-first and resolution-first:
  - durable assistant history is represented through `messages`
  - control flow is represented through `resolution`
  - interrupted durable output is represented through `partial`
- Richer transient iteration artifacts belong in driver-local or runtime-internal layers unless a future shared-core use case proves they must exist in the public driver contract.

This is intentionally closer to the LangChain/LangGraph posture:

- durable state/history is first-class
- richer execution artifacts are local or explicitly modeled elsewhere
- the shared contract avoids baking in a universal per-iteration raw response object

**Working decision (sub-aspect 2):**

- `DriverExecutionContext` should expose immutable snapshots of framework-owned state plus explicit capability ports.
- The primitive-layer shape is:
  - snapshots in
  - capabilities through ports
  - explicit results out

That means:

- `messages`, `manifest`, and `config` are read-only snapshots
- tool access is a read-only driver-facing view, not a mutable live registry
- event emission, cancellation awareness, and handoff-plan construction are explicit ports
- drivers do not mutate framework-owned state by aliasing context objects in place

If a driver needs to influence framework state, it does so through explicit returned outputs such as `messages`, `resolution`, and `partial`, not through in-place mutation of the execution context.

### 6. Handoff semantics versus exact wording

**Original gap in `docs/`:**

- Handoff modes existed, but the branch kept discovering missing meaning around what the framework owns versus what is merely one implementation's wording.

**What the branch kept discovering:**

- `preserve_trace` needed a semantic meaning, not a sacred prose template.
- `last_output_only` needed clearer rules about visible output parts, provider metadata, and clean-slate boundaries.
- The old grouped "all user text first, then assistant text" shape did not really preserve chronology.

**Current branch answer:**

- `preserve_trace` is now defined as a chronological summarized trace.
- `last_output_only` carries only final visible output parts, not provider continuity metadata.

**Docs-first decision to make explicitly:**

- Which handoff invariants are normative.
- Which wording or formatting choices are intentionally implementation-defined.

<!-- We must probably keep this as is for now -->

### 7. Sequence semantics as a strict orchestration mode

**Original gap in `docs/`:**

- Sequence execution existed conceptually, but validation and failure semantics were too loose.

**What the branch kept discovering:**

- Pipelines need predictable behavior:
  - fixed `last_output_only` handoff semantics
  - known agent set
  - `entrypoint === sequence[0]`
  - duplicate-name rejection
  - fail-fast behavior when a configured next step is invalid

**Current branch answer:**

- Sequence transitions are strict and fail-fast.
- Sequence handoffs are not treated as freely customizable handoffs.

**Docs-first decision to make explicitly:**

- Whether sequences are a best-effort convenience or a rigid orchestration mode.

<!-- The goal of the framework core is to provide the primitives, the opinionated aspects will be inside the specific drivers and any shared logic can be added to the core afterworks when found to be necessary -->

### 8. Public orchestration runtime contract

**Original gap in `docs/`:**

- The original spec did not define enough of the real `OrchestrationRuntime` surface.

**What the branch kept discovering:**

- Orchestration needs explicit shared semantics for:
  - `OrchestrationHandle`
  - `WorkerStatus`
  - parent-qualified worker APIs
  - paused worker approvals
  - worker event demultiplexing
  - active-session versus retained-worker access
  - lazy-start parent launch preconditions

**Current branch answer:**

- The framework spec now describes a much richer orchestration contract than `master` did.

**Docs-first decision to make explicitly:**

- Which parts of worker/session behavior are core framework semantics and which are implementation details.
- Whether the no-`parent` convenience path is normative or merely optional when ambiguity is low.

<!-- We will need to handle this in detail for me to be able to decide for each one -->

### 9. Worker-result projection

**Original gap in `docs/`:**

- The original docs did not pin down how worker completion should be projected back into the parent turn.

**What the branch kept discovering:**

- Worker bridging needs a canonical shape and clear omissions.
- Forwarding reasoning or raw tool-call internals into `worker_result` reintroduced exactly the sort of leakage Epic H was trying to avoid.

**Current branch answer:**

- Use a structured `worker_result`.
- Omit reasoning from projected worker output.
- Treat projection as the worker's visible surface, not its raw internal trace.

**Docs-first decision to make explicitly:**

- Whether `worker_result` is purely structured.
- Which part types are allowed or forbidden in projected worker output.

<!-- Workers should only return the final response to the parent, nothing else. Any extra typed schema is for a driver-extra details such as adding a worker run id that could be used by the parent to, for example, transform an async run to sync by waiting for the worker. Same as I mentioned before, the core framework part must be providing the primitives that drivers use later -->

### 10. Observability versus correctness

**Original gap in `docs/`:**

- Optional events and event objects existed, but their relationship to durable checkpoints and framework bookkeeping was underdefined.

**What the branch kept discovering:**

- The runtime needed explicit guidance for:
  - `state.checkpoint` versus `state.snapshot`
  - when snapshots follow a checkpoint
  - whether checkpoint event objects are merely audit artifacts or load-bearing state
  - what happens when finalization persistence fails after execution work already completed

**Current branch answer:**

- The branch moved toward cleaner separation: event objects are observability/audit, not hidden lineage storage; finalization failure does not pretend durability succeeded.

**Docs-first decision to make explicitly:**

- The exact boundary between observability and correctness.
- Whether any checkpoint event object is ever allowed to carry semantic state.

<!-- Let's check this specifically because my guess is that we may be trying to reinvent the wheel in the sense of doing too much for something that may not be load-bearing -->

### 11. External or delegated framework execution mode

**Original gap in `docs/`:**

- Once `createOrchestrationRuntime({ framework })` existed, the docs did not fully define what delegated mode must preserve.

**What the branch kept discovering:**

- Delegated mode needs clear rules for:
  - driver selection ownership
  - schema inheritance
  - handoff builder behavior
  - thread/kernel consistency
  - what remains owned by orchestration versus by the supplied framework

**Current branch answer:**

- The branch tightened some of this behavior, but this area still wants a clean docs-first statement rather than scattered implementation assumptions.

**Docs-first decision to make explicitly:**

- Whether delegated orchestration is part of the normative framework contract or just a convenience composition mode.

<!-- I think I still don't understand what "delegated orchestration" means so this needs to be talked more for me to be able to decide on specifics -->

## Recommended Docs-First Rewrite Order

If Epic H is being reset properly, the clean order is:

1. **State schema and lifecycle**
   - `messages`
   - `context.manifest`
   - `turn.lineage`
   - `runtime.status`
2. **ExecutionHandle lifecycle**
   - lazy start
   - cancel
   - steer
   - approval pause/resume
3. **Driver contract**
   - execution context
   - result validity
   - response/messages/partial relationship
4. **Tool execution contract**
   - parallel ordering
   - durability timing
   - approval batch semantics
   - timeout semantics
5. **Handoff and sequence semantics**
6. **OrchestrationRuntime**
   - worker lifecycle
   - parent/worker event surfaces
   - worker-result projection
7. **Observability and finalization semantics**

That order keeps the higher-level orchestration and handoff semantics anchored on a settled base execution model.

## What Should Wait Until `constitution/`

These topics matter, but they are not the docs-first step:

- package layout and Nx target shape
- package export subpaths and facade structure
- test suite partitioning
- runtime-core internal module boundaries
- build tooling and smoke-test posture

Those belong in `constitution/TechSpec.md` and `constitution/Tasks.md` after the `docs/` layer is made authoritative again.

## Suggested Working Mode From Here

Treat the branch implementation as evidence, not truth:

1. pick one semantic area from the list above
2. decide it in `docs/KrakenFrameworkSpecification.md`
3. only after `docs/` is settled, propagate the consequences into `constitution/`
4. only then decide what code survives

That gives Epic H the shape it should have had from the start: spec first, then plan, then implementation.
