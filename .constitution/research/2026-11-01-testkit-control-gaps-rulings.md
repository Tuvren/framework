---
owner: stage-3
date: "2026-11-01"
---
# Testkit control gaps: owner rulings

This record preserves the owner's rulings for ADR-0084 and the related task plan. Machine authority remains under `spec/`.

## Owner rulings

- Goal: "we must have a real testkit that can prove an implementation works end to end for a backend, keeping Go, Python, etc for later as a less urgent area to focus on, unless they are key to prove that the testkit works."
- Publishing bar, accepted from the lead's recommendation: zero undetected claims on the three durable profiles (kernel.persistent-reopen, kernel.process-crash, kernel.shared-backend), kernel.memory gaps closed by class, and every certificate lists any undetected claims that remain.
- Ordering: "Everything before what is currently open": the new work goes ahead of every other active epic.
- Lead decision within that goal: Rust reproductions of the memory controls follow the published testkit. Rust keeps running the canonical plans, including kernel.codec, as the second implementation, but it is withheld from the certified fleet until it kills its own tagged controls.
- Controls design: "I trust Fable's judgement. Go ahead with that in mind."
- OD-16 ruled: catalogue codec operations under a `kernel.codec` capability (the recommendation already in the register).
- OD-25 ruled: before-commit holds after all checkpoint writes and before COMMIT, amending ADR-0076 decision 4.
- Memory-backed control run on the host: not required and not linked to a certificate. It runs automatically only when a control fails, as a diagnostic that separates a verifier problem from a backend problem. Memory mutants remain release-CI evidence for the verifier.
- No users exist: breaking changes are fine; delete rather than deprecate or shim.
- Minimal code comments; never hard-wrap prose.

## Code checks and planning choice

`spec/kernel/authority-packet.json` lists six legacy and eleven syscall plans. The Go, Python, and Dart targets invoke `tools/conformance/harness/run.ts` through their adapter manifests (`go/kernel-certification/project.json`, `python/kernel-certification/project.json`, `dart/kernel-certification/project.json`); those manifests select the same packet. `tools/conformance/harness/run-plans.ts` loads every plan referenced by that packet before `tools/conformance/harness/check-selection.ts` filters checks. `tools/scripts/compatibility-report.ts` also derives its inventory from the packet, and `tools/conformance/plan-compiler/validate-plans.ts` separately scans legacy operation sources. Filtering checks alone would leave legacy plans in downstream inputs. An adapter-only plan list would be simpler but would break the packet-to-plan authority flow in `.constitution/architecture/flows/flow-authority-packet-driven-conformance.md`. The temporary legacy packet therefore has a distinct ID: `tools/conformance/plan-compiler/certification-assessment.ts` rejects duplicate IDs and requires catalog IDs to match. The legacy plans adopt that ID and remain report-only. `tools/conformance/certification/provenance.ts` expects catalog, profile, and control references on every packet it digests, so DQ must handle the unprofiled legacy packet without weakening canonical certification. This integration remains assumed until DQ verifies it.

The three adapter initialize handlers echo a supplied nonempty packet ID (`go/kernel-conformance-adapter/main.go`, `python/kernel-conformance-adapter/src/tuvren_kernel_adapter/__main__.py`, `dart/kernel-conformance-adapter/lib/adapter.dart`). The ID change therefore appears possible without migrating their kernels, but this remains an inference until DQ runs their conformance lanes.

The control gate reads one configured packet and its manifest, profile, and loaded plans (`tools/conformance/meta-conformance/negative-controls.ts`, `tools/conformance/meta-conformance/negative-control-config.ts`). DK needs the canonical packet, verifier inputs, and existing lane baselines; DL needs the TypeScript binding and the backend-suite obligation audit (`.constitution/tasks/epics/EPIC-DK-portable-certification-core.yaml`, `.constitution/tasks/epics/EPIC-DL-published-backend-testkit.yaml`). Neither task text requires the other three kernels to migrate. It is inferred that both can proceed after quarantine, subject to the DQ checks and unchanged legacy-lane observations.

The two legacy protocol files contain 54 deterministic-hash assertions and 14 canonical-rejection assertions (`spec/conformance/kernel/plans/kernel-protocol-core.json`, `spec/conformance/kernel/plans/kernel-protocol-extended.json`). The memory register has 40 entries, including the schema-roundtrip aggregate and 17 fixture entries (`spec/conformance/kernel/kernel-memory-undetected.json`).

Fable's statement that durable lanes already run all mutants on SQLite and PostgreSQL is too broad: the 15-control manifest has 14 implementation controls and one instrumentation control, and each durable profile currently tags only one control (`spec/conformance/kernel/negative-controls.json`, `tools/conformance/meta-conformance/negative-control-config.ts`). Fable's runner-process activation-counter claim is also not current behavior: the TypeScript adapter selects the counter in its own process and exposes it through the activation operation (`typescript/kernel/conformance-adapter/src/host.ts`, `typescript/kernel/testkit/src/lib/kernel-mutant-registry.ts`). An in-process backend is not isolated from malicious code; no unforgeability claim is made.

The link already compares the implementation string, adapter name, and adapter-manifest digest (`tools/conformance/certification/control-link.ts`). The required change is to bind the actual implementation and its profile-specific control outcomes to that comparison. The proposed one-call-per-transaction mutant is unrun. `RuntimeBackendTx.now` is optional (`typescript/kernel/protocol/src/lib/kernel-types.ts`), so the proposed clock capture applies only when the backend supplies it. SQLite checks the stored tree and path invariants at each write-set commit (`typescript/kernel/backends/sqlite/src/lib/sqlite-transaction-validation.ts`, `typescript/kernel/backends/shared/src/lib/backend-invariant-state-validation.ts`), so it is inferred that a tree committed before its paths will fail. The spike must measure this and other backend invariants rather than assume foreign-key order alone suffices.
