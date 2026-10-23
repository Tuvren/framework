---
id: ADR-0076
status: accepted
date: 2026-10-22
supersedes:
  - ADR-0045
certainty: assumed
assumption: "Synthesized from two independent designs after the owner directed genuine certification in the 2026-10-22 session; settles by ruling when the owner approves this pass."
---
### ADR-0076 Lifecycle, Storage, and Crash Certification Profiles

- **Status:** accepted. Supersedes ADR-0045 as the mechanism of record for crash and durability certification. The in-process fault-injecting backend survives as a unit-test seam and as the `throw` mode below.
- **Context:** No conformance check kills a process today. TypeScript uses an in-process fault backend whose `midCommit` hook awaits the full commit and then throws (`typescript/kernel/testkit/src/lib/fault-injecting-backend.ts:254-270`), so it is an after-commit fault. The durable path then closes and reopens the backend in the same process. Go, Python, and Dart swap backends and call reconcile explicitly. Python's mid-commit point falls between three non-transactional backend calls (`python/kernel/src/tuvren_kernel/fault_injection.py:18-30`). Rust has no fault seam. Rust, Go, Python, and Dart kernels are in-memory only, so killing their processes destroys the state that recovery would need. Adapters choose where storage lives and when restart happens. The PRD forbids crash-safety claims without reproducible fault-injection and crash-recovery evidence.
- **Decision:**
  1. **Separate profiles.** These are never conflated:
     - `kernel.memory`: atomicity, native errors, concurrency, and recovery within retained process state.
     - `kernel.persistent-reopen`: close every instance and reopen the same storage.
     - `kernel.process-crash`: forced process death and recovery through a fresh process against retained storage.
     - `kernel.shared-backend`: several workers attached to one shared durable backend whose lease clock is backend-authoritative (ADR-0050; PostgreSQL today), covering multi-worker lease expiry and clock-skew preemption.

     Storage-service failure is out of scope until claimed. In-memory implementations certify `kernel.memory` only. Snapshot serialization must not be added to make them look durable.
  2. **Harness-owned storage.** A resource manager under `tools/conformance/harness/` allocates a fresh resource per check from the manifest's declared storage kind: a temporary SQLite directory with its sidecars retained, or a disposable PostgreSQL database or schema created through the existing devenv service. It hands an opaque `storageRef` to `createInstance` and `openInstance`, and drops the resource after the check. Adapters never provision, choose, or delete certification storage. PostgreSQL itself is started by the operator with `bun run services:up`, never by the harness.
  3. **Harness-owned process supervision.** The runner builds first, then supervises the actual implementation executable or its process group, never a `cargo run` or `go run` launcher. It records executable digest, PID, process epoch, signal, exit status, and replacement PID. Plan steps request graceful restart, forced kill, respawn, and storage reattachment as `control` operations. After a restart, the harness re-applies clock configuration and reattaches without reseeding.
  4. **Fault points are defined by storage boundaries from the checkpoint transaction** (docs/KrakenKernelSpecification.md §5.5):
     - before any checkpoint write;
     - after the TurnNode write and before the head moves;
     - after the head moves and before staging clears, which is reachable only where the implementation performs these as separate durable writes;
     - after durable commit and before the API acknowledges;
     - commit submitted with unknown outcome.

     Each point declares its trigger operation, scope, occurrence, and the recovery outcomes the authority allows. For the uncertain point, conditional assertions (ADR-0075) express both permitted outcomes, and both must hold the all-or-nothing invariant (§5.5 and the Crash Recovery Invariant). The current TypeScript `mid-commit` name is retired.
  5. **Arming and proof of reach.** A catalogued control `armFault {instance, point, selector, occurrence, mode} -> {token}` configures the implementation's test-only fault seam on one instance and returns a token that correlates every activation signal with that arming.
     - Mode `throw` raises a typed fault carrying the token inside the operation (memory and durable profiles).
     - Mode `block` makes the seam emit a `faultReached {token, processEpoch, phase}` notification and then block. The supervisor then sends SIGKILL without releasing the gate (process-crash profile).

     A check counts only with activation evidence whose token matches the arming: a typed fault outcome, or a `faultReached` receipt followed by the observed forced death of the same `processEpoch`. A missing receipt invalidates the run; it is never a pass. If a requested physical phase cannot be instrumented in a backend, that point is `unsupported` for that backend.
  6. **Recovery follows the native lifecycle.** After restart, the plan drives the public recovery surface. Adapters cannot insert reconciliation or choose the expected head. Expected heads come from earlier trace observations.
  7. **Fault seams per language.** Rust gains a test-only fault seam before it can certify fault checks. Go, Python, and Dart keep their existing seams, re-expressed against these points.
- **Alternatives considered:**
  - Both independent designs separated memory from durable profiles and made storage and kill harness-owned. Fable proposed self-termination (`exit` inside the hook) and confirmed reach through a post-restart `fired` counter. Codex proposed a blocking seam that emits a receipt, with the supervisor delivering the kill. The Codex mechanism was chosen because the receipt proves reach before death and the harness, not the implementation, owns the kill. Fable's fault points derived from §5.5 were adopted as the storage-boundary definitions Codex asked for. Fable's conditional assertions were adopted for the uncertain-commit point.
  - Random harness-timed kills. Rejected: not reproducible, and they cannot prove which phase was interrupted.
  - Adapter-internal close and reopen as restart. Rejected: it never leaves the process, so connection pools, file handles, and WAL replay are never exercised.
- **Consequences:** Assumed until observed. SQLite instrumentation sits inside the real transaction before `COMMIT` (`typescript/kernel/backends/sqlite/src/lib/sqlite-backend.ts:1215`). PostgreSQL client death is certifiable; server death and power-loss durability need a separate fault model that is not claimed here. Python's non-transactional checkpoint becomes directly testable at the intermediate points, and any observable partial state there is an implementation finding against §5.5. Process-crash checks run one adapter process per check, so they are slower and run in their own lane.
