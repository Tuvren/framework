# Spike report: KRT-DO001 durable mutant and shared-writer race

## Effort budget

- **Budget:** 5 story points.
- **Spent:** Completed 24 checkpoint matrix runs, eight valid shared-writer runs, a discarded malformed race prototype, two isolated clock cases, and the kernel verification lane. Stopped the two checkpoint items that backend validation prevents from reaching their faults.

## Question

- **Owner:** KRT-DO001 (`.constitution/tasks/epics/EPIC-DO-durable-control-mutants.yaml`).
- **Decision this spike must produce:** Can a generic non-atomic backend wrapper expose each checkpoint fault on SQLite and PostgreSQL, and what control exposes the shared-writer race?
- **Answer:** A tree-and-path group followed by separate repository transactions detects the node-write claim on both backends. It cannot reach the before-commit or head-move fault: both backends reject the isolated branch-head write. The shared-writer claim has a measured detecting strategy: bypass the kernel lateral guard and accept the backend lateral write through the common parent, causing both processes to commit. The two blocked checkpoint claims remain undetected.

## Context and objective

- **Trigger:** ADR-0084, especially decision 5, and the durable undetected registers in `spec/conformance/kernel/`.
- **Target:** Measure the actual testkit fault seam over SQLite and PostgreSQL, with real process death and fresh-process recovery. Explain the existing stale-head control's activation without a shared-writer failure.
- **Surface:** Backend certification testkit, TypeScript conformance adapter, shared plans, and harness. No production source, plan, register, task, architecture, or technical specification changed.
- **Authority:** Read ADR-0076, ADR-0077, ADR-0079, ADR-0082, ADR-0084, both named architecture flows, OD-21, and `docs/KrakenKernelSpecification.md` section 5.5. The owner's instruction settles OD-21's recommended rollback interpretation for these single-transaction backends. The register still says `proposed`; this report does not edit it or extend the ruling to separately durable implementations.
- **Evidence convention:** “Measured” means a completed run, raw protocol outcome, transaction log, activation reply, or database lock sample. “Inferred” means an explanation derived from those observations and the named source. An invalid experiment is never a semantic detection.

## Codebase baseline

**Configuration and reproducibility.** All commands ran at revision `7610ed31a28a152ef1c7582108e379319c5db377` on branch `epic/do-durable-control-mutants`, in `/home/oscar/GitHub/Tuvren/framework-worktrees/EPIC-DO`, on November 12, 2026. Initial `git status --short` was empty. The environment came from `direnv exec .`; the PostgreSQL service was already running and was never restarted or reset.

The measured configuration was:

| Component | Configuration |
| --- | --- |
| Coordinator, builder, activation relay | Bun 1.4.2 |
| Actual adapter runtime | Node.js v24.20.0, matching the repository's Node adapter execution model |
| SQLite | `better-sqlite3` 12.8.0; SQLite 3.51.3; measured `journal_mode=wal`; one disposable `kernel.sqlite` directory per check |
| PostgreSQL | Server 17.11; `postgres` client 3.4.9; Unix socket `/run/user/1000/devenv-b52fc6b/postgres`; port 5432; session user `oscar` |
| PostgreSQL storage | Harness-created disposable database per check; schema `tuvren_cert`; backend default Scope; pool maximum 1 per backend instance; 5000 ms scope-lock timeout |
| Checkpoint clocks | Plan sets backend and worker clocks to 200; both measured transaction surfaces provide `now`; wrapper captures it once per logical transaction |
| Crash boundary | Supervisor starts epoch 1, awaits the matching blocking fault receipt, sends SIGKILL, and opens retained storage from a fresh epoch 2 process |
| Shared-writer boundary | Two adapter processes attach to one harness storage reference; each has its own backend instance and connection |
| Scratch | `/home/oscar/.cache/codex-subagent/framework/do/proto/`; no prototype file was placed in the worktree |

`PGUSER` and `PGDATABASE` were unset. `direnv` supplies `TMPDIR=/home/oscar/.cache/codex-subagent/EPIC-DO/tmp`; `matrix.ts` overrides child `TMPDIR` to the spike scratch directory. Direct exploratory CLI runs and the verification lane inherit direnv's temporary directory. The harness owns their storage cleanup. For reproductions that must use the spike directory, set `TMPDIR` after `direnv exec`, as in the command recipe.

**Prototype construction.** `non-atomic.ts` implements a generic `RuntimeBackend` decorator, registered as `kernel.proto-non-atomic` only in a disposable bundle. A build plugin adds the definition to the registry in memory. It rewrites the adapter's dynamic backend module URLs to the worktree's built backend entries. Scratch symlinks to the worktree's `node_modules` and `spec` let the bundle resolve its ordinary dependencies and fixtures. The backend implementations themselves remain unchanged.

The decorator is under `createDurableFaultControl`, which remains under the barrier and kernel. Its fault-factory wrapper only enables mutation when the real seam is armed and then delegates to the real factory. Setup, including the completed baseline checkpoint, therefore remains unmutated. Inside the enabled logical transaction, every repository call runs in its own real `inner.transact`. Capabilities, health, maintenance methods, and optional lifecycle methods forward through `decorateBackend`. The logical transaction captures the backend clock through an initial real transaction and supplies a constant closure only if the backend supplies `now`. Repository handles from that initial transaction are never invoked after it ends; each operation resolves the current transaction's repository and method.

In grouped mode, `turnTrees.put` buffers the tree. `turnTreePaths.putMany` writes that tree and its paths together in one real transaction. All other repository calls remain separate transactions. The measured fixture uses a flat ordered path; chunked-path grouping was not measured. Activation increments after each successful mutating physical transaction. It does not increment for a read, buffered tree, rejected write, arming, or fault receipt. This makes the measured grouped count 2: tree plus paths, then TurnNode. The enabled wrapper is discarded with epoch 1; epoch 2 selects a fresh, unarmed wrapper.

**Clock and frozen-wrapper probe.** An isolated SQLite-backed probe used a frozen forwarding wrapper as input. With the transaction clock present, both logical reads returned `1794510179540`, `hasOwnClock=true`, and capabilities matched. With a decorator that omits `now`, `hasOwnClock=false` and no clock value was produced; capabilities still matched. Both cases exited 0. This proves the optional-clock and frozen-wrapper mechanics in isolation; it does not claim the PostgreSQL shared-clock capability can truthfully omit its clock.

**Commands and exit statuses.** Define `SPIKE=/home/oscar/.cache/codex-subagent/framework/do/proto` in zsh. All scripts in the following recipe are disposable scratch artifacts; none is retained as repository source or embedded in this report.

```sh
cd /home/oscar/GitHub/Tuvren/framework-worktrees/EPIC-DO
direnv exec . psql -d postgres -Atc 'select version(),current_user;'
direnv exec . bun run verify:kernel
direnv exec . bun "$SPIKE/build.ts"
direnv exec . bun "$SPIKE/matrix.ts"
direnv exec . bun "$SPIKE/build-race.ts"
direnv exec . env TMPDIR="$SPIKE" DO_RACE_LOG="$SPIKE/race-stale.jsonl" \
  bun tools/conformance/harness/run.ts \
  --adapter "$SPIKE/postgres-race-stale/adapter.json" \
  --check kernel.syscall.shared_writer.race
direnv exec . bun "$SPIKE/build-control.ts"
direnv exec . bun "$SPIKE/race-matrix.ts"
direnv exec . env TMPDIR="$SPIKE" bun "$SPIKE/race-reversed.ts"
direnv exec . node "$SPIKE/clock-probe.ts"
git status --short
```

The database probe, all final builders, matrix coordinators, reversed-schedule coordinator, and clock probe exited 0. Each coordinator records its children's individual status; a coordinator's exit 0 is not a mutant pass. The stale-head CLI exited 0. The corrected candidate CLI exited 1 with `implementation` classification. The checkpoint child statuses are in table 1. `verify-kernel.log`, `matrix.log`, `race-stale.json`, `race-stale.jsonl`, `race-control-valid.json`, `race-control-valid.jsonl`, `race-matrix.log`, and `race-reversed.log` are scratch evidence. Per-check checkpoint evidence and write logs use `<backend>-<mode>-<point>.json` and `.jsonl`. Activation replies are `<backend>-<mode>/<relay-pid>.json`.

For one checkpoint result, the actual command shape is:

```sh
direnv exec . env TMPDIR="$SPIKE" DO_GROUP_TREE=1 \
  DO_LOG="$SPIKE/reproduce.jsonl" \
  bun tools/conformance/harness/run.ts \
  --adapter "$SPIKE/sqlite-grouped/adapter.json" \
  --check kernel.syscall.process-crash.after_turn_node_write_before_head
```

Substitute `postgres` for `sqlite`, `per-call` and `DO_GROUP_TREE=0` for ungrouped mode, or `baseline` without mutation. The three check suffixes are `before_commit`, `after_turn_node_write_before_head`, and `after_head_move_before_staging_clear`. Each baseline runs before and after its backend's mutation matrix. Grouped manifests select `--mutant kernel.proto-non-atomic`; stale manifests select `--mutant kernel.accept-stale-head-update`; control manifests select `--mutant kernel.proto-stale-writer`. The ordinary manifest capabilities are preserved. The child command is the environment's Node executable plus the disposable bundle, `--backend`, `--adapter-id`, and optional `--mutant`; mutation runs prepend the repository's Bun activation relay.

Discarded setup attempts are not semantic evidence: `bun --tsconfig` exited 1 because the supported option is `--tsconfig-override`; a direct Bun adapter failed on unsupported `better-sqlite3`; a bundle outside the repository initially lacked fixture resolution; and the first race candidate returned an incorrect `SetHeadResult` shape and was rejected by observation validation. The corrected candidate returns a branch projection from the real written record. No malformed outcome is counted as a detection. The native SQLite adapter requires Node, so using Bun as its runtime was not a compatible alternative. Build and inspection signatures were checked against installed interfaces and [Bun's plugin documentation](https://bun.com/docs/bundler/plugins); lock fields were checked against [PostgreSQL 17 pg_locks documentation](https://www.postgresql.org/docs/17/view-pg-locks.html). No Exa tool was available; official documentation was the research fallback.

**Part A measurements.** In the following tables, B means `before_commit`, N means `after_turn_node_write_before_head`, and H means `after_head_move_before_staging_clear`. “Grouped” means only tree plus paths. Counts are measured mutation activations in epoch 1. Every listed baseline-before and baseline-after passed all 57 assertions, including evidence-presence assertions, with child exit 0.

Table 1. Checkpoint matrix results

| Backend | Mode | Point | Successful write commits | Activation | Fault receipt | Child exit and interpretation |
| --- | --- | --- | --- | --- | --- | --- |
| sqlite | per-call | B | None | 0 | None | 1; invalid, missing fault activation |
| sqlite | per-call | N | None | 0 | None | 1; invalid, missing fault activation |
| sqlite | per-call | H | None | 0 | None | 1; invalid, missing fault activation |
| sqlite | grouped | B | Tree plus paths; TurnNode | 2 | None | 1; invalid, missing fault activation |
| sqlite | grouped | N | Tree plus paths; TurnNode | 2 | Matching token, N, epoch 1 | 1; designated semantic failure |
| sqlite | grouped | H | Tree plus paths; TurnNode | 2 | None | 1; invalid, missing fault activation |
| postgres | per-call | B | None | 0 | None | 1; invalid, missing fault activation |
| postgres | per-call | N | None | 0 | None | 1; invalid, missing fault activation |
| postgres | per-call | H | None | 0 | None | 1; invalid, missing fault activation |
| postgres | grouped | B | Tree plus paths; TurnNode | 2 | None | 1; invalid, missing fault activation |
| postgres | grouped | N | Tree plus paths; TurnNode | 2 | Matching token, N, epoch 1 | 1; designated semantic failure |
| postgres | grouped | H | Tree plus paths; TurnNode | 2 | None | 1; invalid, missing fault activation |

Measured rejection codes are `sqlite_backend_missing_turn_tree_paths` and `postgres_backend_missing_turn_tree_paths` for every per-call run. The rejected operation is `turnTrees.put`; no mutating transaction committed before rejection. Grouping is necessary for this fixture on both backends, not only SQLite.

Grouped B and H both commit the tree/path group and the TurnNode, then reject `branches.set` with `sqlite_backend_active_run_branch_head_mismatch` or `postgres_backend_active_run_branch_head_mismatch`. The message is `stored active runs must stay aligned with the current branch head`. No branch-head transaction commits, no requested fault receipt arrives, and the harness reports `experimentStatus=invalid`, rejection `missing_fault_activation`. Epoch 1 closes normally; there is no fault-qualified SIGKILL/restart/recovery. The wrapper activates twice, but these are not kills. Stopped these items rather than suppressing validation, moving the fault, or interpreting the harness timeout as a recovery failure.

Grouped N reaches the actual seam after `turnNodes.put` commits, before `branches.set` is called. The activation relay measures 0 before arming and 2 at `faultReached`. The supervisor kills the same epoch and opens a new process. Epoch 2's fresh wrapper has activation 0. There is no backend invariant rejection in this experiment. Both backends have the same recovery observations: baseline head and completed step, baseline consumed results, pending staging intact, baseline-visible messages, and baseline lineage. A separately durable pending node also exists. That extra node is the only failed recovery assertion.

Table 2. Fault tokens and process receipts

| Backend | Mode | Point | Arming token | Receipt and process result |
| --- | --- | --- | --- | --- |
| sqlite | baseline | B | `fault-0507c069-1614-4cb9-b8a8-be1de5a2b9e6` | Same token; phase `before-commit`; epoch 1 PID 3255887 SIGKILL, exit code null; epoch 2 PID 3255953 normal close |
| sqlite | baseline | N | `fault-7def7210-104c-4941-ae4b-af35c09ffaf1` | Same token; phase `after-turn-node-write-before-head`; epoch 1 PID 3256017 SIGKILL, exit code null; epoch 2 PID 3256035 normal close |
| sqlite | baseline | H | `fault-668abd47-6f40-4b3e-b03e-fb09d147deaf` | Same token; phase `after-head-move-before-staging-clear`; epoch 1 PID 3256211 SIGKILL, exit code null; epoch 2 PID 3256230 normal close |
| sqlite | per-call | B | `fault-3e3fd8d3-dcd9-4f07-92e2-7cbe2d004b9a` | No receipt; no activation-qualified process death or recovery |
| sqlite | per-call | N | `fault-aff55f11-ccfc-46ae-a40d-0183eb6602f0` | No receipt; no activation-qualified process death or recovery |
| sqlite | per-call | H | `fault-6488dc47-d164-4751-9a7e-5cb7220c8c8d` | No receipt; no activation-qualified process death or recovery |
| sqlite | grouped | B | `fault-c5ce4ed8-f0b8-4bf0-b2f9-fb3cbf1ce96f` | No receipt; no activation-qualified process death or recovery |
| sqlite | grouped | N | `fault-fbecd568-088d-4270-bc22-40de3f8230a2` | Same token; phase `after-turn-node-write-before-head`; epoch 1 PID 3260847 SIGKILL, exit code null; epoch 2 PID 3260878 normal close |
| sqlite | grouped | H | `fault-e72e6a9b-fc32-4357-808b-04a923a506db` | No receipt; no activation-qualified process death or recovery |
| postgres | baseline | B | `fault-86f1f776-2f42-44a8-bc0e-6a4c715a6b43` | Same token; phase `before-commit`; epoch 1 PID 3263101 SIGKILL, exit code null; epoch 2 PID 3264205 normal close |
| postgres | baseline | N | `fault-b3641a67-3f33-4773-9794-cb77c55e95d0` | Same token; phase `after-turn-node-write-before-head`; epoch 1 PID 3264754 SIGKILL, exit code null; epoch 2 PID 3264847 normal close |
| postgres | baseline | H | `fault-db12401d-306d-41ac-b976-ba972f13eeda` | Same token; phase `after-head-move-before-staging-clear`; epoch 1 PID 3265041 SIGKILL, exit code null; epoch 2 PID 3265084 normal close |
| postgres | per-call | B | `fault-f2912652-3f44-43bb-afcd-2e4481abca7f` | No receipt; no activation-qualified process death or recovery |
| postgres | per-call | N | `fault-72ad9491-d7b4-41ed-9053-85cc98250744` | No receipt; no activation-qualified process death or recovery |
| postgres | per-call | H | `fault-d8f5402b-2347-440a-9d74-2a7950f6b882` | No receipt; no activation-qualified process death or recovery |
| postgres | grouped | B | `fault-2fca6a83-90c0-4dc2-8a28-4408ca6d850f` | No receipt; no activation-qualified process death or recovery |
| postgres | grouped | N | `fault-be0e51ef-0f3d-42b1-a778-e79e8b9e1e4f` | Same token; phase `after-turn-node-write-before-head`; epoch 1 PID 3270834 SIGKILL, exit code null; epoch 2 PID 3271180 normal close |
| postgres | grouped | H | `fault-8a7b9f06-d6bb-4c36-bdcf-ac530cab6842` | No receipt; no activation-qualified process death or recovery |

In table 2, PID means the supervised executable: Node for positive runs and the activation relay for mutant runs. The mutant relay and its Node child share the killed process group; the Node child emitting the N receipt was PID 3260851 on SQLite and PID 3270838 on PostgreSQL. The supervisor records forced death of the same epoch and cleans up descendants. The baseline-after runs repeat all six positive checks and pass. Their complete receipt records are in the `*-baseline-after-*.json` scratch files. The baselines' successful recovery and absent pending nodes are measured by their passing assertions; no mutation result is substituted for baseline evidence.

For grouped N on both backends, the baseline head is `df7c490b6cb4e985da427fc5a597fe6df3466c8319f44a1fa0ed1c558b294f41`. The orphan pending node is `9cc4ed553849e8b6aef341df5cf6ecb1e7b13bf60bb82b54b71fc0a38dc9195a`, with that baseline as parent and tree `feadeff5dc5ed58ac2f30dc5cac30cc7703297800b236ca1a1a31625bde2a503`. Recovery returns `lastCompletedStepId=baseline`, one baseline consumed result, one pending uncommitted result, lineage length 2, and one visible baseline message. The pending object hash is `dbc1b4c900ffe48d575b5da5c638040125f65db0fe3e24494b76ea986457d986`; it remains staged. The node nevertheless records it as consumed. This is measured partial checkpoint persistence under the mutant, not a baseline recovery defect.

**Every recovery assertion.** Table 3 covers the complete recovery assertion set for each corresponding B, N, and H check. Expand a numeric suffix as `kernel.syscall.process-crash.<point>.<number>.resultField`; expand the step suffix as `kernel.syscall.process-crash.<point>.pendingNode.1.resultField`. All baseline columns mean both backends, before and after mutation. “Blocked” means no recovery assertion was evaluated against a recovered process; the harness's repeated missing-receipt messages are experiment failures, not semantic failures.

Table 3. Recovery assertion outcomes

| Suffix | Assertion | All baselines | Grouped N, both backends | B and H, both modes; per-call N |
| --- | --- | --- | --- | --- |
| 3 | Recovery last node equals durable head | Pass | Pass | Blocked |
| 4 | Recovered branch head equals durable head | Pass | Pass | Blocked |
| 5 | Durable node hash equals recovery last node | Pass | Pass | Blocked |
| 6 | Staging equals recovered uncommitted results | Pass | Pass | Blocked |
| 7 | Recovery step sequence equals created run | Pass | Pass | Blocked |
| 8 | Last completed step is baseline | Pass | Pass | Blocked |
| 9 | Durable head equals baseline checkpoint | Pass | Pass | Blocked |
| 10 | Recovery last node equals baseline checkpoint | Pass | Pass | Blocked |
| 11 | Consumed results equal baseline staging | Pass | Pass | Blocked |
| 12 | Uncommitted results equal pending staging | Pass | Pass | Blocked |
| 13 | Current staging equals pending staging | Pass | Pass | Blocked |
| 14 | Durable node equals baseline node | Pass | Pass | Blocked |
| 15 | Visible messages equal baseline messages | Pass | Pass | Blocked |
| 16 | Lineage length is 2 | Pass | Pass | Blocked |
| 17 | Second lineage node is thread root | Pass | Pass | Blocked |
| 18 | Visible message count is 1 | Pass | Pass | Blocked |
| 19 | Uncommitted result count is 1 | Pass | Pass | Blocked |
| 20 | First lineage node is baseline checkpoint | Pass | Pass | Blocked |
| 21 | Visible message excludes pending object | Pass | Pass | Blocked |
| pendingNode.1.resultField | Pending TurnNode is absent | Pass | Fail | Blocked |

The non-recovery fault assertions `.1.faultActivated`, `.2.processExit`, `.kill.1.faultActivated`, and `.kill.2.processExit` pass in grouped N and all positive baselines. Setup assertions pass. All required-evidence assertions pass in grouped N. Its overall result is `implementation`, with exactly one failed assertion out of 57.

Candidate designations are:

- Claim `kernel.syscall.process-crash.after_turn_node_write_before_head`: `kernel.syscall.process-crash.after_turn_node_write_before_head.pendingNode.1.resultField`, measured fail with activation and matching fault receipt on both backends; measured pass before and after mutation.
- Claim `kernel.syscall.process-crash.before_commit`: candidate `kernel.syscall.process-crash.before_commit.pendingNode.1.resultField`; positive baselines pass, but no valid mutant detection was measured. Do not designate it as killed.
- Claim `kernel.syscall.process-crash.after_head_move_before_staging_clear`: candidate `kernel.syscall.process-crash.after_head_move_before_staging_clear.pendingNode.1.resultField`; positive baselines pass, but no valid mutant detection was measured. Do not designate it as killed. `.9.resultField` is a possible head-specific candidate only after a prototype actually makes the head durable and reaches the seam; that behavior was not measured.

**Part B: why the existing stale-head control survives.** The unchanged shared-writer fixture has common head C=`21e7c9aacd80aa5933712854a08bfe549d914d54f05972ecbba902b9867ac209`, sibling target A=`ab80486e7a00983dcc08fd99456ac21d32fc2d58661ea5f5f71c37f1222e4419`, and target B=`71387b2759262f439bce30ec858230501f97a9bf3c89088facba892954f85ae8`.

The measured `kernel.accept-stale-head-update` run exited 0. Its primary Node writer PID was 3264675 and its second writer PID was 3264818. Activation replies report 1 in the primary epoch, 0 in the second epoch, and 0 in the discovery process. The following sequence combines the testkit transaction logs, real repository calls, and lock sample:

1. Both operations enter `kernel.persistence.before-transact` and stop before calling the backend. Primary entry handle `f228780e-61f6-405e-a8bc-ea89ec7c1cc9` arrives at monotonic time `253669487496348` ns; second handle `ef73afb3-8ff5-410c-9da6-b04ea63069bb` arrives at `253669562289299` ns.
2. The held-head observation reads C in a separate primary transaction while both requests remain gated. Release occurs at `253669577698158` ns for primary and `253669577691104` ns for second. Both entry receipts therefore precede either release.
3. Primary transaction 27 enters the backend at `253669578736701` ns, reads C, and performs the runtime's branch movement validation. The mutant records its proposed branch write without applying it. Transaction 27 commits at `253669588306528` ns, releasing its advisory lock.
4. Primary transaction 28 requests and reacquires the lock at `253669589242405` ns, replays the branch write, and commits A at `253669684392766` ns. The mutant increments activation for this split-write path. No lateral-write fallback was required.
5. Second transaction 1, requested at `253669578110292` ns, enters only at `253669686047452` ns. It reads A at `253669690503831` ns. The kernel rejects its sibling target B with `kernel_runtime_lateral_head_movement` before the mutant can replay a write. Its activation stays 0.
6. `firstOutcome` is a successful A move, `secondOutcome` is the typed lateral error, collect has one result and one error, and the persisted common head is A. Both collect assertions and the winner-head assertion pass.

The lock sample at primary transaction 28's branch write is direct database evidence. Query `pg_locks` joined to `pg_stat_activity`, filtered by `locktype='advisory'` and the disposable database. Backend PID 3264719 holds `ExclusiveLock`, `granted=true`; backend PID 3264844 waits with `ExclusiveLock`, `granted=false`, `wait_event_type=Lock`, `wait_event=advisory`. Both rows have `(classid,objid,objsubid)=(4167359522,2180171646,1)` and statement `SET LOCAL lock_timeout = '5000ms'; SELECT pg_advisory_xact_lock(-548071213865187458)`. The holder is idle in its transaction awaiting the client; the waiter is active on the advisory-lock statement. This proves serialization on the same Scope key in this run. It does not prove PostgreSQL lock acquisition is fair or that this interleaving always wins.

The sampled query shape was:

```sql
SELECT l.pid, l.classid, l.objid, l.objsubid, l.mode, l.granted,
       a.state, a.wait_event_type, a.wait_event, a.query
FROM pg_locks AS l
JOIN pg_stat_activity AS a ON a.pid = l.pid
WHERE l.locktype = 'advisory'
  AND a.datname = current_database()
ORDER BY l.pid;
```

`createKernelBarrierControl` gates before `inner.transact`. `PostgresBackend.transact` acquires its transaction-scoped Scope lock before building repositories or calling the supplied work. These source facts explain the measurement. The split stale-head mutant increments activation when it replays any delayed head write, including a valid forward write. That activation is not proof that a stale competing write was accepted. The barrier also does not force both writers to read C before either commits.

**Measured replacement control.** `kernel.proto-stale-writer` composes two testkit defects. Its kernel seam replaces `branch.setHead` with a transaction that reads the real branch and target, sets the target, and returns the real branch projection without the runtime lateral guard. Its backend seam catches only `_branch_head_lateral_move`, sets the branch temporarily to the target's real parent C, then sets the requested target in that same real backend transaction. This is the existing stale-write fallback combined with an explicit kernel guard bypass. It preserves the real PostgreSQL substrate, commits, barriers, capabilities, and outcome schema. There is no adapter grading or fabricated error/result.

The corrected candidate was measured in three valid schedules: its standalone run, the normal baseline/control/baseline sequence, and a scratch schedule with contender-start order and release-participant order reversed. All three produce two result outcomes, zero error outcomes, and the same failed set: `kernel.syscall.shared_writer.race.collect.1.resultField`, `.collect.2.resultField`, and `.head.1.resultField`. Both baseline/control/baseline sequences pass before and after mutation. The reverse coordinator exits 0 because it records outcomes; its mutant result is an implementation failure. Reversing request order did not force inverse database lock ownership in the measured run; this is not evidence that both lock-winning orders were exercised.

In the first corrected run, primary Node PID 3278335 commits A; second Node PID 3278443 then reads A, receives the backend lateral rejection for B, writes C and then B in its transaction, and commits B. The trace records the actual repository rejection `postgres_backend_branch_head_lateral_move`, both fallback writes, and both successful transaction commits. PostgreSQL's final write-set validation accepts the final state. Both public outcomes are `result` with their respective branch targets. The final common head is B, so the head assertion selecting the first collected result also fails. That head failure is collateral; the designated detection is `.collect.1.resultField`, which requires exactly one result and observes two.

Primary entry handle `e08d8a5b-0bff-41f5-999d-6fee693cf8a0` arrives at `253774118455676` ns; second handle `8b1b467e-113b-45d6-a2b7-004859efa403` arrives at `253774174728332` ns. Releases occur at `253774187475600` ns and `253774187576661` ns, respectively. Both receipts precede either release. Activations are 1 for the successful primary guard-bypass path and 2 for the second writer: guard bypass plus successful stale-write fallback. Discovery activation is 0. These counts are distinct from the two barrier-entry receipts.

The candidate proves acceptance of a stale sibling request under two-process contention. It deliberately remains observable even when database locking serializes the contenders. It does not claim simultaneous mutation inside the PostgreSQL Scope lock, or simultaneous stale snapshots. A production control can narrow activation to the successful lateral fallback and report guard bypass separately, while retaining the per-process evidence and designated assertion.

## Options and trade-offs

- **Per-call commits:** Rejected by both backends before the first write commit. This is an invalid control for all three faults.
- **Tree plus paths, then per-call commits:** Measured valid for N and necessary for its tree representation. It exposes the orphan node and detects N. It remains invalid for B and H because the isolated head move violates active-run alignment.
- **Early node group followed by a real transaction for dependent checkpoint writes:** Unmeasured follow-up option for B and H. A generic wrapper can potentially commit tree/path/node work first, then execute branch, turn, staging, and run writes together inside a real open transaction. The seam must still run after actual repository calls, including the head setter, and before final COMMIT; returning success for buffered setters without performing them is not proof of reach. This requires a bounded feasibility run and must preserve optional clocks, fault receipts, cancellation, and transaction lifetimes.
- **Kernel-aware early checkpoint control:** Another unmeasured option for B and H is a control that commits a valid complete checkpoint early and then reaches the genuine selected seam. It can use kernel information to keep dependent state consistent, but adds more behavioral coupling and requires review of which contract rule it violates. Do not infer feasibility from this report.
- **Existing split stale-head control:** It activates on a valid writer and survives the shared-writer assertions in the measured interleaving. Keep its other designations intact; do not use that activation to close this claim.
- **Composed guard-bypass and stale-write acceptance:** Measured detection for the shared-writer claim on real PostgreSQL. It needs no barrier inside the database lock. The cost is two coordinated testkit defects, so its documentation must state both and its activation must prove the actual fallback.

## Recommendation

- **Chosen option for KRT-DO002:** Use the measured tree/path grouping and N designation. Stop B and H at the measured validation failures. Run a bounded follow-up for a real transaction containing the dependent tail before implementing or declaring either remaining designation. Do not suppress backend invariants or clear those register entries.
- **Chosen option for KRT-DO005:** Implement the composed stale-writer control through the existing kernel and backend mutant seams. Preserve both `kernel.persistence.before-transact` entry receipts and their release ordering. Preserve the real server lock and record each process's guard-bypass and actual stale-fallback activation, public outcome, and committed head. Designate `kernel.syscall.shared_writer.race.collect.1.resultField`; baseline passes and the measured violation gives two committed results. `.collect.2.resultField` is an additional measured detector. Keep `.head.1.resultField` collateral because it depends on collection and final-writer ordering.
- **Why these fit:** They distinguish backend validation failures, actual fault activation, mutation activation, and semantic failure. They use the shared harness as the oracle and preserve the real durable substrates.
- **Rejected options:** Counting a timeout or setup error as a kill; calling a valid forward replay stale-write activation; claiming barrier receipts prove overlap inside the Scope lock; bypassing backend validation to manufacture a checkpoint fault; or deleting an undetected entry based on another claim's failure.

**Unresolved decision, ready for the register.** This is a proposed entry shape only; the open-decisions register was not edited.

- **Question:** How must the generic non-atomic checkpoint control retain the valid branch/turn/run write group while reaching the genuine B and H seams after separately durable node work?
- **What it blocks:** The B and H acceptance items of KRT-DO002 and their durable-register closure in KRT-DO007. It does not reopen the owner's OD-21 rollback ruling.
- **Option A:** Retain an early committed tree/path/node segment and a real transaction for the dependent tail. Advantages: keeps backend validators active and can expose the node persistence defect at both genuine callback phases. Disadvantages: generic segmentation, clock capture, liveness, and fault cancellation need measurement on both backends.
- **Option B:** Design a kernel-aware control that commits a valid checkpoint early and then reaches the genuine seam. Advantages: explicit knowledge of the full consistency group. Disadvantages: more kernel coupling and a broader review of mutation semantics; no feasibility evidence yet.
- **Option C:** Leave B and H undetected until a separately planned control investigation completes. Advantages: truthful certification and no speculative implementation. Disadvantages: durable publication remains blocked.
- **Recommendation:** Investigate A first in a bounded continuation of KRT-DO002. Retain C's register state until successful baseline/mutant/baseline runs prove actual fault reach and the designated assertion on each backend. Route B for design review only if A fails.
- **Closure:** Spike measurement or reviewed design with both-backend fault receipts, mutation activation, recovery outcomes, and designated failures. No decision is closed by this report.

## Downstream impact

- **ADRs to write or update:** No contradiction requires an immediate ADR edit: ADR-0084 decision 5 explicitly leaves feasibility assumed. Its assumption is only partly established. Record the invalid per-call/head strategy and settle the remaining physical control design before M2 claims all three kills.
- **Tickets unblocked:** KRT-DO005 has a measured, reproducible detecting strategy. KRT-DO002 has an established N control and concrete B/H blockers; it is not fully unblocked for its stated acceptance.
- **Register entry closed:** None. The spike does not modify registers or certify a profile. B and H must remain undetected, and the shared-writer entry must remain until KRT-DO005 lands its control and evidence.
- **Tickets to add or split:** Bound the B/H segmentation feasibility work before the remaining KRT-DO002 implementation. The lead can split it if it exceeds that ticket's effort. KRT-DO005 needs production-quality wrappers and tests rather than copying the disposable prototype.
- **Spec edits required:** None made. Record the owner's OD-21 ruling through the authorized owner process before KRT-DO007 closure. Any change to the fault meaning or recovery contract requires Stage 3 review rather than an adapter workaround.
- **Verification:** `direnv exec . bun run verify:kernel` exited 0. All 10 phases passed: generated interop prerequisite, authority validation, plan validation, TypeScript typecheck, testkit tests, compatibility evidence, conformance for eight projects, durable fault contracts, shared-backend contracts, and certificate/control contracts. The final certificate/control phase passed 22 tests and 689 expectations. This is kernel-lane readiness evidence, not a full-workspace `verify` claim.
- **Code decisions:** No dependency, production pattern, convention, or public contract was added. Scratch-only decisions are the generic transaction decorator, optional clock capture, tree/path consistency group, and the composed stale-writer defect. Node is required by the actual SQLite backend's existing driver.
- **Drift:** KRT-DO002 assumes a usable non-atomic strategy for all three points; ADR-0084 decision 5 states this is unproven. Measured backend alignment validation requires another physical grouping strategy. Tier: physical, unless a proposed solution changes the fault or recovery contract, which requires logical/spec review. No authority file was changed.
- **Cleanup:** No recorded SQLite failure resource remains, and a final PostgreSQL catalog query found no `tuvren_cert_%` database. The two isolated clock databases remain only in the spike scratch directory. No service was stopped or reset.
- **Files changed:** Only `.constitution/spikes/SPK-KRT-DO001.md`; no prototype source was retained in the worktree or in this report. The lead owns commits and any register edits.

The downstream findings are:

1. M2 must group tree and paths on both SQLite and PostgreSQL; per-call tree persistence is rejected before activation.
2. M2 can designate the N check's `pendingNode.1.resultField`: it fails with activation 2 and a matching same-epoch crash receipt on both backends.
3. M2 must resolve B/H grouping before claiming detection; isolated head writes fail active-run alignment and produce invalid experiments.
4. M4 must distinguish forward replay activation from actual stale acceptance; the entry barrier precedes the PostgreSQL Scope lock.
5. M4 can use the measured guard-bypass plus stale-write control: both processes commit, both entry receipts precede release, and `kernel.syscall.shared_writer.race.collect.1.resultField` detects the violation.
