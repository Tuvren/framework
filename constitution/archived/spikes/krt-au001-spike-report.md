# KRT-AU001 Spike Report: Checkpoint Atomicity and Crash-Recovery Characterization

## Scope

Characterization covered the three official kernel backends named in Epic AU:

- `memory` for the in-process atomicity and concurrent-writer subset
- SQLite for durable reopen plus explicit commit-phase fault injection
- PostgreSQL for durable reopen plus concurrent writers across separate backend instances

The characterization used the current runtime-kernel checkpoint path, the new testkit-only fault-injection seam, and targeted conformance execution against the current worktree.

## Findings

1. The pre-AU repo already proved one restart-recovery baseline, but it did not cover commit-phase uncertainty.
   The existing `kernel.restart-recovery.close-reopen-checkpoint` scenario showed that a committed checkpoint remains visible after reopen and that later staged work stays uncommitted, but it did not exercise failures at `before-commit`, `mid-commit`, or `after-commit-before-ack`.

2. The TypeScript backends already had atomic commit shapes, but no backend-local way to interrupt them at commit time.
   `memory` uses clone-then-swap state replacement, SQLite commits through one explicit `COMMIT`, and PostgreSQL persists one snapshot row inside a transaction. Before AU there was no testkit-only hook that could fail those paths relative to the actual commit boundary, so the durability claim was still design-backed rather than proof-backed.

3. SQLite and PostgreSQL required backend-local commit hooks for true `mid-commit` uncertainty.
   Injecting faults only around `RuntimeBackend.transact` would have faked the commit window. AU now hooks the actual commit boundary: SQLite wraps the explicit `COMMIT`, and PostgreSQL wraps the explicit snapshot-persist plus `COMMIT` sequence on a reserved connection.

4. Concurrent-writer proof needed two durable backends on the same store plus a post-lock retry.
   On SQLite, the first loser signal across separate backend instances can be an engine-level lock error rather than the eventual lineage error. Retrying the losing write after the winner commits deterministically yields the typed lateral-head conflict. PostgreSQL serializes on the locked snapshot row and then yields the typed lineage rejection once the loser sees the winner's head.

5. No atomicity defect was exposed in the official TypeScript backends once the AU scenarios were in place.
   The AU fault-point checks now show the expected split:
   - `before-commit`: branch head stays at the prior committed TurnNode, staged work remains recoverable, and no partial lineage is visible
   - `mid-commit` and `after-commit-before-ack`: the checkpoint is fully committed and recoverable despite the surfaced error, with no torn or partial lineage

6. Brownfield validation drift existed outside the kernel logic.
   The PostgreSQL Nx targets still embedded service lifecycle assumptions, which conflicted with the repo's own service-management rule and contributed to stale PID/socket behavior during verification. AU aligned those targets to run directly in the direnv-loaded environment after the caller starts PostgreSQL with `devenv up -d`.

## Scenarios The `kernel-crash-recovery` Checks Must Cover

1. `before-commit` fault on an otherwise valid checkpoint transaction.
2. `mid-commit` fault on a backend that exposes commit-phase hooks.
3. `after-commit-before-ack` fault on an otherwise valid checkpoint transaction.
4. Durable reopen after each applicable fault point on SQLite and PostgreSQL.
5. In-process inspection after each fault point on `memory`.
6. Two writers racing the same branch head, proving one committed sibling head and one typed lateral-lineage rejection.

## Defects For KRT-AU004

- No storage atomicity bug was exposed in the current TypeScript official backends.
- One validation-path defect outside the storage contract did need correction:
  PostgreSQL Nx targets were starting services internally instead of inheriting an already-started `devenv` session.

## Outcome

The spike closes the characterization requirement and feeds KRT-AU002 through KRT-AU004 directly:

- AU002: add the testkit-only fault seam plus backend-local commit hooks
- AU003: promote the crash-recovery checks into the kernel conformance plan and authority packet
- AU004: keep the strict crash-recovery scenarios and fix any backend or validation drift they expose rather than weakening the checks
