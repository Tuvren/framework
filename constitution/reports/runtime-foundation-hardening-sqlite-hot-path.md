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

| Case                            |        History | Baseline best per iter | After best per iter |
| ------------------------------- | -------------: | ---------------------: | ------------------: |
| no-op transaction               |    0 TurnNodes |                3.886ms |             8.538us |
| single object write transaction |    0 TurnNodes |                5.671ms |           237.195us |
| no-op transaction               |  100 TurnNodes |               20.866ms |             8.509us |
| single object write transaction |  100 TurnNodes |               21.767ms |           212.636us |
| no-op transaction               |  500 TurnNodes |               87.783ms |             6.728us |
| single object write transaction |  500 TurnNodes |               83.864ms |           198.782us |
| no-op transaction               | 1000 TurnNodes |              164.985ms |             6.712us |
| single object write transaction | 1000 TurnNodes |              161.297ms |           165.602us |

The target claim is narrow: ordinary transactions no longer pay for a full
database reload and full-state validation. Lineage-sensitive operations are
still more expensive than no-op writes because normal writes validate the
lineage metadata rows they trust against the canonical parent-linked chain.
No-op and small object writes still do not scale with persisted history.

## Lineage Depth Results

The benchmark also includes depth-sensitive lineage cases so the recursive CTE
path remains visible over time.

| Case                                      |        History | After best per iter |
| ----------------------------------------- | -------------: | ------------------: |
| deep branch membership transaction        |    0 TurnNodes |           310.661us |
| deep branch forward transaction           |    0 TurnNodes |           426.735us |
| deep branch non-root forward transaction  |    0 TurnNodes |           391.742us |
| deep branch non-root rollback transaction |    0 TurnNodes |           292.633us |
| deep branch membership transaction        |  100 TurnNodes |           374.701us |
| deep branch forward transaction           |  100 TurnNodes |           947.669us |
| deep branch non-root forward transaction  |  100 TurnNodes |             1.727ms |
| deep branch non-root rollback transaction |  100 TurnNodes |             2.840ms |
| deep branch membership transaction        |  500 TurnNodes |           766.662us |
| deep branch forward transaction           |  500 TurnNodes |             2.113ms |
| deep branch non-root forward transaction  |  500 TurnNodes |             4.707ms |
| deep branch non-root rollback transaction |  500 TurnNodes |             7.073ms |
| deep branch membership transaction        | 1000 TurnNodes |             1.239ms |
| deep branch forward transaction           | 1000 TurnNodes |             3.585ms |
| deep branch non-root forward transaction  | 1000 TurnNodes |             8.624ms |
| deep branch non-root rollback transaction | 1000 TurnNodes |            12.811ms |

The first recursive-CTE-only lineage run measured `2.891ms/iter` for 1000-depth
membership and `8.154ms/iter` for 1000-depth forward Branch movement. The
lineage root/depth index plus bounded metadata proof measured `1.239ms/iter`
and `3.585ms/iter`, respectively, in the latest run.

Lineage proofs now validate the referenced root/depth metadata row before using
it, so membership and relationship checks scale with the referenced lineage
depth. The benchmark includes membership, root-to-head forward movement,
non-root forward movement, and rollback cases so that bounded CTE paths remain
visible. The important boundary is that no-op and small object writes still do
not pay lineage traversal costs.

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
the known depth delta. Normal write validation revalidates each lineage metadata
row it uses against the canonical parent-linked TurnNode chain before trusting
that row as a thread membership or relationship proof.

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
