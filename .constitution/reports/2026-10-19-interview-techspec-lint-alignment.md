# Interview record: TechSpec native lint alignment (2026-10-19)

Target: TechSpec (Stage 3, Evolution alignment pass). Scope: adopt the 22 TypeScript code decisions routed by `.constitution/reports/2026-10-19-reconciliation.yaml`, close the repeated compatibility question, and leave unrelated product decisions unchanged.

This record logs the owner's ruling and delegation. The Stage 3 alignment cites repository evidence and carries the ruling into ADR-0070 and `guidelines.md`.

## Scope and method

This pass is bounded to the October 19 reconciliation. The 22 routed decisions are physical TypeScript patterns, not product or architecture changes. Read-only reconciliation inspection grouped them into seven conventions and found no defect, missing sidecar, stack drift, or further owner decision.

The owner delegated the remaining alignment judgments, approved the recommended compatibility boundary for OD-09 and its copies OD-12 through OD-14, and later directed the agent to take ownership through merge. This delegation permits the bounded Stage 3 adoption below. It doesn't authorize new product scope, public API changes, suppressions, overrides, dependencies, or tooling changes.

## Compatibility ruling

Close OD-09, OD-12, OD-13, and OD-14 with *Preserve supported contracts and apply the selected preset's internal normalizations*.

The selected boundary permits changes to internal Promise timing or identity, generic error types, and `cause` fields when required by the approved lint preset. Implementations must preserve documented and authority-backed behavior, validation and event ordering, cancellation, and commit, rollback, and durable outcomes. An intentional public change still requires coordinated authority, tests, and release metadata under ADR-0056 and ADR-0069.

This ruling authorizes no new suppression or override. It doesn't reopen OD-10's four reviewed exceptions or broaden OD-11 beyond internal, unexposed function-valued properties. Public core method bivariance and API snapshots remain protected.

## Adopted conventions

The 22 decisions map to these seven local conventions:

- **A. Promise ports and sequencing:** Use bound `Promise.try` only as a local adapter for a required Promise port. Preserve arguments, the callback's explicit `undefined` receiver, thenables, supported errors, and observable ordering. Use the one-prefetch pull iterator only for the measured runtime and benchmark loops.
- **B. Safe operation registries:** Use a canonical `Map` or own-property check for untrusted adapter operation names. Preserve the existing unknown-operation error. Adapters remain observation-only.
- **C. Acyclic focused module ownership:** Use focused leaves, one-way value dependencies, and type-only reverse edges. Retain the existing root as dispatcher, composer, wiring owner, or public factory. Add no dependency-injection framework. Treat `runtime-contract-shapes` as an internal bridge.
- **D. Recursive predicate injection:** Pass recursive predicates into validation leaves where direct references create initialization cycles. Preserve traversal and error behavior.
- **E. Strict internal variance:** Use function-valued properties only on internal, unexposed surfaces covered by OD-11.
- **F. Native target cache and forwarding:** Accept an omitted `forwardAllArgs` during transition or literal top-level `false`. Reject unsafe forwarding shapes. A project-level input list repeats all inherited checker and configuration inputs and includes `^production` where dependency sources affect type-aware lint.
- **G. Test fixture topology:** Share base fake-kernel state and focused recovery helpers without test-to-test imports or duplicated staging logic.

## Reconciliation traceability

Table 1 follows the reconciliation report's exact tech-spec order. The commit is the report's producing evidence, and each path is present in the aligned repository.

| # | Group | Accepted decision | Repository evidence |
| :--- | :--- | :--- | :--- |
| 1 | A | Lift synchronous runtime test callbacks into required Promise ports with local bound `Promise.try` adapters. | `typescript/runtime/test/fake-kernel.ts`, `typescript/runtime/test/orchestration-runtime-runner-helpers.ts` at `af3c0e6a526fdaa6e2fe5012aafc5b8433ebcdcc` |
| 2 | F | Preserve complete target-level checker and configuration inputs plus transitive production sources. | `typescript/runtime/project.json` at `af3c0e6a526fdaa6e2fe5012aafc5b8433ebcdcc`; `.constitution/evidence/KRT-BT004/hashplanner-receipt.json` |
| 3 | A | Use one eagerly prefetched `next()` promise for the local sequential runtime and benchmark iterators. | `typescript/runtime/src/lib/runtime-core-loop.ts`, `typescript/runtime/bench/runtime-boundary.bench.ts` at `1f62bc31ea89394283ddbacb0e306a3508361f0b` |
| 4 | A | Lift synchronous adapter helpers into required Promise contracts while preserving arguments, thenables, rejections, messages, and ordering. | `typescript/providers/conformance-adapter/src/host.ts`, `typescript/conformance-adapter/src/framework-adapter-admission-key.ts`, `typescript/conformance-adapter/src/framework-adapter-event-stream-sse.ts`, `typescript/conformance-adapter/src/framework-adapter-event-stream-ws.ts` at `eaff021dc209772ca7d93bcd42c91797be9b5cbc` |
| 5 | B | Reject inherited operation names through own-property-safe or canonical `Map` registries. | `typescript/providers/conformance-adapter/src/host.ts`, `typescript/kernel/conformance-adapter/src/host.ts` at `eaff021dc209772ca7d93bcd42c91797be9b5cbc` |
| 6 | C | Split kernel scenarios into one-way leaves while the host remains the protocol dispatcher and composer. | `typescript/kernel/conformance-adapter/src/host.ts`, `typescript/kernel/conformance-adapter/src/host-protocol-logical-scenarios.ts`, `typescript/kernel/conformance-adapter/src/host-reclamation-scenarios.ts`, `typescript/kernel/conformance-adapter/src/host-restart-recovery-scenarios.ts`, `typescript/kernel/conformance-adapter/src/host-run-liveness-scenarios.ts`, and `typescript/kernel/conformance-adapter/src/host-scenario-support.ts` at `eaff021dc209772ca7d93bcd42c91797be9b5cbc` |
| 7 | D | Inject the recursive predicate into object and schema validation leaves. | `typescript/core/src/lib/runtime-contract-predicates.ts` at `4befa79e4db85afdf0443ea64a910e1e8b3e5aca` |
| 8 | D | Apply the same predicate injection to kernel-record recursion. | `typescript/core/src/lib/kernel-records.ts` at `4befa79e4db85afdf0443ea64a910e1e8b3e5aca` |
| 9 | A | Use `return await` normalization inside the MCP execution wrapper under the compatibility ruling. | `typescript/tools/mcp-client/src/lib/mcp-tool-source.ts` at `4befa79e4db85afdf0443ea64a910e1e8b3e5aca` |
| 10 | C | Split core validation and type families across acyclic modules while preserving exports, validation, variance, and snapshots. | `typescript/core/src/lib/runner-agent-config-snapshot-guards.ts`, `typescript/core/src/lib/runner-contract-guards.ts`, `typescript/core/src/lib/runtime-provider-contract-guards.ts`, `typescript/core/src/lib/runtime-data-contract-shapes.ts`, `typescript/core/src/lib/runtime-event-contract-shapes.ts`, and `typescript/core/src/lib/runtime-execution-contract-shapes.ts` at `4befa79e4db85afdf0443ea64a910e1e8b3e5aca` |
| 11 | C | Give persistence-host construction a focused runtime owner without changing ordering or package surface. | `typescript/runtime/src/lib/runtime-core-hosts-persistence.ts` at `1c74c19666a5c02d7aa6d18ff1067f98bb3f5ed4` |
| 12 | C | Separate runtime options and inert execution coordination while the shell retains host wiring and observability. | `typescript/runtime/src/lib/runtime-core-options.ts`, `typescript/runtime/src/lib/runtime-core-execution-controller.ts`, `typescript/runtime/src/lib/runtime-core.ts` at `1c74c19666a5c02d7aa6d18ff1067f98bb3f5ed4` |
| 13 | E | Use function-valued properties for strict variance only on the reviewed internal runtime surfaces. | `typescript/runtime/src/lib/binding-resolver.ts`, `typescript/runtime/src/lib/capability-policy-engine.ts` at `b544e98ffdbb81ec5b7c5578ab164c18f4d2284e` |
| 14 | A | Use the local bound `Promise.try` test-callback adapter in runtime core helpers. | `typescript/runtime/test/runtime-core-test-helpers.ts` at `b544e98ffdbb81ec5b7c5578ab164c18f4d2284e` |
| 15 | C | Give lazy orchestration streams and runner-result validation focused dependency-safe owners. | `typescript/runtime/src/lib/orchestration-runtime-lazy-stream.ts`, `typescript/runtime/src/lib/runtime-core-runner-result.ts` at `b544e98ffdbb81ec5b7c5578ab164c18f4d2284e` |
| 16 | C | Split tool execution into validation, staging, single-call, batch, resolution, and dependency-free error owners. | `typescript/runtime/src/lib/tool-execution-validation.ts`, `typescript/runtime/src/lib/tool-execution-staging.ts`, `typescript/runtime/src/lib/tool-execution-single.ts`, `typescript/runtime/src/lib/tool-execution-batch.ts`, `typescript/runtime/src/lib/tool-execution-resolution.ts`, and `typescript/runtime/src/lib/tool-execution-errors.ts` at `b544e98ffdbb81ec5b7c5578ab164c18f4d2284e` |
| 17 | G | Share run-liveness state and recovery helpers without test-to-test imports or duplicated staging. | `typescript/runtime/test/fake-run-liveness-kernel.ts`, `typescript/runtime/test/runtime-core-recovery-test-helpers.ts` at `b544e98ffdbb81ec5b7c5578ab164c18f4d2284e` |
| 18 | F | Accept literal top-level `forwardAllArgs: false` while preserving transitional omission and rejecting unsafe shapes. | `tools/scripts/lib/native-lint-routing.ts`, `tools/scripts/lib/native-lint-routing-argv.test.ts` at `b544e98ffdbb81ec5b7c5578ab164c18f4d2284e` |
| 19 | A | Normalize framework adapter helpers into required Promise contracts under the same supported-contract boundary. | `typescript/conformance-adapter/src/framework-adapter.ts`, `typescript/conformance-adapter/src/framework-adapter-batteries-included.ts`, `typescript/conformance-adapter/src/framework-adapter-capability-policy.ts`, `typescript/conformance-adapter/src/framework-adapter-invocation-lifecycle.ts`, `typescript/conformance-adapter/src/framework-adapter-provider-scenarios.ts`, `typescript/conformance-adapter/src/framework-adapter-recovery-scenarios.ts`, `typescript/conformance-adapter/src/framework-adapter-schema-authoring.ts`, `typescript/conformance-adapter/src/framework-adapter-secret-isolation.ts`, `typescript/conformance-adapter/src/framework-adapter-session.ts`, and `typescript/conformance-adapter/src/batteries-included-node-host.ts` at `d7d749d775cf519f3e1ac31cb81934927830c76b` |
| 20 | B | Use a canonical `Map` for framework adapter dispatch and preserve the explicit unknown-operation error. | `typescript/conformance-adapter/src/framework-adapter.ts` at `fbbf3a18764e5373f5c8f58d72812f587e149fa7` |
| 21 | C | Split framework adapter domains into one-way leaves while root modules remain public factories, composers, and dispatch owners. | `typescript/conformance-adapter/src/framework-adapter-admission-key-crash.ts`, `typescript/conformance-adapter/src/framework-adapter-input.ts`, `typescript/conformance-adapter/src/framework-adapter-recovery-result.ts`, `typescript/conformance-adapter/src/framework-adapter-runtime-lifecycle-scenarios.ts`, `typescript/conformance-adapter/src/framework-adapter-runtime-telemetry-scenarios.ts`, `typescript/conformance-adapter/src/framework-adapter-session-lifecycle.ts`, `typescript/conformance-adapter/src/framework-adapter-recovery-scenarios.ts`, `typescript/conformance-adapter/src/framework-adapter-runtime-scenarios.ts`, `typescript/conformance-adapter/src/framework-adapter-session.ts`, and `typescript/conformance-adapter/src/framework-adapter.ts` at `d7d749d775cf519f3e1ac31cb81934927830c76b` |
| 22 | C | Preserve the frozen core split and internal `runtime-contract-shapes` bridge without turning the bridge into a public guarantee. | `typescript/core/src/lib/runner-contract-guards.ts`, `typescript/core/src/lib/runtime-contract-guards.ts`, `typescript/core/src/lib/runtime-contract-shapes.ts` at `060c835b55015b591e71dba0a9975d95a4131d90` |

## Cache and evidence interpretation

The runtime lint target contains `default`, `^production`, and 13 explicit file inputs. KRT-BT004 measured 575 expanded inputs. The durable rule is complete inherited coverage plus dependency-source invalidation, not either count.

The historical 144-directive BP inventory and its 82-retained and 62-removed split describe commit `6ab5e36`. The KRT-BT004 suppression ledger records 59 runtime identities, split into 30 earlier behavior-proven removals and 29 admission removals. KRT-CX001 separately records 164 native exception regions in the CA delivery. These ledgers measure different sets and revisions. They aren't zero-suppression claims or global quotas.

KRT-BT004, KRT-BY004, and KRT-CX001 show that the pilot and later ratchet passed native lint, type checks, behavior checks, public API proof, and the relevant wider gates without adding a policy override. The first-directory pilot is therefore observed history rather than a pending condition.

## Register changes

- OD-09 closes from its original EPIC-BU question.
- OD-12 closes with the same ruling. Its historical `applied_by` entry for KRT-BY001 remains source provenance. Its `blocks` field changes from the unresolvable historical ticket KRT-BY001 to the existing KRT-BY004 evidence owner.
- OD-13 and OD-14 close with the same ruling. Their original `asked.in: EPIC-BY` values remain because reconciliation copied the question from that source epic before CV and CW proposed their records.
- The options, recommendation, interim assumption, `applied_by`, `proposed_by`, and question history remain in place.
- OD-01, OD-02, and OD-03 remain open. Closed OD-10 and OD-11 remain unchanged.

No owner decision remains for this alignment.
