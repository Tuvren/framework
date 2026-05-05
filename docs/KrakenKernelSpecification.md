# Kraken Kernel Specification

**Version**: v0.9
**Status**: Frozen

Read this before the framework specification. This document freezes the kernel primitives only.

Kraken is the execution engine inside Tuvren Runtime. This specification is therefore an engine-layer document, not the public product definition.

---

## Purpose

The kernel is the structural persistence engine of the Kraken execution engine inside Tuvren Runtime. It applies the model of content-addressed storage, parent-linked history, and movable references — as seen in Git's internals — to continuous runtime checkpointing rather than manual source control.

The kernel provides mechanism without policy: immutable content storage, structured state snapshots, a history DAG, durable write-ahead tracking, and stepwise execution with declarative checkpointing. It does not know what a "model call" is, what a "tool" is, or what "context assembly" means.

The framework — specified in `KrakenFrameworkSpecification.md` — provides agent-specific behavior built on the kernel's 28 operations. The kernel is language-agnostic and implementable in a native language with the framework as an SDK in any language on top.

---

## 1. Architecture

### 1.1 Boundary Contract

Every concept that crosses the kernel-framework boundary is **data** — serializable, schema-driven, inspectable.

- No callbacks from kernel to framework.
- No framework types leaking into the kernel.
- The kernel never calls up to the framework for any of its obligations (including reactive checkpointing during crashes).
- The framework calls the kernel. The kernel responds with data.
- Every run-scoped operation carries an explicit `runId`. No ambient execution state.

The boundary is a protocol, not an API.

### 1.2 Layers

```
┌────────────────────── INTERACTION LAYER ──────────────────────┐
│  Thread → Branch(es) → each Branch has one Head               │
└───────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────── EXECUTION LAYER ───────────────────────┐
│  Turn → Run(s) → Step(s)                                      │
│  Each Run executes a declared step sequence on a Branch.      │
└───────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌────────────────────── STATE / HISTORY LAYER ──────────────────┐
│  TurnNode chain (DAG) → each TurnNode references a TurnTree   │
│  TurnTrees are immutable state roots with structural sharing. │
│  Objects are content-addressed immutable blobs.               │
└───────────────────────────────────────────────────────────────┘
```

These layers communicate through well-defined references. They do not embed each other's content. The kernel manages all three. The framework operates within the execution layer and reads from the state/history layer.

---

## 2. Storage Primitives

### 2.1 Object

The fundamental durable unit. Everything the framework stores — messages, tool calls, responses, images, schemas, approval payloads — is representable as an Object.

- **Identity**: Hash, computed from canonical Blob representation.
- **Mutation authority**: Write-once by the kernel via `store.put` or `staging.stage`. Never modified after creation.
- **Crash consistency**: An Object either exists in durable storage or it does not. `store.put` is atomic.

### 2.2 Blob

The raw byte representation of an Object's content. Content is semantic (framework concern). Blob is physical (kernel concern).

### 2.3 Hash

The content address for a stored Object. Computed from the canonical representation of the Blob. Identical Blobs produce identical Hashes. The kernel owns the hashing algorithm — it is the identity mechanism for the entire system.

### 2.4 Object Store Operations

```
store.put(blob) → hash
store.get(hash) → blob | null
store.has(hash) → boolean
```

`put` is write-once and idempotent. Putting the same content twice produces the same hash with no conflict. This is load-bearing for recovery: re-executing a step that produces identical output is harmless.

---

## 3. Structural Primitives

### 3.1 TurnTreeSchema

A registered definition of what state looks like. Provided by the framework at initialization. The kernel uses it to build, diff, and incorporate into TurnTrees.

```
TurnTreeSchema
├─ schemaId: string               // unique identity, opaque to kernel
├─ paths: PathDefinition[]
│    PathDefinition
│    ├─ path: string              // dot-separated, e.g. "tools.results"
│    ├─ collection: "ordered" | "single"
│    └─ metadata: opaque          // framework can attach meaning, kernel ignores
└─ incorporationRules: IncorporationRule[]
     IncorporationRule
     ├─ objectType: string        // matches StagedResult.objectType
     └─ targetPath: string        // which schema path receives this type
```

- **Identity**: `schemaId`, unique per registration. Opaque string. Two schemas with different `schemaId` values are unrelated from the kernel's perspective.
- **Mutation authority**: Write-once via `schema.register`. Never modified. A new version is a new schema with a new `schemaId`. Schema evolution is a framework concern.
- **Crash consistency**: A schema either exists in durable storage or it does not.

**Collection kinds:**

| Kind      | Value type | Incorporation behavior |
| --------- | ---------- | ---------------------- |
| `ordered` | `Hash[]`   | Append to list         |
| `single`  | `Hash`     | Replace                |

Validation at registration: no duplicate paths, valid collection types, all incorporation rule target paths exist, no duplicate objectType mappings.

#### Schema Operations

```
schema.register(schema: TurnTreeSchema) → schemaId
schema.get(schemaId) → TurnTreeSchema | null
```

### 3.2 TurnTree

An immutable state root built from a schema. A nested manifest of object refs with structural sharing.

- **Identity**: Hash, computed from canonical serialization of the tree identity tuple `{ schemaId, manifest }`.
- **Mutation authority**: Created by the kernel via `tree.create` or `tree.incorporate`. Never modified after creation.
- **Crash consistency**: During checkpoint transactions (§5.5), TurnTree creation is part of the atomic operation.

`ordered` collections preserve semantic/execution order. Order is part of meaning. No sorting by leaf hash.

**Structural sharing**: When only one part of state changes, only that path and its ancestors need new hashes. Everything else is reused by reference.

```
TN7 → TurnTree A
  messages       → [msg_1, msg_2]
  tools.results  → [result_1]

TN8 → TurnTree B
  messages       → [msg_1, msg_2]      (reused — same refs)
  tools.results  → [result_1, result_2] (new — different refs)
```

#### Tree Operations

```
tree.create(schemaId, changes: Record<path, PathValue>,
            baseTurnTreeHash?: Hash) → treeHash
tree.incorporate(baseTurnTreeHash,
                 stagedResults: StagedResult[]) → treeHash
tree.diff(treeHashA, treeHashB) → changedPaths[]
tree.resolve(treeHash, path) → PathValue
tree.manifest(treeHash) → Record<path, PathValue>
```

Where `PathValue` is `Hash[]` for `ordered` paths or `Hash | null` for `single` paths.

**`create`** builds a TurnTree. Without `baseTurnTreeHash`, all schema paths must be provided. With `baseTurnTreeHash`, only changed paths are provided — unchanged paths inherit from the base. The kernel compares each path's refs against the base and only rehashes changed paths. This is the mechanism for framework-initiated state transformations: substitution, projection, reordering, or any structural change.

**`incorporate`** applies StagedResults to a base tree using the schema's incorporation rules. Each StagedResult's `objectType` maps to a `targetPath`. For `ordered` paths, the Object hash is appended. For `single` paths, the Object hash replaces. Deterministic given the same inputs in the same order. A StagedResult with no matching rule is an error. The kernel uses `incorporate` autonomously during checkpointing and reactive checkpointing — no framework involvement required.

**`diff`** compares two TurnTrees. Efficient due to structural sharing — compare subtree hashes, recurse only into changed branches. Trees with different `schemaId` values cannot be diffed.

**`resolve`** returns the value at a given path. Empty list (`ordered`) or null (`single`) for valid paths with no refs. Unknown path is an error.

**`manifest`** dumps all paths and their typed values. Used for serialization, debugging, and context assembly.

**Conformance target for this surface:** Promoted cross-backend conformance evaluates observable TurnTree semantics: valid path inheritance from a base tree, deterministic `manifest` / `resolve` / `diff` results, and stable lineage-visible behavior across checkpointing, rollback, and branch head movement. Physical subtree layout, chunking strategy, or direct proof of hash-node reuse are implementation freedoms unless a future storage-level conformance packet promotes them explicitly.

### 3.3 TurnNode

One durable point in the history DAG. Links a transition to the state it produced.

```
TurnNode
├─ hash: Hash                    // identity of this node
├─ previousTurnNodeHash: Hash    // DAG link (null for root)
├─ turnTreeHash: Hash            // resulting state root
├─ consumedStagedResults: StagedResult[]  // what was incorporated
├─ schemaId: string              // which TurnTreeSchema was active
└─ eventHash: Hash | null        // optional opaque Object — framework's
                                 // record of what triggered this checkpoint
```

- **Identity**: Hash, computed from the canonical serialization of all TurnNode fields except `hash` itself.
- **Mutation authority**: Created only by the kernel during checkpoint transactions or reactive checkpointing. Never modified.
- **Crash consistency**: TurnNode creation is part of an atomic checkpoint transaction (§5.5). All-or-nothing.

`schemaId` records which schema was active, so future reads can interpret the TurnTree correctly even after schema evolution.

`eventHash` is an opaque reference to a framework-defined Object. The kernel stores the link, never reads the content. If not provided, `eventHash` is null. The one implementation-owned exception is thread bootstrap: a kernel may attach a backend-owned root event Object when the storage identity model would otherwise allow two threads with the same schema and empty root tree to share an indistinguishable genesis TurnNode. That event is opaque to the framework and exists only to preserve cross-thread lineage proofs.

#### TurnNode Operations

```
node.get(hash) → TurnNode | null
node.walkBack(fromHash) → Iterator<TurnNode>
```

Read operations only. `walkBack` follows the `previousTurnNodeHash` chain linearly. TurnNode creation is kernel-internal, triggered through `run.completeStep` and `run.complete`.

### 3.4 StagedResult

A durable record of work performed between TurnNodes. Tracked and durable, but not yet structurally committed to the history graph.

```
StagedResult
├─ taskId: string                // which task produced this result
├─ objectHash: Hash              // the Object in the content-addressed store
├─ objectType: string            // opaque to kernel, meaningful to framework
├─ status: completed | failed | interrupted
├─ interruptPayload: opaque      // when interrupted, what's needed to resume
└─ timestamp: timestamp
```

- **Identity**: `taskId` within the scope of a Run.
- **Mutation authority**: Created by the kernel via `staging.stage`. Consumed during checkpoint transactions. Never modified between creation and consumption.
- **Crash consistency**: **Durable** — survives process crashes. Essential for parallel work within a step.

StagedResults are **run-scoped**. Each Run owns its own staging state. Concurrent Runs on different Branches have isolated staging.

StagedResults are consumed when the kernel creates a TurnNode during a checkpoint transaction. The TurnNode records the consumed StagedResults. Subsequent execution starts with clean staging.

#### Staging Operations

```
staging.stage(runId, blob, taskId, objectType, status,
              interruptPayload?) → { objectHash, stagedResult }
staging.current(runId) → StagedResult[]
```

**`stage`** is atomic: it writes the Object to durable storage AND appends the StagedResult to the Run's durable staging state in one call.

**`current`** returns un-anchored StagedResults for the specified Run. Empty after a checkpoint or at Run start.

---

## 4. Containment

### 4.1 Thread

A long-lived container for an ongoing conversation or work context.

```
Thread
├─ id: string
├─ schemaId: string
└─ rootTurnNodeHash: Hash        // genesis node — anchor for lineage proofs
```

- **Identity**: `threadId`, unique.
- **Mutation authority**: Write-once via `thread.create`. Never modified.
- **Crash consistency**: `thread.create` is an atomic bootstrap operation.

Creating a Thread atomically produces a valid starting state:

```
thread.create(threadId, schemaId, initialBranchId) → {
  threadId, branchId, rootTurnNodeHash, rootTurnTreeHash
}
```

The kernel internally: registers the Thread, creates an empty TurnTree from the schema, creates the root TurnNode (`previousTurnNodeHash: null`, empty tree, `eventHash: null` unless a backend-owned bootstrap event is required for unique lineage identity), creates the Branch with Head pointing to the root TurnNode. No intermediate invalid moments.

#### Thread Operations

```
thread.create(threadId, schemaId, initialBranchId) → ThreadCreateResult
thread.get(threadId) → Thread | null
```

### 4.2 Branch

An alternate continuation of history within a Thread. A named pointer to a TurnNode, movable forward and backward.

```
Branch
├─ id: string
├─ threadId: string
└─ headTurnNodeHash: Hash       // the one Head — kernel-enforced
```

- **Identity**: `branchId`, unique.
- **Mutation authority**: Created by the kernel via `thread.create`, `branch.create`, or automatically during archival rollback. Head moved by the kernel during checkpoint transactions or via `branch.setHead`.
- **Crash consistency**: During checkpoint transactions, Head advancement is part of the atomic operation. `branch.setHead` is atomic (forward) or atomic compound (backward archival).

Each Branch has **exactly one Head** — a kernel-enforced invariant.

#### Branch Operations

```
branch.create(branchId, threadId, fromTurnNodeHash) → Branch
branch.get(branchId) → Branch | null
branch.setHead(branchId, turnNodeHash) → SetHeadResult
branch.list(threadId) → [branchId, Hash][]
```

**`create`** creates a new Branch within a Thread. Head points to `fromTurnNodeHash`. Validated by lineage walk.

**`setHead`** moves the Head. Direction determined by lineage walks:

- **Forward** (current Head is ancestor of target): atomic pointer update.
- **Backward** (target is ancestor of current Head): atomic compound operation:
  1. Create archive Branch with Head at current (pre-rollback) Head.
  2. Fail any `running` or `paused` Runs on the archived segment.
  3. Move the original Branch Head to the target.
  4. Return updated Branch and archive Branch.
- **Lateral** (neither ancestor nor descendant): **rejected**.

The archive Branch preserves abandoned TurnNodes. No TurnNodes are ever orphaned.

### 4.3 Lineage and Containment

The kernel proves Thread membership and directional relationships through **lineage proofs** over the `previousTurnNodeHash` chain back to the Thread's `rootTurnNodeHash`.

**Membership proof**: A TurnNode belongs to a Thread if and only if walking `previousTurnNodeHash` from that node reaches the Thread's `rootTurnNodeHash`.

**Direction detection**: Given two nodes A and B within the same Thread — walk back from B (if A found: forward from A to B), walk back from A (if B found: backward from A to B), neither walk finds the other (lateral — diverged from common ancestor).

**Cross-thread rejection**: If a lineage walk reaches a root that doesn't match the expected Thread's `rootTurnNodeHash`, the operation is rejected.

This single logical mechanism serves all containment and direction validation across the kernel. Implementations may maintain backend-local derived indexes, such as root/depth metadata, to accelerate lineage proofs. Those indexes are not canonical kernel records and are valid only while they are derived from, and validated against, the immutable parent-linked TurnNode chain. If an implementation detects disagreement between a derived index and the TurnNode chain, the TurnNode chain is authoritative and the derived index is corrupt.

### 4.4 TurnSequence

The ordered chain of TurnNodes along one Branch, from root to current Head. Each Branch has exactly one TurnSequence. The global structure across all Branches is a DAG; each individual Branch view is linear.

---

## 5. Execution

### 5.1 StepDeclaration

```
StepDeclaration
├─ id: string                    // e.g. "model_call", "tool_execution"
├─ deterministic: boolean        // can be re-derived from same inputs?
├─ sideEffects: boolean          // causes external state changes?
└─ metadata: opaque              // framework-specific, kernel ignores
```

- **Identity**: `id`, unique within a step sequence.
- **Mutation authority**: Provided by the framework at Run creation. Immutable for the Run's lifetime.

Steps are atomic from the kernel's perspective. If a step is "sometimes deterministic," the framework must either declare it non-deterministic (over-checkpoint) or decompose it.

### 5.2 Run

The concrete execution instance that handles a Turn. Executes a declared sequence of steps. Produces Objects, StagedResults, and TurnNodes.

```
Run
├─ id: string                    // framework-provided, kernel validates uniqueness
├─ turnId: string
├─ branchId: string
├─ schemaId: string
├─ startTurnNodeHash: Hash
├─ status: running | paused | completed | failed
├─ stepSequence: StepDeclaration[]
├─ currentStepIndex: number
└─ createdTurnNodes: Hash[]
```

- **Identity**: `runId`, framework-provided, unique.
- **Mutation authority**: Created via `run.create`. Status updated during `run.complete` or archival rollback.

**Lifecycle rules:**

- **One active Run per Branch.** `run.create` rejects if any `running` or `paused` Run exists on the target Branch.
- **Paused is blocking.** A paused Run holds its Branch until explicitly resolved.
- **Running is execution-owned.** A `running` Run represents active execution ownership, not merely a historical status label. Implementations that claim durable stale-run recovery MUST attach an execution owner, renewable lease expiry, and fencing token to `running` ownership.
- **Paused is approval-owned.** A `paused` Run represents intentional approval suspension. It blocks the Branch, but it is not an execution lease and MUST NOT be preempted merely because an execution-owner heartbeat expired.
- **Paused resolution is one-way.** A paused Run may be explicitly resolved only to `failed`; this is the mechanism the framework uses to abandon a pause point before creating a replacement Run on the same Branch.
- **Terminal statuses**: `completed` and `failed`. Rollback-caused termination uses `failed`.
- Multiple Runs may serve the same Turn (pause/resume creates new Run from pause point).

Each Run explicitly declares `schemaId` and `branchId`. The kernel validates at `run.create` that the Branch's current Head matches `startTurnNodeHash`.

#### Run Execution Leases

Execution leases are the kernel-visible stale-`running` recovery mechanism. They are required before any backend or framework may claim recovery from process death while a Run is durably `running`.

A leased `running` Run has:

- an execution owner identity supplied by the framework/host
- a monotonically changing fencing token for compare-and-swap ownership checks
- a lease expiry timestamp in kernel time
- renewal semantics that keep the Run `running` only while the current owner can prove possession of the latest token

Lease renewal succeeds only for the current owner/token pair and only while the Run remains `running`. Renewal never applies to `paused`, `completed`, or `failed` Runs.

#### Stale Running Preemption

When a `running` Run's lease has expired, a framework/host owner may preempt it through an explicit kernel operation. Preemption is not cooperative cancellation; it is recovery from an owner that may be dead.

Preemption MUST be atomic:

1. Verify the Run is still `running`.
2. Verify the previous lease has expired.
3. Install a new fencing token or record the preempting owner.
4. Preserve durable staged work using the same reactive-checkpoint rule as `run.complete(...)` when staged work is verifiably complete.
5. Mark the superseded Run as `failed` with a durable preemption reason.
6. Return recovery state for creating a replacement Run from the resulting Branch head.

The replacement execution MUST be a new Run. Reopening the stale Run is illegal because it weakens the Run status transition model and makes audit history ambiguous.

### 5.3 Turn

One user-visible interaction unit. A semantic span over a contiguous segment of TurnNodes.

```
Turn
├─ id: string
├─ threadId: string
├─ branchId: string
├─ parentTurnId: string | null     // immediate previous semantic Turn in same Thread
├─ startTurnNodeHash: Hash
└─ headTurnNodeHash: Hash        // advances as TurnNodes are created
```

- **Identity**: `turnId`, unique.
- **Mutation authority**: Created by the framework via `turn.create`. Head updated via `turn.updateHead`.

A Turn may be served by multiple Runs if execution pauses and resumes.

#### Turn Operations

```
turn.create(id, threadId, branchId, parentTurnId?, startTurnNodeHash) → Turn
turn.get(id) → Turn | null
turn.updateHead(id, headTurnNodeHash) → void
```

`turn.updateHead` validates that the new head is a descendant of `startTurnNodeHash` by lineage walk.

### 5.4 Events

Events are not a kernel primitive. They are framework-defined Objects.

The framework creates an Object via `store.put` with whatever structure it chooses and passes the resulting hash as `eventHash` to `run.completeStep` or `run.complete`. The kernel stores the link on the TurnNode. The kernel never reads the content. If not provided, `eventHash` is null.

### 5.5 Checkpoint Transaction

The core durability guarantee.

```
CHECKPOINT TRANSACTION (atomic):

  precondition:
    - All Objects referenced by StagedResults exist in durable storage
    - Run is active on the specified Branch
    - If treeHash provided: TurnTree must exist and use the Run's schemaId

  operations:
    1. Determine TurnTree:
       a. If treeHash provided by framework: use it directly
       b. Otherwise: construct via incorporate(baseTurnTree, stagedResults)
    2. Write TurnTree to object store (if constructed in 1b)
    3. If eventHash provided, verify event Object exists
    4. Write TurnNode referencing:
       - previousTurnNodeHash: current Branch Head
       - turnTreeHash: from step 1
       - eventHash: provided or null
       - consumedStagedResults: current Run staging
       - schemaId: from Run's schemaId
    5. Advance Branch Head to new TurnNode
    6. Clear Run's staging state

  postcondition:
    EITHER all are durable and visible
    OR none are visible — staging intact, Branch Head unchanged

  crash recovery:
    TurnNode exists → checkpoint succeeded
    TurnNode absent → checkpoint failed (retry from intact StagedResults)
```

When `treeHash` is provided, the framework has constructed the TurnTree via `tree.create` before calling `completeStep`. StagedResults are still consumed and recorded on the TurnNode — they document what work was performed, preserving the recovery protocol.

### 5.6 Checkpoint Obligations

**Planned checkpoints**: after any step where `!deterministic || sideEffects`.

**Reactive checkpoints**: on any Run termination with un-anchored StagedResults. The kernel creates a TurnNode before halting, using the schema's incorporation rules autonomously.

```
Kernel receives Run-terminating signal:
  If staging.current(runId) is non-empty → execute checkpoint transaction, then stop
  If staging.current(runId) is empty → just stop
```

### 5.7 Recovery Protocol

Seven crash classes with defined postconditions:

**Class 1: Crash during step, no StagedResults yet.**
Last TurnNode is current. Staging empty. Re-execute the interrupted step.

**Class 2: Crash during step, some StagedResults durable.**
StagedResults readable via `staging.current(runId)`. New Run reads them via `run.recover()`, skips completed tasks, executes remaining.

**Class 3: Crash during checkpoint transaction.**
All-or-nothing. TurnNode exists → succeeded. Absent → failed, retry from StagedResults.

**Class 4: Crash between completeStep and next beginStep.**
Fully consistent. Resume at next step.

**Class 5: Crash during run.complete.**
Same as Class 3.

**Class 6: Object written, crash before StagedResult appended.**
Orphaned Object — harmless (immutable, content-addressed). Re-execution produces same or different hash.

**Class 7: StagedResult appended, referenced Object not yet written.**
Detectable via `store.has(objectHash)`. Invalid StagedResults treated as incomplete. Task re-executes.

**Convergence rule**: If the kernel cannot verify that work is fully durable (Object + StagedResult + TurnNode all exist), treat as incomplete and re-execute. Content-addressing makes re-execution safe.

**Class 8: Process death leaves a leased `running` Run.**
If the execution lease is still valid, another owner must not take over. If the lease is expired, stale-running preemption (§5.2) is the only valid takeover path. `paused` Runs are excluded from this crash class because they represent approval ownership, not execution ownership.

### 5.8 Execution Model

The framework drives the execution loop. The kernel enforces checkpoint obligations at step boundaries.

```
runId = framework-generated unique ID

kernel.run.create(runId, turnId, branchId, schemaId, startTurnNodeHash, steps)

for step in steps:
  stepContext = kernel.run.beginStep(runId, step.id)

  composedVerdict = kernel.verdicts.compose(hookVerdicts)

  if composedVerdict is Abort or Pause:
    handle accordingly
    kernel.run.complete(runId, status, eventHash?)
    break

  // framework executes the step
  // calls kernel.staging.stage(runId, ...) for work products

  result = kernel.run.completeStep(runId, step.id, eventHash?, observeResults?, treeHash?)
  // kernel enforces checkpoint if (!step.deterministic || step.sideEffects)

kernel.run.complete(runId, status, eventHash?)
// kernel enforces reactive checkpoint if un-anchored StagedResults exist
```

#### Run Lifecycle Operations

```
run.create(runId, turnId, branchId, schemaId, startTurnNodeHash,
           steps: StepDeclaration[]) → Run
run.beginStep(runId, stepId) → StepContext
run.completeStep(runId, stepId, eventHash?,
                 observeResults?: ObserveResult[],
                 treeHash?: Hash) →
                 { checkpointed: boolean, turnNodeHash?: Hash }
run.complete(runId, status: completed | failed | paused,
             eventHash?) → { turnNodeHash?: Hash }
run.recover(runId) → RecoveryState
```

**`create`** validates: unique `runId`, `turnId` exists, `branchId` exists and belongs to the correct Thread, `schemaId` exists, Branch Head matches `startTurnNodeHash`, no `running` or `paused` Run on Branch.

**`beginStep`** returns `StepContext`: current TurnNode hash, schema, step declaration, signals from previous observe hooks.

**`completeStep`** checks step declaration flags and executes checkpoint transaction if required. If `treeHash` provided, uses it instead of constructing via `tree.incorporate`. Returns whether checkpoint was created.

**`complete`** executes reactive checkpoint if un-anchored StagedResults exist.

**`recover`** returns:

```
RecoveryState
├─ lastTurnNodeHash: Hash
├─ consumedStagedResults: StagedResult[]       // from last TurnNode
├─ uncommittedStagedResults: StagedResult[]    // durable but not yet checkpointed
├─ stepSequence: StepDeclaration[]
└─ lastCompletedStepId: string | null
```

---

## 6. Verdict Algebra

### 6.1 Verdicts

```
Verdict
├─ Proceed                      // no objection
├─ Abort(disposition, reason)
│  ├─ disposition
│  │  ├─ HardFail               // propagate as error, stop the Run
│  │  ├─ SoftFail               // persist as error event, Run continues
│  │  └─ EndTurn                // graceful termination
│  └─ reason: string
├─ Modify(transform)            // declarative description of changes
│  └─ transform: opaque
├─ Pause(reason, resumptionSchema)
│  ├─ reason: string
│  └─ resumptionSchema: opaque
└─ Retry(adjustment)
   └─ adjustment: opaque
```

**Modify** returns a transform — a declarative description. The framework interprets it. The kernel composes multiple transforms in registration order.

**Pause** suspends the Run. `run.complete(runId, paused, ...)` handles persistence. Resumption starts a new Run from that TurnNode.

### 6.2 Composition Rule

```
Abort > Pause > Modify > Retry > Proceed
```

First-objection-wins. Fixed kernel mechanism.

### 6.3 Hook Points

The kernel provides exactly `2n + 2` hook points for an n-step sequence:

- `before:{stepId}` for each declared step.
- `after:{stepId}` for each declared step.
- `turn:complete` — after the Turn finishes.
- `run:complete` — after the Run finishes.

Named aliases (e.g., `PreToolExecution`) are framework sugar, not kernel concepts.

### 6.4 ObserveResult

```
ObserveResult
├─ annotations: Object[]         // persisted by kernel at completeStep
└─ signals: Signal[]             // ephemeral within the Run
```

### 6.5 Verdict Composition Operation

```
verdicts.compose(verdicts: Verdict[]) → ComposedVerdict
```

Pure algebra. The framework manages hook registration, execution, and timeout. The framework collects verdicts and passes them to the kernel for composition.

---

## 7. Syscall Surface

28 operations. 10 groups. Every operation carries explicit identity for all scoped entities.

```
// ─── Object Store (3) ────────────────────────────────────────────
store.put(blob) → hash
store.get(hash) → blob | null
store.has(hash) → boolean

// ─── TurnTree Schema (2) ────────────────────────────────────────
schema.register(schema: TurnTreeSchema) → schemaId
schema.get(schemaId) → TurnTreeSchema | null

// ─── TurnTree Operations (5) ────────────────────────────────────
tree.create(schemaId, changes, baseTurnTreeHash?) → treeHash
tree.incorporate(baseTurnTreeHash, stagedResults) → treeHash
tree.diff(treeHashA, treeHashB) → changedPaths[]
tree.resolve(treeHash, path) → PathValue
tree.manifest(treeHash) → Record<path, PathValue>

// ─── TurnNode Operations (2) ────────────────────────────────────
node.get(hash) → TurnNode | null
node.walkBack(fromHash) → Iterator<TurnNode>

// ─── Thread (2) ─────────────────────────────────────────────────
thread.create(threadId, schemaId, initialBranchId) → ThreadCreateResult
thread.get(threadId) → Thread | null

// ─── Branch (4) ─────────────────────────────────────────────────
branch.create(branchId, threadId, fromTurnNodeHash) → Branch
branch.get(branchId) → Branch | null
branch.setHead(branchId, turnNodeHash) → SetHeadResult
branch.list(threadId) → [branchId, Hash][]

// ─── Staging (2) ────────────────────────────────────────────────
staging.stage(runId, blob, taskId, objectType, status,
              interruptPayload?) → { objectHash, stagedResult }
staging.current(runId) → StagedResult[]

// ─── Run Lifecycle (5) ──────────────────────────────────────────
run.create(runId, turnId, branchId, schemaId,
           startTurnNodeHash, steps) → Run
run.beginStep(runId, stepId) → StepContext
run.completeStep(runId, stepId, eventHash?,
                 observeResults?, treeHash?) →
                 { checkpointed: boolean, turnNodeHash?: Hash }
run.complete(runId, status, eventHash?) → { turnNodeHash?: Hash }
run.recover(runId) → RecoveryState

// ─── Verdict Algebra (1) ────────────────────────────────────────
verdicts.compose(verdicts: Verdict[]) → ComposedVerdict

// ─── Turn Lifecycle (3) ─────────────────────────────────────────
turn.create(id, threadId, branchId, parentTurnId?, startTurnNodeHash) → Turn
turn.get(id) → Turn | null
turn.updateHead(id, headTurnNodeHash) → void
```

---

## 8. Invariants and Storage Contract

### 8.1 Storage Contract

The kernel defines its persistence requirements as **observable behavioral guarantees**, not as a dependency on any specific storage product, database category, or deployment topology. Any storage backend or combination of backends is acceptable if and only if the implementation as a whole satisfies every guarantee below.

**Required semantics:**

- **Atomic single-entity writes**: `store.put` and status updates are all-or-nothing. An Object either exists in durable storage or it does not.
- **Atomic multi-entity writes**: `staging.stage` (Object + StagedResult) and checkpoint transactions (TurnTree + TurnNode + Branch Head + staging clear) commit atomically. Either all entities become visible together, or none do.
- **Durable visibility**: once committed, subsequent reads see the committed state, even after process restart.
- **Read-after-write consistency**: within the same writer, reads after a committed write always reflect the write.

**Implementation freedom**: The kernel does not prescribe a storage engine, schema shape, or deployment model. A single embedded database, a distributed store with coordination, a multi-backend architecture splitting objects from metadata — all are valid choices provided the behavioral guarantees hold. Concrete technologies (SQLite, PostgreSQL, S3, etc.) are illustrative examples, not normative anchors. Backends may maintain derived indexes for access paths such as lineage proof acceleration, but those indexes must be rebuildable from canonical records and must not change observable kernel semantics.

**Non-transactional backends**: Storage substrates that do not natively provide the required atomicity or durability guarantees are acceptable only when wrapped in an adapter or coordination layer that restores those guarantees at the boundary the kernel observes. The kernel contract is satisfied by the observable behavior of the storage surface it calls, not by the internal properties of any individual component behind that surface.

Backend choice is an implementation concern. Correctness semantics are not.

### 8.2 Kernel Invariants

1. **Object immutability.** Once created, an Object's content and Hash never change.
2. **Structural sharing.** TurnTree construction reuses unchanged subtree hashes.
3. **Schema-driven structure.** TurnTrees conform to registered schemas. The kernel enforces validity without interpreting semantics.
4. **Atomic steps.** The kernel sees each step as indivisible.
5. **Declarative checkpointing.** TurnNodes after steps where `!deterministic || sideEffects`, plus reactive checkpointing on unplanned stops.
6. **Checkpoint atomicity.** TurnNode + TurnTree + Branch Head advancement — all or nothing.
7. **Persistence authority.** Only the kernel writes Objects, appends StagedResults, creates TurnNodes, and advances Branch Heads.
8. **Verdict algebra.** Fixed priority: `Abort > Pause > Modify > Retry > Proceed`.
9. **Opaque content.** The kernel never interprets content, types, metadata, transforms, or event Objects.
10. **History integrity.** Append-only DAG. TurnNodes record `schemaId`, previous node, consumed StagedResults.
11. **Recovery convergence.** Unverifiable work is incomplete. Re-execution is safe.
12. **No upcalls.** The kernel never calls framework code.
13. **Explicit scoping.** Every run-scoped operation carries `runId`. No ambient state.
14. **Structural containment.** Branches belong to Threads. One Head per Branch. Threads bootstrap atomically.
15. **Durable staging.** StagedResults survive crashes for parallel work safety.
16. **Lineage-proven membership.** Every TurnNode reference validated against the parent-linked path to the Thread root. Cross-thread references rejected.
17. **No orphaned TurnNodes.** Backward `branch.setHead` archives abandoned segment.
18. **Paused blocks Branch.** No new Run creation on a Branch with a `paused` or `running` Run.

---

## Appendix A: State Transition Legality

### Run Status Transitions

```
                 ┌──────────┐
    run.create → │ running  │
                 └────┬─────┘
                      │
         ┌────────────┼───────────┐
         ▼            ▼           ▼
    ┌─────────┐  ┌─────────┐  ┌────────┐
    │completed│  │ failed  │  │ paused │
    └─────────┘  └─────────┘  └───┬────┘
                      ▲           │
                      └───────────┘  (new Run from pause point;
                                      old Run must be failed first)
```

| From    | To        | Trigger                                                                      |
| ------- | --------- | ---------------------------------------------------------------------------- |
| —       | running   | `run.create`                                                                 |
| running | completed | `run.complete(runId, completed, ...)`                                        |
| running | failed    | `run.complete(runId, failed, ...)` or archival rollback                      |
| running | failed    | stale-running preemption after lease expiry                                  |
| running | paused    | `run.complete(runId, paused, ...)`                                           |
| paused  | failed    | Framework explicitly resolves the paused Run as failed, or archival rollback |

**Illegal**: `completed → *`, `failed → *`, `paused → completed`, `paused → running`.

### Branch Head Movement

| Direction | Detection                                       | Kernel behavior                                            |
| --------- | ----------------------------------------------- | ---------------------------------------------------------- |
| Forward   | Current Head reachable walking back from target | Atomic pointer update                                      |
| Backward  | Target reachable walking back from current Head | Archive old Head as new Branch, fail active Runs, move ptr |
| Lateral   | Neither walk connects                           | **Rejected**                                               |

### Run Creation Legality

`run.create` succeeds only if: `runId` unique, `turnId` exists, `branchId` exists and belongs to correct Thread, `schemaId` registered, Branch Head matches `startTurnNodeHash`, no `running` or `paused` Run on Branch.

### Turn Update Legality

`turn.updateHead` succeeds only if `headTurnNodeHash` is a descendant of `startTurnNodeHash` by lineage walk.

---

## Appendix B: Validation Rules by Operation

### Object Store

**`store.put(blob)`** — No preconditions. Idempotent.

**`store.get(hash)`** — Returns blob or null.

**`store.has(hash)`** — Returns boolean.

### Schema

**`schema.register(schema)`** — `schemaId` must be unique. No duplicate paths. Collection types must be `ordered` or `single`. All incorporation rule `targetPath` values must exist in `paths`. No duplicate `objectType` values.

**`schema.get(schemaId)`** — Returns schema or null.

### TurnTree

**`tree.create(schemaId, changes, baseTurnTreeHash?)`** — `schemaId` must be registered. If `baseTurnTreeHash`: must exist. If no base: all schema paths must be in `changes`. Each path must exist in schema. Each value must match collection kind.

**`tree.incorporate(baseTurnTreeHash, stagedResults)`** — Base must exist. Each StagedResult's `objectType` must have a matching incorporation rule.

**`tree.diff(treeHashA, treeHashB)`** — Both must exist. Both must share the same `schemaId`.

**`tree.resolve(treeHash, path)`** — Tree must exist. Path must exist in schema.

**`tree.manifest(treeHash)`** — Tree must exist.

### TurnNode

**`node.get(hash)`** — Returns TurnNode or null.

**`node.walkBack(fromHash)`** — `fromHash` must be a valid TurnNode.

### Thread

**`thread.create(threadId, schemaId, initialBranchId)`** — `threadId` unique. `schemaId` registered. `initialBranchId` unique.

**`thread.get(threadId)`** — Returns Thread or null.

### Branch

**`branch.create(branchId, threadId, fromTurnNodeHash)`** — `branchId` unique. `threadId` exists. `fromTurnNodeHash` exists and belongs to Thread by lineage walk.

**`branch.get(branchId)`** — Returns Branch or null.

**`branch.setHead(branchId, turnNodeHash)`** — `branchId` exists. `turnNodeHash` exists and belongs to Thread by lineage walk. Directional relationship must be forward or backward (lateral rejected). If backward: atomic archival.

**`branch.list(threadId)`** — `threadId` exists.

### Staging

**`staging.stage(runId, blob, taskId, objectType, status, interruptPayload?)`** — `runId` must exist and be `running`.

**`staging.current(runId)`** — `runId` must exist.

### Run Lifecycle

**`run.create(runId, turnId, branchId, schemaId, startTurnNodeHash, steps)`** — See Run Creation Legality (Appendix A). Step IDs must be unique within the sequence.

**`run.beginStep(runId, stepId)`** — `runId` must be `running`. `stepId` must match next expected step.

**`run.completeStep(runId, stepId, eventHash?, observeResults?, treeHash?)`** — `runId` must be `running`. `stepId` must match current step. If `eventHash`: Object must exist. If `treeHash`: TurnTree must exist with matching `schemaId`.

**`run.complete(runId, status, eventHash?)`** — If `runId` is `running`, `status` must be `completed`, `failed`, or `paused`. If `runId` is `paused`, `status` must be `failed`. If `eventHash`: Object must exist.

**`run.recover(runId)`** — `runId` must exist.

### Verdict Algebra

**`verdicts.compose(verdicts)`** — Pure function. No preconditions.

### Turn Lifecycle

**`turn.create(id, threadId, branchId, parentTurnId?, startTurnNodeHash)`** — `id` unique. `threadId` exists. `branchId` exists and belongs to the same Thread. If `parentTurnId`: must exist, belong to the same Thread, and chain contiguously into `startTurnNodeHash`; forked Branches may reference the source Branch head Turn as their first semantic parent. `startTurnNodeHash` must exist and belong to Thread by lineage walk.

**`turn.get(id)`** — Returns Turn or null.

**`turn.updateHead(id, headTurnNodeHash)`** — Turn must exist. `headTurnNodeHash` must exist and be a descendant of `startTurnNodeHash`.

---

## Appendix C: Primitive Summary

**Storage**: Object, Blob, Hash.

**Structure**: TurnTreeSchema (`ordered` and `single` paths, opaque `schemaId`), TurnTree, TurnNode (optional opaque `eventHash`), StagedResult (durable, run-scoped).

**Containment**: Thread (`rootTurnNodeHash` anchor), Branch (kernel-enforced single Head, archival rollback).

**Lifecycle**: Turn, Run (explicit `runId`, `branchId`, `schemaId`; paused blocks Branch), StepDeclaration.

**Transactions**: Checkpoint Transaction (atomic: TurnNode + TurnTree + Branch Head + staging clear).

**Verdicts**: Verdict (Proceed, Abort, Modify, Pause, Retry), ObserveResult, ComposedVerdict.

**Containment proofs**: Lineage walk to Thread root for membership, direction detection, and cross-thread rejection.

**Deferred**: Merge rules for branches. Garbage collection of unreferenced Objects and archive Branches.

---

_v0.9. Kernel has 28 operations, 18 invariants, 10 operation groups. Frozen. Companion rationale is explanatory only and non-contract._
