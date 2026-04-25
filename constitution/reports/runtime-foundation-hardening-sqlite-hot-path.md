# Runtime Foundation Hardening SQLite Hot Path

## Scope

This report closes `KRT-J001`, `KRT-J002`, and `KRT-J003`.

The SQLite backend previously used full persisted-state validation as part of
ordinary write transactions. That made no-op and small write transactions scale
with total persisted history. Epic J replaces that behavior with localized
write-set validation while preserving the full validator for explicit health and
diagnostic paths.

## Characterization

The global validation entrypoint was `loadValidatedState(db)`. Before this
change, `SqliteBackend.transact(...)` called it before user work and again
before `COMMIT`.

`loadValidatedState(db)` performs broad reads across the schema, reconstructs
complete in-memory maps, and validates cross-record invariants over the loaded
state. That remains useful for corruption diagnostics, but it is not acceptable
as the default persistent write path.

The repository now contains a reproducible benchmark:

```bash
bun run nx run backend-sqlite:bench
```

The target compiles the TypeScript benchmark with `tsc` and runs the emitted
JavaScript with Node.js because `better-sqlite3@12.8.0` is a native Node addon
binding. The benchmark prints human-readable lines and a JSON summary with
best, median, p95, and average timings. The single-object write case generates
fresh object hashes across warmup and timed samples so the measured write path
is a new object write rather than an idempotent existing-object put.

## Benchmark Results

The baseline was captured after adding the benchmark harness and before the
transaction cleanup. The after numbers were captured after localized validation
landed.

| Case | History | Baseline best per iter | After best per iter |
| --- | ---: | ---: | ---: |
| no-op transaction | 0 TurnNodes | 3.886ms | 9.711us |
| single object write transaction | 0 TurnNodes | 5.671ms | 284.362us |
| no-op transaction | 100 TurnNodes | 20.866ms | 10.925us |
| single object write transaction | 100 TurnNodes | 21.767ms | 222.042us |
| no-op transaction | 500 TurnNodes | 87.783ms | 7.397us |
| single object write transaction | 500 TurnNodes | 83.864ms | 165.111us |
| no-op transaction | 1000 TurnNodes | 164.985ms | 6.748us |
| single object write transaction | 1000 TurnNodes | 161.297ms | 160.211us |

The target claim is narrow: ordinary transactions no longer pay for a full
database reload and full-state validation. Lineage-sensitive operations are
still more expensive than no-op writes, but common membership and root-to-head
proofs now use a backend-local lineage root/depth index rather than walking the
full parent chain.

## Lineage Depth Results

The benchmark also includes depth-sensitive lineage cases so the recursive CTE
path remains visible over time.

| Case | History | After best per iter |
| --- | ---: | ---: |
| deep branch membership transaction | 0 TurnNodes | 322.913us |
| deep branch forward transaction | 0 TurnNodes | 531.614us |
| deep branch non-root forward transaction | 0 TurnNodes | 361.041us |
| deep branch non-root rollback transaction | 0 TurnNodes | 234.651us |
| deep branch membership transaction | 100 TurnNodes | 244.155us |
| deep branch forward transaction | 100 TurnNodes | 411.370us |
| deep branch non-root forward transaction | 100 TurnNodes | 576.838us |
| deep branch non-root rollback transaction | 100 TurnNodes | 885.599us |
| deep branch membership transaction | 500 TurnNodes | 230.202us |
| deep branch forward transaction | 500 TurnNodes | 358.652us |
| deep branch non-root forward transaction | 500 TurnNodes | 979.586us |
| deep branch non-root rollback transaction | 500 TurnNodes | 1.532ms |
| deep branch membership transaction | 1000 TurnNodes | 223.312us |
| deep branch forward transaction | 1000 TurnNodes | 334.122us |
| deep branch non-root forward transaction | 1000 TurnNodes | 1.270ms |
| deep branch non-root rollback transaction | 1000 TurnNodes | 2.021ms |

The first recursive-CTE-only lineage run measured `2.891ms/iter` for 1000-depth
membership and `8.154ms/iter` for 1000-depth forward Branch movement. The
lineage root/depth index reduced those cases to `223.312us/iter` and
`334.122us/iter`, respectively, in the latest run.

Non-root ancestry checks can still require bounded parent-chain traversal. The
benchmark now includes non-root forward and rollback cases so that bounded CTE
path remains visible. The important boundary is that common Thread membership
and root-to-head Branch movement no longer scale with total persisted history,
and no-op/small object writes still do not pay lineage traversal costs.

## Localized Validation Design

Normal transactions now track the records touched by the transaction and
validate only the affected records, references, active Branch/Run constraints,
archive relationships, and lineage relationships needed by those writes.

Checks that remain in the write path:

- Record shape and deterministic hash validation for records being persisted.
- Database foreign-key enforcement for direct references.
- Thread root existence and unique root ownership.
- Branch membership and directional head movement.
- Archive Branch linkage and archived source relationships.
- Turn parent, start, and head lineage.
- Run status transition shape, active Run uniqueness, Branch head alignment,
  created TurnNode canonicality, and created TurnNode containment.
- StagedResult object/run references and run-scoped staging checks.
- TurnTree path consistency for touched TurnTrees.

Checks retained for explicit diagnostics:

- Whole-database table and migration validation.
- Complete reconstruction of persisted state.
- Full-map invariant validation across already-committed history.
- Detection of historical corruption unrelated to the current write set.

The explicit diagnostic path is `backend.health()`. It still calls the
full-state validator and reports persisted corruption without putting that cost
on ordinary transactions.

## Implementation Summary

The SQLite backend now creates a transaction-local write tracker inside
`transact(...)`. Repository writes add the relevant IDs to that tracker. Before
commit, `validateTransactionWriteSet(...)` validates the touched surface against
the database.

Lineage checks use backend-local `turn_node_lineage_roots` metadata for
root/depth classification. Non-root ancestry checks fall back to a bounded
recursive CTE over `turn_nodes(previous_turn_node_hash)` using `UNION ALL` with
the known depth delta.

Migration validation now runs before applying pending migrations, so a database
that falsely records an applied migration without that migration's package
schema fails with migration-state validation instead of failing later through a
partial application path. Databases at the package's current migration have
their exact 0001 and 0002 table/index contracts validated; databases with later
known migrations still get presence validation so future migrations can
intentionally extend or rebuild earlier structures.

The schema now includes targeted validation metadata and indexes in
`0002_targeted_validation_indexes.sql`:

- `turn_node_lineage_roots` as the backend-local TurnNode root/depth metadata
  table.
- `threads(root_turn_node_hash)` as a unique index.
- `turn_node_lineage_roots(root_turn_node_hash, depth)`.
- `branches(archived_from_branch_id)`.
- `turns(thread_id, branch_id, head_turn_node_hash)`.

The SQLite test suite includes query-plan regression coverage for the lineage,
active Run, archive Branch, and Turn predecessor access paths so index drift is
detected directly.

## Validation

The cleanup is validated by:

- `bun run nx run backend-sqlite:bench`
- `bun run nx run backend-sqlite:test`
- `bun run typecheck`
- `bun run lint`

The focused tests now assert that no-op transactions are not used as corruption
diagnostics, while `backend.health()` still reports broken committed state,
missing schema tables, missing or mismatched required indexes, mismatched
applied migration table contracts, corrupted lineage metadata, and query-plan
index regressions.
