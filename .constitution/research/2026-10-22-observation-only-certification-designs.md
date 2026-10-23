---
owner: stage-3
date: "2026-10-22"
---
# Observation-Only Certification: Audit, Review, and Independent Designs

This is the design record behind ADR-0075 to ADR-0081, written by the 2026-10-22 Stage 3 decisions pass. It preserves the measured baseline, the adversarial review of the first draft, and the two independent designs that the ADRs synthesize. It is not authority. The authority packets and the conformance plans under `spec/` stay the cross-implementation oracle.

## Owner direction

The owner asked to build certification for internal use first, to make sure the repository genuinely certifies compliance instead of self-asserting it, and to run it against the first-party implementations, triaging each finding as a verification defect or an implementation defect. Publishing a public testkit (issue #154) waits on this work. Rulings made in the session:

- Certification runs before the Bazel wave continues.
- Rust is the second kernel language.
- `tree.diff` returns `changedPaths` in canonical order.
- Kernel erasure checks are limited to ciphertext retention and unchanged lineage.
- Self-asserting and redundant unit tests may be removed.
- Code comments stay minimal.

## Measured baseline at 04b277ce

Three read-only audits covered the kernel adapters in all five languages, the non-kernel adapters, and the harness internals.

- **Kernel operations:** 21 in total. Hashing, schema round-trip, and fixture-driven modify-composition are direct observations. Twelve operations return adapter-derived verdicts asserted against `true` or constants:
  - canonical rejection;
  - thread listing;
  - expired listing;
  - stale and clock-skew preemption;
  - close-reopen, crash-recovery (durable and in-process), and concurrent-writer recovery;
  - scope isolation;
  - reclamation and erasure probes.
- **Specific defects found:**
  - Rust `recovery-state` echoes its input fixture.
  - Rust erasure reports `unrecoverableAfterErasure` because the adapter dropped its own key.
  - `workerClockWouldExpire` compares two constants.
  - Python derives its expected checkpoint from `reconcile` output.
  - TypeScript `normalizeLogicalErrorCode` masks native codes.
  - The writer race is concurrent only in TypeScript.
- **Non-kernel plans:**
  - 931 assertions, of which 845 are `resultField` and 221 compare a literal boolean.
  - Around 75 composite handlers in `typescript/conformance-adapter`.
  - Hardcoded literals such as `constructed: true` (batteries-included) and `succeeded: true` and `sessionEstablished: true` (MCP).
  - `host-session.validate-frame-fixtures` computes `allMatch` against the fixture's own `expectedValid`.
  - Runtime projection checks project real `handle.events()` after buffering. The SSE decode trace is a direct observation.
- **Harness:**
  - Steps and traces exist, but dispatch is sequential.
  - The TypeScript stdio host is serial and batches events.
  - There is no process kill or storage handoff.
  - Raw status is `pass` when zero checks apply (`run.ts:881`).
  - Two unresolved operands compare equal.
  - `framework-rust-certification` (0 of 523 applicable) is listed in `certified-projects.json`.
  - Meta-conformance checks the evaluator and compiler but runs no defective implementation.
- **Crash testing:**
  - No process is ever killed.
  - The TypeScript `midCommit` hook commits and then throws.
  - Python's mid-commit point sits between three non-transactional calls.
  - Rust has no fault seam.
  - Rust, Go, Python, and Dart kernels are in-memory only.

## Adversarial review of the first draft (Codex gpt-6.1-sol, high effort)

- **Corrections to the draft:**
  - Event-stream checks project implementation-emitted events, not fixture substitutes.
  - The assertion counts needed a stated scope.
  - "Primitive" needed categories.
  - Meta-conformance covers more than the assertion engine.
  - Rust framework evidence honestly says `unsupported`; the defect is the zero-check `pass` and the certified listing.
- **Ranked flaws in the draft:**
  1. Schema plus hash checks cannot prove provenance, so the trust model must be stated as first-party.
  2. Process death was conflated with durable recovery capability.
  3. Crash points lacked storage-boundary semantics and proof of reach.
  4. Sequential traces cannot express races or live streams.
  5. The wire representation and identity projections were undefined.
  6. Mutation scoring would count irrelevant failures as kills.
  7. Triage had no authority baseline and no reproducible failure artifact.
  8. A boundary-wide capability floor would reject specialized profiles.
  9. Expectation leakage needs structural provenance, not name matching.
  10. The assertion extensions need non-vacuity rules.
  11. Kernel erasure was grading an adapter-owned responsibility.
- **Rollout recommendation:** integrity floor, then a narrow TypeScript kernel slice, then Rust, then durable lifecycle, then orchestration, then the remaining families.

## Independent design A (Claude Fable)

- **Adapters:** syscall bridges.
- **Catalog:** `spec/<port>/operations.json` with `syscall`, `control`, and `double` kinds and closed observation schemas.
  - The compiler enforces catalog paths, a no-echo rule, and native-boolean-only literals.
- **Test doubles:** scripted fixtures, certified by their own double-conformance plan.
- **Storage:** harness-provisioned per instance, with `openInstance` for reattach and harness-owned SIGKILL and respawn.
- **Faults:** `armFault` with `throw` or `exit`. Points follow kernel specification §5.5. Reach is proven by a post-restart `fired` counter.
- **Uncertain outcomes:** conditional `when` assertions encode the crash recovery invariant, and the fleet must exercise both branches.
- **Streaming and concurrency:**
  - Events arrive as JSON-RPC notifications.
  - The harness owns cancellation.
  - Backpressure is acknowledgement-based.
  - Same-group steps dispatch concurrently.
  - Durable races run from two processes on one storage reference.
- **Encoding:** hex `$bytes`, plus a `$int` escape for large integers.
- **Integrity assertions:** CDDL-generated record schemas and runner `digest`, `canonicalCbor`, and `turnNodeIdentity` assertions.
- **Negative controls:** a mutant adapter `--defect`, with exact failed-set equality against `mustFail` and an `undetected` report. The first control run targets the current plans.
- **Profiles and classification:** profiles live in the authority packet. The runner pre-classifies failures and generates a cross-implementation disagreement report.
- **Rollout:** hygiene, then catalog, then controls against current plans, then per-family kernel rewrites (TypeScript, Rust, then the rest), then lifecycle, then streaming and framework, then profiles.

## Independent design B (Codex gpt-6.1-sol, high effort)

- **Trust model:** stated as first-party.
- **Catalog:** `spec/conformance/<port>/operations.json` with binding references, input, result, and event schemas, error bindings, and handle types.
  - Steps carry explicit `arguments` projections, and adapters are launched without expectation assets.
  - Rewrites keep a `claimId` obligation map, and expectations are never regenerated from passing output.
- **Test doubles:** controlled dependencies with request journals.
- **Profiles:**
  - `kernel.memory`, `kernel.persistent-reopen`, and `kernel.process-crash`.
  - A harness supervisor runs the real executable.
  - Fault points are physical phases.
  - `armFault` blocks at the seam and emits `faultReached`, then the supervisor kills the process.
  - A missing receipt invalidates the experiment.
- **Orchestration:** operation handles (`start`, `await`, `cancel`), `subscribe`, `pull` credit, and typed step actions including barriers placed in reviewed seams.
- **Encoding:**
  - Hex bytes and a recursive tagged union for arbitrary records.
  - Out-of-range integers are rejected.
  - Duplicate keys are rejected.
  - Identity recipes are machine-readable.
  - Rust cross-validates the vectors.
- **Negative controls:** behavioral mutants in testkits with a manifest under `spec/conformance/<port>/`. A baseline pass and a designated failing claim are required, and infrastructure failures don't count.
- **Certificates:** profiles in `spec/conformance/<port>/profiles.json`. The certificate is a complete evidence bundle with digests, environment, selection inventory, transcripts, operands, and replay.
- **Rollout:** hygiene, then catalogs and wire, then the TypeScript kernel, then Rust, then handles and streams, then storage and crash, then Go, Python, and Dart, then framework ports, then certificates.

## Synthesis

The two designs converged on:

- syscall-bridge adapters;
- catalogs with closed observation schemas;
- runner-owned expectations;
- separate memory and durable profiles;
- harness-owned storage and kill;
- notification-based streams;
- hexadecimal bytes;
- runner identity recomputation;
- testkit mutants gated in the certification lane;
- vertical, per-family rollout.

The ADRs record how each divergence was settled:

| Topic | Taken from design | ADR |
| :--- | :--- | :--- |
| Catalog and profile placement | B (`spec/conformance/<port>/`) | ADR-0075, ADR-0081 |
| No-echo rule and explicit arguments | Both | ADR-0075 |
| Claim obligation maps | B | ADR-0075 |
| Conditional assertions | A | ADR-0075, ADR-0076 |
| Fault arming | B (receipt, block, then supervisor kill), with A's §5.5 points | ADR-0076 |
| Concurrency | B (handles and pull credit), with A's two-process race and `arrival` assertion | ADR-0077 |
| Integers | B (reject out-of-range) | ADR-0078 |
| Kill rule | B (designated assertions with activation proof), with A's baseline run | ADR-0079 |
| Failure classification | B (bundle contents), with A's runner pre-classification and disagreement report | ADR-0081 |
