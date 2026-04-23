# Kraken Kernel — Design Rationale

**Companion to**: Kernel Specification
**Purpose**: Decision archaeology, design reasoning, and illustrative stories. Not contract — the Kernel Specification is authoritative.

Read after `KrakenKernelSpecification.md`. This document explains decisions; it does not define the contract.

Kraken is the execution engine inside Tuvren Runtime, so this rationale stays intentionally engine-focused.

---

## 1. Design Philosophy

### 1.1 Mechanism vs. Policy

The kernel follows the Unix principle. In Unix, the kernel provides mechanism — process scheduling, file operations, memory pages, IPC primitives. It never decides what programs to run, how to parse commands, or what file formats to use. Those are userland concerns.

In Kraken, the kernel provides mechanism — object storage, tree construction, DAG linking, checkpoint enforcement, verdict algebra. It never decides what content means, what execution steps exist, what hooks check, or how context is assembled. Those are framework concerns.

### 1.2 The Narrow Waist

The content-addressed structural model is the stable center:

```
Objects + Hashes + TurnTrees + TurnNodes + StagedResults
```

Everything above this (execution patterns, context assembly, hook configurations) can vary by use case. Everything below this (storage backends, transport, serialization) can vary by deployment. The structural model is stable.

### 1.3 Why Content-Addressed Storage

Content-addressed storage makes several properties fall out naturally:

- **Deduplication is free.** Two identical messages produce the same hash. No coordination needed.
- **Structural sharing is automatic.** Unchanged subtrees reuse the same hashes. State snapshots are cheap.
- **Recovery is safe.** Re-executing a step that produces the same output creates no conflict. The Object already exists.
- **Integrity is provable.** Hash chains form a Merkle DAG. Tampering is detectable.

The alternative — mutable state with journaling — requires explicit versioning, explicit conflict resolution, and explicit deduplication. Content-addressing eliminates these concerns by making identity structural.

### 1.4 Why No Upcalls

The boundary is a protocol, not an API. The kernel never calls framework code for any reason, including:

- Reactive checkpointing during crashes (the kernel has incorporation rules as data)
- Schema interpretation (the kernel has the schema as data)
- Step-specific logic (the kernel has step declarations as data)

This enables the kernel to be implemented in a native language (Rust, Go, C) with the framework as an SDK in a higher-level language (TypeScript, Python). The FFI boundary is data-in, data-out.

### 1.5 Why Events Were Demoted

In v0.4, Events were kernel primitives with defined fields and their own operations. In v0.5, Events were demoted to opaque Objects. The kernel stores an optional `eventHash` on each TurnNode and never reads its content.

The reason: the kernel cannot interpret event semantics without knowing what happened, and knowing what happened is a framework concern. "Model call completed" and "user input received" are framework vocabulary. The kernel should store the link and leave the interpretation to the framework.

This reduced the syscall count from 30 to 28 and eliminated a category of kernel-framework coupling.

---

## 2. Version History

### 2.1 v0.4 → v0.5 (Hardening)

No new concepts. Concept count decreased by one.

- **Lineage-Based Containment**: Every operation accepting a TurnNode hash validates membership by lineage walk to Thread root. Cross-thread references become structurally impossible.
- **Archival Rollback**: Backward `branch.setHead` is an atomic compound operation — archive, fail active Runs, move pointer. No orphaned TurnNodes.
- **Schema Identity Normalized**: Single opaque `schemaId` string. The separate `version` field was removed. Schema evolution is a framework concern.
- **Lifecycle Legality Formalized**: Paused is blocking. Explicit state transition tables.
- **Storage Contract**: Single-writer ACID transactions formalized as the minimum backend guarantee.
- **Event Demoted**: Event operations removed. `eventHash` is an opaque Object reference on TurnNode.
- **Validation Rules by Operation**: Every syscall got explicit precondition documentation.

### 2.2 v0.5 → v0.6 (Framework Operationalization)

One kernel clarification. No new concepts. Syscall and invariant counts unchanged.

- **Framework-Constructed Checkpoints**: `run.completeStep` accepts an optional `treeHash` parameter. When provided, the checkpoint uses the pre-built TurnTree instead of constructing one from StagedResults. This enables context engineering operations (summarization, replacement, insertion, deletion, reordering) to be committed through the standard Run lifecycle. Without this, the only operation available through checkpointing was append.

### 2.3 v0.8 → v0.9 (Semantic Turn Lineage Hardening)

One kernel validation tightening. Syscall and invariant counts unchanged.

- **Same-thread Turn parenting**: `parentTurnId` remains a kernel Turn field, but validation now requires that any parent Turn belong to the same Thread. This matches the framework's use of `parentTurnId` as load-bearing semantic lineage rather than loose metadata.

### 2.4 What Was Removed and Why

| Concept                   | Removed in | Reason                                                                                                                          |
| ------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Generic Refs              | v0.4       | Insufficient type safety. Replaced by schema-driven typed paths.                                                                |
| Keyed Collections         | v0.4       | Added complexity for a use case (named lookup) better served by framework-level indexing over ordered paths.                    |
| Workers as kernel concept | v0.4       | Multi-agent coordination is a framework pattern, not a kernel primitive. Workers are independent Threads with independent Runs. |
| Event as kernel primitive | v0.5       | Kernel cannot interpret event semantics. Demoted to opaque Object with optional `eventHash` on TurnNode.                        |
| Schema `version` field    | v0.5       | Schema evolution is a framework concern. Kernel identifies schemas by opaque `schemaId`.                                        |

---

## 3. Execution Stories

These stories illustrate kernel syscall patterns using example framework step sequences. The specific steps shown (context_assembly, model_call, tool_execution) are framework choices, not kernel requirements.

### 3.1 Multi-Iteration Tool Use

A user asks: "Compare three providers and recommend one."

**Step 1 — context_assembly** (deterministic: true). `beginStep`, framework reads TurnTree, selects relevant turns, prunes stale content. Selection stored via `store.put`. `completeStep` — deterministic, **no TurnNode**.

**Step 2 — rendering** (deterministic: true). Framework transforms selection into provider payload. `store.put`. `completeStep` — deterministic, **no TurnNode**.

**Step 3 — model_call** (deterministic: false). Framework sends payload, parses response, stages via `staging.stage`. Event Object via `store.put`. `completeStep(eventHash)` — non-deterministic, **checkpoint: TurnNode created, Branch Head advanced**.

**Step 4 — response_normalization** (deterministic: true). Normalize into canonical Objects. **No TurnNode**.

**Step 5 — tool_execution** (deterministic: false, sideEffects: true). Three tool calls in parallel. Each staged via `staging.stage`. One retries internally. `completeStep(eventHash)` — side effects, **checkpoint**.

Framework evaluates: model requested tools, another iteration needed. Loop back to step 1 with updated state.

**Completion**: `run.complete(runId, completed, eventHash)`. Reactive checkpoint if un-anchored. `turn.updateHead`.

### 3.2 HITL Approval Pause and Resume

A user asks: "Deploy the updated config to staging."

Steps 1–3 proceed normally. Model responds with four tool calls. **TurnNode created** (post-model checkpoint).

**Step 5 — tool_execution.** Tool 1 (validate_config) executes and stages. Tool 2 (backup_current) executes and stages. Tool 3 (deploy_config): framework's hook returns Pause.

Framework calls `verdicts.compose([Pause(...)])` → Pause. Stores pause event. Calls `run.complete(runId, paused, eventHash)`.

**Reactive checkpoint**: Un-anchored StagedResults (two tool results). Kernel executes checkpoint transaction. TurnNode created with incorporated tool results. Branch Head advanced. Run A terminates as `paused`.

**Resumption**: Human approves. Framework fails Run A to unblock Branch. Creates Run B for the same Turn, starting from the pause TurnNode. `run.recover(runB_id)` returns consumed StagedResults showing t1 and t2 completed.

Run B skips t1, t2. Executes t3, t4. **Checkpoint**. Model synthesizes response. Turn completes.

```
Turn 15
├─ Run A: TN_model → TN_pause                     (paused → failed)
└─ Run B: TN_pause → TN_tools → ... → TN_final    (completed)
```

One Turn. Two Runs. No re-execution of completed tools.

### 3.3 Context Engineering — Pruning and Substitution

A conversation has 13 items. The framework wants to prune items 5–6 and substitute item 6's content.

**Pruning (projection)**: Framework reads TurnTree via `tree.manifest`. Builds selection Object including items 1–4, 7–13, omitting 5–6. Stored via `store.put`. Full state remains in the DAG. Pruning is a projection — a new view, not a mutation.

**Substitution (mutation)**: Framework creates updated Object: `store.put(updatedBlob) → hash_6_new`. Builds new TurnTree: `tree.create(schemaId, { "tools.results": [hash_3, hash_4, hash_6_new, hash_9, hash_12] }, baseTurnTreeHash)`. Only the changed path gets new hashes. Everything else reused.

Both produce new immutable state. Old TurnNodes retain old TurnTrees. History preserved.

Three things framework steps can do to state: **append** (add new objects), **substitute** (replace a ref at a position), **project** (select a subset of refs). All produce a new TurnTree via `tree.create` or `tree.incorporate`.

### 3.4 Rollback with Archival Branch

An agent has executed 10 turns. Turns 8–10 went wrong. User wants to roll back to Turn 7.

Framework calls `branch.setHead("main", TN7_final_hash)`. Kernel detects backward movement:

1. Creates `archive_<timestamp>` Branch with Head at current (pre-rollback) Head — preserving TN8, TN9, TN10.
2. Fails any `running` or `paused` Runs on the archived segment.
3. Moves `main` Branch Head to TN7_final.

Abandoned TurnNodes still exist, reachable via archive Branch. New TurnNodes on `main` link back to TN7_final, creating a divergent path. History preserved. Rollback is pointer arithmetic plus archival, not data deletion.

---

## 4. Design Decisions

### 4.1 Why StagedResults Are Durable

StagedResults survive crashes by design. This is essential for parallel work within a step: if three of four parallel tasks complete before a crash, their results survive. Recovery skips completed tasks and executes only the remaining ones.

The alternative — ephemeral staging — would require re-executing all parallel tasks on every crash, potentially duplicating side effects and wasting computation.

### 4.2 Why One Active Run Per Branch

This prevents concurrent mutation of the same Branch's state. Two Runs creating TurnNodes on the same Branch would create a fork without a Branch — violating the single-Head invariant. The constraint is enforced at `run.create` time.

Multi-agent concurrency uses separate Threads (separate Branches), not concurrent Runs on the same Branch.

### 4.3 Why Paused Blocks Branch

A paused Run represents a pending external decision (human approval, external system response). Until that decision arrives, no new work should proceed on the same Branch — the next state depends on the decision. If new work ran and then the decision arrived, the Branch would need to merge two lineages, which the kernel does not support.

### 4.4 What's Deferred and Why

**Merge rules for branches**: Merging two divergent TurnNode chains requires semantic understanding of content (conflict resolution). This is fundamentally a framework concern. The kernel provides the structural primitives (branching, lineage detection) but not the policy.

**Garbage collection**: Orphaned Objects and archive Branches accumulate over time. GC requires knowing what is "unreachable," which depends on application semantics (is the archive still needed? are old Objects still referenced by external systems?). Deferred until usage patterns clarify the right policy.

---

_This document records the reasoning behind kernel design decisions. Read it after the kernel specification. It is not authoritative for implementation — the Kernel Specification is the contract._
