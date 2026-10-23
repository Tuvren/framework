# KRT-DC004 triage

Classes follow ADR-0081: V is verification, I is implementation, S is specification, and E is environment.

Table 1. Observed failures and disposition

| Observation | Class | Disposition |
| --- | --- | --- |
| Initial public recovery test fails with `ENOENT` for the syscall plan. | V | Expected test-first failure. Added and registered the plan. |
| A trial plan containing unsupported fault points makes the aggregate control status `unsupported`. | V | Kept the two reachable points in the registered memory plan. Isolated copies of its trace request each unsupported point and require explicit runner `unsupported` evidence. |
| `bun run check` fails twice during lint cleanup for object key order and array destructuring. | V | Corrected test syntax; the third run passes. No semantic behavior changed. |
| `bun run compatibility:check` reports stale memory check IDs and six other kernel lanes' non-applicable IDs. | V | Packet topology gained two syscall checks. Refresh required through `bun run compatibility:evidence`. |
| `drop-uncommitted-staged-result-on-recovery` fails promoted before-commit recovery assertions after proven activation. | I, intentional control | Expected detection. The unmutated control passes. |
| `promote-staged-before-checkpoint` fails promoted before-commit progress and head assertions after proven activation. | I, intentional control | Expected detection. The unmutated control passes. |
| `fault-seam-never-fires` yields `missing_fault_activation` on the syscall recovery trace after disabling the seam. | V, intentional instrumentation control | Expected runner rejection, distinct from a semantic implementation failure. |

No production implementation defect or specification STOP condition was observed. Public `run.recover` exposes the required recovery state without an adapter-inserted reconciliation call. No services were started, stopped, or reset. No `.constitution/` file was edited.

All required gates pass. The compatibility refresh records 133 passing applicable memory checks, including both recovery traces. The release gate also passes PostgreSQL and SQLite proving-host scenarios.

The complete negative-control report is retained at `.cache/dc004/negative-control-report.json`. The unmutated baseline passes 133/133 checks. Every listed mutant activates and is killed; none survives or becomes invalid.

Table 2. Per-mutant outcomes

| Mutant | Class | Activated | Outcome | Designated failures | Collateral failures |
| --- | --- | --- | --- | --- | --- |
| `kernel.accept-noncanonical-cbor` | I, intentional control | `true` | `killed` | 1 | 0 |
| `kernel.accept-stale-head-update` | I, intentional control | `true` | `killed` | 3 | 0 |
| `kernel.accept-stale-owner-after-takeover` | I, intentional control | `true` | `killed` | 2 | 5 |
| `kernel.delete-object-reachable-through-live-root` | I, intentional control | `true` | `killed` | 1 | 4 |
| `kernel.drop-uncommitted-staged-result-on-recovery` | I, intentional control | `true` | `killed` | 2 | 7 |
| `kernel.fault-seam-never-fires` | V, intentional control | `true` | `killed` | 0 | 27 |
| `kernel.lease-takeover-before-expiry` | I, intentional control | `true` | `killed` | 2 | 3 |
| `kernel.never-sweep-eligible-objects` | I, intentional control | `true` | `killed` | 5 | 9 |
| `kernel.noncanonical-changed-paths-order` | I, intentional control | `true` | `killed` | 1 | 2 |
| `kernel.promote-staged-before-checkpoint` | I, intentional control | `true` | `killed` | 2 | 7 |
| `kernel.resolve-object-across-scopes` | I, intentional control | `true` | `killed` | 2 | 0 |
| `kernel.sweep-inside-grace-window` | I, intentional control | `true` | `killed` | 2 | 13 |
| `kernel.wrong-opaque-object-hash` | I, intentional control | `true` | `killed` | 18 | 21 |

Table 3. Verification commands

| Command | Exit status | Outcome |
| --- | --- | --- |
| `bun test typescript/kernel/conformance-adapter/test/recovery-syscall-plans.test.ts -t "recovery traces"` | 1, then 1 | Expected missing-artifact failure, then corrected unsupported aggregate expectation. |
| `bun test typescript/kernel/conformance-adapter/test/recovery-syscall-plans.test.ts` | 0 | Six public harness and negative-control tests pass. Final additions also pass in `check` and `verify`. |
| `bunx --bun oxlint --type-aware --fix typescript/kernel/conformance-adapter/test/recovery-syscall-plans.test.ts` | 1 | Automatic fixes leave destructuring to correct explicitly; final scoped lint passes. |
| `bunx --bun oxlint --type-aware typescript/kernel/conformance-adapter/test/recovery-syscall-plans.test.ts` | 0 | Final scoped lint passes. |
| `bun run check` | 1, 1, then 0 | Authority, formatting, affected typechecks, tests, and lint pass after syntax cleanup. |
| `bun run compatibility:check` | 1 | Detects expected stale topology. Subsequent compatibility checks pass inside both verification gates. |
| `bun run compatibility:evidence` | 0 | Refreshes the matrix and seven kernel evidence files; generated output is formatter-clean. |
| `bun run verify:kernel` | 0 | Kernel typechecks, testkit, compatibility, and memory/SQLite/PostgreSQL plus Go/Python/Dart conformance pass. |
| `bun run conformance` | 0 | All 11 projects pass; all 13 mutants activate and are killed; baseline is 133/133. |
| `bun run lint` | 0 | Full workspace lint passes. |
| `bun tools/scripts/authority-guardrails/authority-guardrails.ts` | 0 | Authority guardrails pass. |
| `bun run verify` | 0 | All release phases pass, including 813 tooling tests, interop smoke, package tests, portability, and SQLite/PostgreSQL proving hosts. |
| `git diff --check` | 0 | No whitespace errors. |

Logs are retained under `.cache/dc004/`. HEAD remains `7db47de` on `epic/dc-kernel-memory-syscall-plans`; no commit or staging operation occurred. No ENOSPC failure occurred, so no TMPDIR override was needed.
