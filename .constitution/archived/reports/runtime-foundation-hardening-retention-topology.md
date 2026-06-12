# Runtime Foundation Hardening Retention Topology

## Scope

This report closes `KRT-J005`.

No destructive cleanup is implemented in this pass. The Kernel Spec currently
defers garbage collection of unreferenced Objects and archive Branches, and the
kernel preserves committed history. This report defines the topology future
cleanup must respect before any deletion code exists.

## Retention Roots

The default safe posture is full retention. Destructive cleanup requires an
explicit host-authorized retention policy.

Future retention should treat the following as roots unless the host policy
explicitly says otherwise:

- Thread genesis roots: every retained Thread root TurnNode.
- Branch heads: every retained active or archived Branch head.
- Turn spans: retained Turn start and head TurnNodes.
- Active work: every `running` or `paused` Run, its start TurnNode, created
  TurnNodes, and current StagedResults.
- Audit pins: host-authorized Thread, Branch, Turn, Run, TurnNode, TurnTree, and
  Object pins.
- Schema roots: schemas needed to interpret retained TurnTrees and TurnNodes.

Archived Branches are retention roots by default because rollback archival is
the mechanism that prevents abandoned segments from becoming orphaned history.

## Reachability Strategy

TurnNode reachability:

- Start from retained Branch heads, retained Turn heads, active Run starts, and
  host-pinned TurnNodes.
- Walk `previous_turn_node_hash` recursively back to each Thread root.
- Use the existing `turn_nodes(previous_turn_node_hash)` access path for
  lineage traversal.

TurnTree reachability:

- Every reachable TurnNode retains its `turn_tree_hash`.
- Every retained TurnTree retains its `turn_tree_paths` rows.
- Ordered chunk reachability must follow ordered path chunk references.

Object reachability:

- `turn_nodes.event_hash` retains event Objects.
- `turn_tree_paths.single_hash` retains single-path Objects.
- Ordered path inline values and ordered chunks retain their referenced Objects.
- Consumed StagedResults embedded in reachable TurnNodes retain their Objects.
- Current StagedResults for retained Runs retain their Objects.

Run reachability:

- Retained Turns retain their Runs as audit records.
- Active `running` and `paused` Runs are always retained.
- StagedResults are retained when their Run is retained and the results have not
  been checkpointed into a retained TurnNode.

Schema reachability:

- Retained Threads, TurnNodes, TurnTrees, and Runs retain their `schemaId`.

## SQLite Readiness

The SQLite backend now has additional indexes that help localized validation and
future topology queries:

- `turn_node_lineage_roots(root_turn_node_hash, depth)`.
- `threads(root_turn_node_hash)`.
- `branches(archived_from_branch_id)`.
- `turns(thread_id, branch_id, head_turn_node_hash)`.

The repository also contains a mark-only retention proof:

```bash
bun run nx run backend-sqlite:retention-dry-run
```

The command seeds a SQLite database with retained TurnNodes, a TurnTree with
chunked ordered paths, Objects, a Run, and StagedResults. It computes the
retained graph from Thread, Branch, Turn, and active Run roots, follows TurnTree
path and ordered chunk references, emits a JSON summary, and asserts row counts
are unchanged before and after the dry run.

The validated dry run retains 43 Objects, 2 ordered chunks, 1 Run, 1 Schema, 1
StagedResult, 1 Thread, 1 Turn, 2 TurnNodes, 1 TurnTree, and 2 TurnTree paths
with `rowCountsUnchanged: true`.

Future destructive cleanup still needs more design before implementation:

- Encoded CBOR edge fields need either safe application-side decoding during
  mark phase or materialized edge tables. This affects TurnNode consumed
  StagedResults, ordered inline path refs, ordered chunk lists, and chunk item
  refs.
- Retention by Turn span would benefit from direct start/head access paths once
  the exact policy queries are specified.
- Liveness-aware cleanup must wait for the Run lease/preemption specification so
  active work is not misclassified as garbage.

## Guardrails

Cleanup must be mark-and-sweep from authorized roots, never ad hoc deletion by
age or status alone.

Compaction that preserves audit semantics is a separate feature from destructive
correction of corrupt state. Corruption remains a health and recovery concern,
not a garbage-collection excuse.
