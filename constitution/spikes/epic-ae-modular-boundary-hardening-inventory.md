# Epic AE Modular Boundary Hardening Inventory

This file closes Epic AE against current repo reality and records the largest
TypeScript semantic gravity wells, the extraction map, and the final
line-count posture after the split. It is a planning and implementation
handoff, not a semantic authority packet.

## Status

- `KRT-AE001` through `KRT-AE009` are complete in current repo reality.
- Epic AE is closed by the repo-wide size audit and `bun run verify` pass.
- This inventory is the seam map and closure log for the landed
  implementation slices.

## Current Repo Reality

The latest repo-wide size scan no longer shows any `boundaries/**/*.ts` file
above the `1000` hard ceiling. The remaining pressure is now concentrated in
near-threshold production, support, and test files that still merit cleanup
or completion-audit attention:

- `boundaries/framework/implementations/typescript/runtime-core/src/lib/runtime-core.ts`
- `boundaries/framework/implementations/typescript/runtime-core/src/lib/runtime-kernel-grpc-codec.ts`
- `boundaries/framework/implementations/typescript/runtime-core/src/lib/orchestration-runtime-node.ts`
- `boundaries/framework/implementations/typescript/drivers/react/src/lib/react-driver-stream-support.ts`
- `boundaries/kernel/implementations/typescript/backend-sqlite/src/lib/sqlite-state-validation.ts`
- `boundaries/framework/implementations/typescript/runtime-core/test/fake-kernel.ts`
- `boundaries/framework/implementations/typescript/runtime-core/test/runtime-core.recovery.test.ts`
- `boundaries/framework/implementations/typescript/runtime-core/test/runtime-core.stream-validation.test.ts`
- `boundaries/framework/contracts/driver-api/implementations/typescript/src/lib/driver-contract-guards.ts`
- `boundaries/framework/implementations/typescript/runtime-core/src/lib/tool-execution.ts`

The current measured line counts no longer show the original pressure pattern,
but a long sequence of active slices has landed since the initial map:

- `runtime-core.ts` now delegates iteration execution, assistant-event
  validation, response helpers, recovery helpers, and loop orchestration into
  dedicated internal modules, while preserving the current
  `framework-runtime-core` typecheck and test lanes.
- `runtime-core.ts` now also delegates driver-context assembly, staged driver
  message persistence, requested tool-batch application, and after-iteration
  resolution composition into a dedicated internal driver helper module, while
  preserving the same narrow verification lanes.
- `runtime-core.ts` now delegates paused approval resume and rejected paused
  tool-cancellation handling into a dedicated internal tool-resume helper
  module, again with the package-local typecheck and test lanes still green.
- `runtime-core.ts` now delegates context-engineering helper storage plus
  handoff source-context shaping into a dedicated internal context helper
  module, with the same narrow runtime-core verification lanes still green.
- `runtime-core.ts` now delegates runtime-status checkpoint and finalization
  helpers into a dedicated internal status helper module, again without
  breaking the package-local typecheck or test lanes.
- `runtime-core.ts` now also delegates context-engineering application and
  handoff application into a dedicated internal context-ops helper module,
  with the same package-local verification lanes still green.
- `runtime-core.ts` now also delegates branch-head loading, recovered runtime
  status reads, manifest and message materialization, and parent-turn
  resolution into a dedicated internal head-state helper module, again while
  preserving the narrow runtime-core typecheck and test lanes.
- `runtime-core.ts` now also delegates stream publication, synthesized
  assistant-event backfill, projected error emission, state observability, and
  staging/persistence helpers into dedicated internal event and persistence
  modules, again with the package-local verification lanes still green.
- `runtime-core.ts` now also delegates tracked-run creation/completion and run
  lease-liveness coordination into a dedicated internal liveness helper module,
  again while preserving the narrow runtime-core typecheck and test lanes.
- `runtime-core.ts` now also delegates expired-run recovery classification,
  recovered-iteration counting, and recovered terminal completion handling into
  a dedicated internal expired-recovery helper module, again with the same
  package-local verification lanes still green.
- `runtime-core.ts` now also delegates iteration completion, iteration-tree
  construction, tracked-run branch restoration, and checkpointed paused-run
  override handling into a dedicated internal turn-progress helper module,
  again while preserving the narrow runtime-core typecheck and test lanes.
- `runtime-core.ts` now also delegates pause publication, approval-resolution
  publication, paused-cancellation completion, and execution failure/final
  turn completion handling into a dedicated internal finalization helper
  module, again with the same package-local verification lanes still green.
- `runtime-core.ts` now also delegates branch-head validation, execution-turn
  creation, initial loop-state derivation, fresh-start prelude handling, and
  resumed-start prelude/completion orchestration into a dedicated internal
  startup helper module, again while preserving the narrow runtime-core
  typecheck and test lanes.
- `runtime-core.ts` now also delegates input incorporation, steering
  incorporation, and extension-state commit persistence into a dedicated
  internal state-commit helper module, again with the same package-local
  verification lanes still green.
- `runtime-core.ts` now also delegates tool-batch environment construction,
  driver handoff-plan shaping, and driver execution error wrapping into a
  dedicated internal driver-support helper module, again while preserving the
  narrow runtime-core typecheck and test lanes.
- `runtime-core.ts` now also delegates the context/state/persistence/liveness/
  finalization/startup host-builder cluster into `runtime-core-hosts.ts`,
  again while preserving the same `framework-runtime-core` typecheck and test
  lanes.
- `runtime-core.ts` now also delegates the bottom-of-file normalization,
  driver-snapshot, active-tool-registry, and pending-hash helper block into
  `runtime-core-facade-utils.ts`, again while preserving the same
  `framework-runtime-core` typecheck and test lanes.
- `runtime-core.ts` now also delegates the remaining head-state / schema /
  driver-materialization / handoff-source-context facade cluster into
  `runtime-core-facade-ops.ts`, again while preserving the same
  `framework-runtime-core` typecheck and test lanes.
- `runtime-core.ts` now also delegates the remaining cached host-factory
  wiring into `runtime-core-facade-hosts.ts`, shrinking the public facade
  again while preserving the same `framework-runtime-core` typecheck and test
  lanes across `198` passing tests.
- `runtime-core-assistant-validation.ts` now also delegates standalone
  assistant-sequence splitting, replay synthesis, and event-shape matching
  into `runtime-core-assistant-validation-sequences.ts`, bringing the live
  assistant-validation execution surface back under the ceiling while
  preserving the same `framework-runtime-core` typecheck and test lanes
  across `198` passing tests.
- `runtime-core.ts` now also delegates execution-handle creation, resumed
  handle creation, and the main execution-session startup lifecycle into
  `runtime-core-execution-session.ts`, bringing the public runtime facade down
  again while preserving the same `framework-runtime-core` typecheck and test
  lanes across `198` passing tests.
- `runtime-core.ts` now also delegates the loop/iteration orchestration
  adapter wiring plus the driver/context/state-commit wrapper family into
  `runtime-core-execution-orchestration.ts`, bringing the public runtime
  facade down again while preserving the same `framework-runtime-core`
  typecheck and test lanes across `198` passing tests.
- `runtime-core.ts` now also sheds a large dead-import and dead-wrapper layer
  left behind by earlier extractions, bringing the live public runtime facade
  down again while preserving the same `framework-runtime-core` typecheck and
  test lanes across `198` passing tests.
- `runtime-core.ts` now also delegates the run-liveness, stale-recovery,
  checkpointed-pause, and branch-advance lifecycle wrapper family into
  `runtime-core-runtime-lifecycle.ts`, bringing the live public runtime
  facade down again while preserving the same `framework-runtime-core`
  typecheck and test lanes across `198` passing tests.
- `runtime-core.ts` now also delegates the small context/driver failure-adapter
  tail into `runtime-core-facade-adapters.ts`, keeping the runtime-core lane
  green while setting up the next larger facade cut.
- `runtime-core.ts` now also deletes the remaining observability and
  persistence wrapper tail by calling the extracted helper modules directly,
  bringing the live public runtime facade down again while preserving the same
  `framework-runtime-core` typecheck and test lanes across `198` passing
  tests.
- `runtime-core.ts` now also deletes the remaining thin head-state and facade
  adapter wrapper layer by calling the extracted helper modules directly,
  bringing the live public runtime facade down again while preserving the same
  `framework-runtime-core` typecheck and test lanes across `198` passing
  tests.
- `runtime-core.ts` now also delegates the remaining default-handoff builder,
  context-helper bundle creation, paused-finalization adapters, and terminal
  handoff-transition wrapper family into
  `runtime-core-transition-support.ts`, bringing the live public runtime
  facade down again while preserving the same `framework-runtime-core`
  typecheck and test lanes across `198` passing tests.
- `runtime-core.ts` now also delegates the remaining execution-session,
  iteration driver, tool-batch, state-commit, and finalization wrapper family
  into `runtime-core-facade-execution.ts`, bringing the live public runtime
  facade down to roughly `950` lines while the same
  `framework-runtime-core` typecheck and test lanes stay green across `198`
  passing tests.
- `orchestration-runtime.ts` now also delegates the orchestration node engine,
  child-binding state machine, and single-consumer stream helpers into
  `orchestration-runtime-node.ts`, bringing the public orchestration facade
  down under `300` lines while the same `framework-runtime-core` typecheck
  and test lanes stay green across `198` passing tests.
- `runtime-core.test.ts` no longer carries the stale-run recovery family
  alone; those checks now live in a dedicated `runtime-core.recovery.test.ts`
  file, with the package-local runtime-core test lane still green across four
  test files.
- `runtime-core.test.ts` no longer carries the paused-approval and resume
  family alone either; those checks now live in a dedicated
  `runtime-core.approval.test.ts` file, with the same package-local
  runtime-core test lane still green across five test files.
- `runtime-core.test.ts` no longer carries the handoff and steering /
  orchestration family alone either; those checks now live in a dedicated
  `runtime-core.orchestration.test.ts` file, with the same package-local
  runtime-core test lane still green across six test files.
- `runtime-core.test.ts` no longer carries the tooling, stream-validation, and
  driver-boundary family alone either; those checks now live in a dedicated
  `runtime-core.tooling.test.ts` file, with the same package-local
  runtime-core test lane still green across seven test files.
- `runtime-core.test.ts` no longer carries the lifecycle, parent-turn, schema,
  and early extension-state family alone either; those checks now live in a
  dedicated `runtime-core.lifecycle.test.ts` file, with the same package-local
  runtime-core test lane still green across eight test files.
- `runtime-core.test.ts` has now been fully retired as a monolith; the
  remaining hook/context, manifest-budget, and event-stream-consumer checks now
  live in `runtime-core.hooks.test.ts`, with the same package-local
  runtime-core test lane still green across eight test files.
- `runtime-core.hooks.test.ts` now further delegates the context-engineering,
  manifest-budget warning, state-snapshot, and single-consumer event-stream
  family into `runtime-core.context-engineering.test.ts`, bringing the hooks
  file itself back under the ceiling while the same package-local runtime-core
  test lane stays green across nine test files.
- `runtime-core.lifecycle.test.ts` now further delegates the first-turn
  extension-state seeding and bootstrap cloning family into
  `runtime-core.bootstrap.test.ts`, bringing the lifecycle file back under the
  ceiling while the same package-local runtime-core test lane stays green
  across ten test files.
- `runtime-core.tooling.test.ts` now further delegates the assistant-stream
  reconciliation and durable/live divergence guard family into
  `runtime-core.assistant-stream.test.ts`, reducing the tooling monolith while
  the same package-local runtime-core test lane stays green across eleven test
  files.
- `runtime-core.tooling.test.ts` now further delegates the malformed input,
  driver-boundary, and invalid response contract family into
  `runtime-core.driver-boundary.test.ts`, reducing the tooling monolith again
  while the same package-local runtime-core test lane stays green across
  twelve test files.
- `runtime-core.tooling.test.ts` now further delegates the assistant/tool-call
  stream-sequence validation family into `runtime-core.stream-validation.test.ts`,
  and then further delegates the reasoning-specific validation checks into
  `runtime-core.reasoning-stream.test.ts`, bringing the extracted
  stream-validation file back under the ceiling while the same package-local
  runtime-core test lane stays green across fourteen test files.
- `runtime-core.tooling.test.ts` now delegates the registry, prompt/hook
  isolation, same-turn boundary, token-estimate, and manifest-cloning family
  into `runtime-core.foundation.test.ts`, bringing the new foundation slice
  in under the ceiling while the same package-local runtime-core test lane
  stays green across fifteen test files.
- `runtime-core.tooling.test.ts` now also delegates the driver-neutral
  execution baseline, durable-output event synthesis, and event-consumer
  lifecycle family into `runtime-core.execution-lifecycle.test.ts`, bringing
  the remaining tooling file itself back under the ceiling while the same
  package-local runtime-core test lane stays green across sixteen test files.
- `runtime-core.approval.test.ts` now delegates the parallel/sequential
  batching, bounded concurrency, preflight ordering, and incremental staging
  family into `runtime-core.tool-batching.test.ts`, bringing the new batching
  slice in under the ceiling while the same package-local runtime-core test
  lane stays green across seventeen test files.
- `runtime-core.approval.test.ts` now also delegates the explicit reject/edit
  decision flows, resumed decision staging, wrapped approval-gate resumption,
  and paused-status snapshot isolation family into
  `runtime-core.approval-decisions.test.ts`, bringing the new decision slice
  in under the ceiling while the same package-local runtime-core test lane
  stays green across eighteen test files.
- `runtime-core.approval.test.ts` now also delegates the malformed initial and
  resumed approval-request failure family into
  `runtime-core.malformed-approval.test.ts`, bringing that new failure slice
  in under the ceiling while the same package-local runtime-core test lane
  stays green across nineteen test files.
- `runtime-core.approval.test.ts` now also delegates the mixed invalid-result,
  persisted-call-order, timeout, late-event suppression, and thrown-validator
  family into `runtime-core.tool-failures.test.ts`, bringing that new failure
  slice in under the ceiling while the same package-local runtime-core test
  lane stays green across twenty test files.
- `runtime-core.approval.test.ts` now also delegates the aroundTool receiver,
  renewed-pause, late-pause rejection, after-next error, and state-isolation
  family into `runtime-core.around-tool-approval.test.ts`, bringing that new
  behavior slice in under the ceiling while the same package-local
  runtime-core test lane stays green across twenty-one test files.
- `runtime-core.approval.test.ts` now also delegates the core mixed-batch
  pause/resume and exhausted-handle approval behavior into
  `runtime-core.approval-basics.test.ts`, bringing that new behavior slice in
  under the ceiling while the same package-local runtime-core test lane stays
  green across twenty-two test files.
- `runtime-core.approval.test.ts` now also delegates the paused-runtime-status,
  loop-limit, cancellation, and initial invalid driver/pause lifecycle family
  into `runtime-core.approval-lifecycle.test.ts`, bringing that new behavior
  slice in under the ceiling while the same package-local runtime-core test
  lane stays green across twenty-three test files.
- `runtime-core.orchestration.test.ts` now also delegates the malformed
  steering validation, steering incorporation, and pre-start steering
  rejection family into `runtime-core.steering.test.ts`, bringing that new
  behavior slice in under the ceiling while the same package-local
  runtime-core test lane stays green across twenty-four test files.
- `runtime-core.orchestration.test.ts` now also delegates the preserve-trace,
  last-output-only, raw-plan normalization, and handoff-builder agent-shaping
  family into `runtime-core.handoff-builders.test.ts`, bringing that new
  builder slice in under the ceiling while the same package-local
  runtime-core test lane stays green across twenty-five test files.
- `runtime-core.recovery.test.ts` now also delegates the late-output fencing,
  stale handoff/steering recovery, and durable terminal status recovery
  family into `runtime-core.stale-step-recovery.test.ts`, bringing the
  remaining recovery file itself back under the ceiling while the same
  package-local runtime-core test lane stays green across twenty-six test
  files.
- `runtime-core.approval.test.ts` now also delegates the resumed-handle
  cancellation, paused-handle inertness, and queued-steering transfer family
  into `runtime-core.approval-resume.test.ts`, bringing the remaining approval
  file itself back under the ceiling while the same package-local runtime-core
  test lane stays green across twenty-seven test files.
- `runtime-core.hooks.test.ts` now also delegates the synthesized
  after-iteration response, partial tool-call checkpointing, emitted metadata,
  and clone-isolation family into `runtime-core.after-iteration.test.ts`,
  bringing the remaining hooks file down to a smaller package-local slice
  while the same runtime-core test lane stays green across twenty-eight files.
- `runtime-core.tooling.test.ts` now also delegates the durable structured
  output and tool-call stream synthesis family into
  `runtime-core.stream-synthesis.test.ts`, bringing the remaining tooling file
  down to a smaller package-local slice while the same runtime-core test lane
  stays green across twenty-nine files.
- `runtime-core.tool-batching.test.ts` now also delegates the parallel wave,
  delayed preflight ordering, and incremental staging family into
  `runtime-core.parallel-batching.test.ts`, bringing the remaining batching
  file down to a smaller package-local slice while the same runtime-core test
  lane stays green across thirty files.
- `runtime-core.lifecycle.test.ts` now also delegates the implicit
  parent-linking, forked-branch linking, explicit parent mismatch, and
  branch/thread guard family into `runtime-core.turn-linking.test.ts`,
  bringing the remaining lifecycle file down to a smaller package-local slice
  while the same runtime-core test lane stays green across thirty-one files.
- `runtime-core.orchestration.test.ts` now also delegates the driver helper
  handoff plan, provider-backed handoff config, latest-source-context, seeded
  target extension state, and last_output_only helper family into
  `runtime-core.handoff-driver.test.ts`, bringing the remaining orchestration
  file down to a smaller package-local slice while the same runtime-core test
  lane stays green across thirty-two files.
- `sqlite-backend.ts` now delegates transaction write-set validation, persisted
  lineage/root index validation, and reusable rollback/chunk/parent
  integrity assertions into `sqlite-transaction-validation.ts` and
  `sqlite-integrity-assertions.ts`, bringing the remaining backend facade
  itself back under the ceiling while the same package-local
  `backend-sqlite` typecheck and test lanes stay green.
- `ai-sdk-provider-bridge.ts` now delegates low-level cloning, metadata,
  bridge-error shaping, stream mapping, prompt projection, and generate-result
  projection into dedicated internal modules, while preserving the
  `providers-bridge-ai-sdk` typecheck and test lanes.
- `framework-adapter.ts` now delegates driver execute, resume, and checkpoint
  scenarios into a dedicated `framework-adapter-driver.ts` module, while the
  shared runtime and message scaffolding now lives in
  `framework-adapter-runtime.ts`; the narrow
  `framework-typescript-conformance-runner` typecheck and test lanes remain
  green after the split.
- `framework-adapter.ts` now also delegates orchestration scenarios into a
  dedicated `framework-adapter-orchestration.ts` module and event-stream
  projection scenarios into `framework-adapter-event-stream.ts`, while the
  same narrow `framework-typescript-conformance-runner` typecheck and test
  lanes remain green after both extractions.
- `framework-adapter.ts` now also delegates runtime execution, provider,
  tool, context-transform, and recovery scenarios into
  `framework-adapter-runtime-scenarios.ts`, bringing the public adapter facade
  itself below the repository's `1000`-line ceiling while preserving the same
  narrow uncached `framework-typescript-conformance-runner` typecheck and test
  lanes.
- `framework-adapter-runtime-scenarios.ts` now further delegates provider /
  tool / context / validation checks into `framework-adapter-provider-scenarios.ts`
  and recovery checks into `framework-adapter-recovery-scenarios.ts`, bringing
  that runtime scenario module itself back under the ceiling while preserving
  the same narrow uncached `framework-typescript-conformance-runner`
  typecheck and test lanes.
- `framework-adapter-orchestration.ts` now delegates the lifecycle-locality
  family into `framework-adapter-orchestration-lifecycle.ts`, bringing the
  remaining orchestration facade back under the ceiling while preserving the
  same narrow uncached `framework-typescript-conformance-runner` typecheck and
  test lanes.
- `sqlite-backend.ts` now delegates migration-directory resolution and package
  schema definitions into `sqlite-schema.ts`, while schema presence and
  shape validation now live in `sqlite-validation.ts`; the narrow
  `backend-sqlite` typecheck and test lanes remain green after also updating
  the dist-layout test harness to stage the new sibling runtime modules.
- `sqlite-backend.ts` now also delegates row-shape declarations, record
  decoding, loaded-state construction, shared record byte-cloning helpers, and
  backend error normalization into `sqlite-records.ts` and `sqlite-errors.ts`;
  the same narrow `backend-sqlite` typecheck and test lanes remain green after
  extending the dist-layout harness to stage those new runtime siblings too.
- `sqlite-backend.ts` now also delegates the select / ensure / schema-lookup
  cluster into `sqlite-lookups.ts`, with the same narrow `backend-sqlite`
  typecheck and test lanes still green after extending the dist-layout harness
  to stage that runtime sibling as well.
- `sqlite-backend.ts` now also delegates transactional write-set bookkeeping
  into `sqlite-write-tracker.ts`, again with the same narrow `backend-sqlite`
  typecheck and test lanes still green after extending the dist-layout harness
  to stage that runtime sibling too.
- `sqlite-backend.ts` now also delegates the lower-coupling observe/object/
  chunk/schema/staged-result/thread repository families into
  `sqlite-repositories-support.ts`, with the same narrow `backend-sqlite`
  typecheck and test lanes still green after extending the dist-layout harness
  to stage that runtime sibling as well.
- `sqlite-backend.ts` now also delegates the remaining branch/run/turn/
  turn-node/turn-tree/turn-tree-path repository core into
  `sqlite-repositories-core.ts`, again with the same narrow
  `backend-sqlite` typecheck and test lanes still green after extending the
  dist-layout harness to stage that runtime sibling too.
- `sqlite-backend.ts` now also delegates the shared state `ensure*` helpers,
  clone/equality helpers, stable ordering helpers, and observe-annotation key
  helpers into `sqlite-state-utils.ts`, again with the same narrow
  `backend-sqlite` typecheck and test lanes still green after extending the
  dist-layout harness to stage that runtime sibling too.
- `sqlite-backend.ts` now also delegates loaded-state identity validation and
  committed-state invariant validation into `sqlite-state-validation.ts`,
  again with the same narrow `backend-sqlite` typecheck and test lanes still
  green after extending the dist-layout harness to stage that runtime sibling
  too.
- `sqlite-backend.ts` now also delegates run-state immutability, turn-span,
  active-head, consumed-staged-result decoding, and state-level run lineage
  helpers into `sqlite-run-invariants.ts`, again with the same narrow
  `backend-sqlite` typecheck and test lanes still green after extending the
  dist-layout harness to stage that runtime sibling too.
- `sqlite-backend.ts` now also delegates database-backed lineage metadata,
  branch-rollback/archive checks, turn-parent validation, run-span DB checks,
  and turn-node relationship traversal into `sqlite-db-lineage.ts`, again with
  the same narrow `backend-sqlite` typecheck and test lanes still green after
  extending the dist-layout harness to stage that runtime sibling too.
- `runtime-kernel.ts` now delegates the broad lineage/recovery/tree-checkpoint
  helper family into `runtime-kernel-lineage.ts` and the storage/codec/record
  helper family into `runtime-kernel-storage.ts`, bringing the public kernel
  facade down to roughly `1056` lines while the same narrow `kernel-runtime`
  typecheck and test lanes stay green.
- `runtime-kernel.ts` now also delegates the full run and run-liveness
  execution family into `runtime-kernel-runs.ts`, bringing the public kernel
  facade down further to roughly `645` lines while the same narrow
  `kernel-runtime` typecheck and test lanes stay green.
- `memory-backend.ts` now delegates low-level record/clone/equality helpers
  into `memory-backend-record-utils.ts`, turn-tree/path normalization into
  `memory-backend-turn-tree.ts`, lineage/run-span traversal into
  `memory-backend-lineage.ts`, run update constraints into
  `memory-backend-run-logic.ts`, and committed-state invariant validation into
  `memory-backend-state.ts`, bringing the public memory backend facade down to
  roughly `857` lines while the same narrow `backend-memory` typecheck and
  test lanes stay green.
- `kernel-validation.ts` now delegates generic validation primitives into
  `kernel-validation-shared.ts` and keeps the public facade itself thin at
  roughly `96` lines, while the broader logical and stored validator families
  live in `kernel-validation-runtime.ts` and `kernel-validation-stored.ts`;
  the same narrow `kernel-contract-protocol` typecheck and test lanes stay
  green after the split.
- `kernel-validation-runtime.ts` now also delegates the turn/run/staged-result/
  recovery record-validation family into `kernel-validation-records.ts`,
  bringing the remaining runtime validator down to roughly `656` lines while
  the same narrow `kernel-contract-protocol` typecheck and test lanes stay
  green across `60` passing tests.
- `runtime-core.test.ts` no longer exists as a live monolith; the remaining
  oversized runtime-core test hotspots are now `approval`, `tooling`,
  `orchestration`, `recovery`, `lifecycle`, and `hooks`.
- `runtime-api.test.ts` now delegates the approval request/response family into
  `runtime-api.approval.test.ts`, bringing the remaining runtime-api monolith
  down to roughly `1864` lines while the same narrow `framework-runtime-api`
  typecheck and test lanes stay green across two files.
- `runtime-api.test.ts` now also delegates the tool-definition contract family
  into `runtime-api.tool-definition.test.ts`, bringing the remaining
  runtime-api monolith down to roughly `1355` lines while the same narrow
  `framework-runtime-api` typecheck and test lanes stay green across three
  files.
- `runtime-api.test.ts` now also delegates the broad validation family into
  `runtime-api.validation.test.ts`, then further splits the execution-shape
  and manifest/status families into `runtime-api.execution-shape.test.ts` and
  `runtime-api.manifest-status.test.ts`, bringing the original runtime-api
  facade test file down to roughly `274` lines while the same narrow
  `framework-runtime-api` typecheck and test lanes stay green across six
  files with all `82` tests preserved.
- `runtime-contracts.ts` now also delegates the public contract shapes into
  `runtime-contract-shapes.ts` and the runtime validators/assertions into
  `runtime-contract-guards.ts`, bringing the public runtime-api contract
  facade down to roughly `140` lines while the same narrow
  `framework-runtime-api` typecheck and test lanes stay green across `82`
  passing tests.
- `runtime-kernel-grpc.ts` now also delegates the proto decode/encode layer,
  transport response shaping, and record conversion helpers into
  `runtime-kernel-grpc-codec.ts`, bringing the public gRPC runtime-kernel
  facade down to roughly `579` lines while the same narrow
  `framework-runtime-core` typecheck and test lanes stay green across `198`
  passing tests.
- `kernel-identity.ts` now also delegates the deterministic CBOR
  canonicalization, decode, and raw hash machinery into
  `kernel-record-identity.ts`, bringing the turn-node / turn-tree identity
  module down under the ceiling while the same narrow
  `kernel-contract-protocol` typecheck and test lanes stay green across `60`
  passing tests.
- `host.ts` in the kernel TypeScript conformance adapter now also delegates
  backend setup, canonical schema loading, restart-phase subprocess handling,
  and fixture parsing utilities into `host-support.ts`, bringing the adapter
  host itself back under the ceiling while the same
  `kernel-typescript-conformance-adapter` build and
  `kernel-typescript-conformance-runner` test lanes stay green.
- `kernel-validation-stored.ts` now also delegates the stored object/schema/
  turn-tree/path validation family into
  `kernel-validation-stored-turn-tree.ts`, bringing the remaining stored
  run/turn/branch/staged-result validator file back under the ceiling while
  the same narrow `kernel-contract-protocol` typecheck and test lanes stay
  green across `60` passing tests.
- `runtime-kernel.test.ts` no longer exists as a live monolith; the runtime
  kernel test lane is now split across `runtime-kernel.foundation.test.ts`,
  `runtime-kernel-run-liveness.test.ts`, `runtime-kernel-rollback.test.ts`,
  `runtime-kernel-turn-lineage.test.ts`, and `runtime-kernel-test-helpers.ts`,
  bringing the runtime-kernel test entrypoint itself down to a tiny suite
  registration file while the same narrow `kernel-runtime` typecheck and test
  lanes stay green across `29` passing tests.
- `playground-scenarios.ts` now also delegates report construction, telemetry
  shaping, provider/plan setup, projection capture, metadata evidence, and
  steering wait utilities into `playground-scenarios-support.ts`, bringing
  the host playground scenario facade back under the ceiling while the same
  `host-playground` typecheck and test lanes stay green across `41` passing
  tests. The same pass also removed two Bun typecheck-only `.resolves` matcher
  usages in `playground.test.ts` so the package-local typecheck lane is fully
  green again.
- `backend-memory.test.ts` has now been split into package-local families:
  `backend-memory.run-lineage.test.ts`,
  `backend-memory.run-status.test.ts`,
  `backend-memory.turn-parenting.test.ts`,
  `backend-memory.rollback.test.ts`, and
  `backend-memory.chunked-paths.test.ts`, with the small shared helper in
  `backend-memory-test-helpers.ts`. That brings the original monolith down
  under the ceiling while the same `backend-memory` typecheck and test lanes
  stay green across `58` passing tests.
- `orchestration-runtime.test.ts` has now been split into package-local
  families:
  `orchestration-runtime.child-lifecycle.test.ts`,
  `orchestration-runtime.approval.test.ts`, and the remaining
  `orchestration-runtime.test.ts`, with shared driver-wrapping helpers in
  `orchestration-runtime-driver-helpers.ts`. That brings the original
  orchestration runtime monolith down under the ceiling while the same
  `framework-runtime-core` typecheck and test lanes stay green across `198`
  passing tests.
- `backend-sqlite.test.ts` has now been split into package-local families:
  `backend-sqlite.startup.test.ts`,
  `backend-sqlite.invariants.test.ts`, and
  `backend-sqlite.record-validation.test.ts`, with shared SQLite fixture and
  dist-layout support in `backend-sqlite-test-helpers.ts`. The Nx test target
  now runs the full compiled test folder again, so the same `backend-sqlite`
  typecheck and test lanes stay green across `70` passing tests while the
  original monolith is reduced to the suite-registration entrypoint.
- `backend-invariant-suite.ts` now delegates its shared kernel invariant
  families into `backend-invariant-suite-foundation.ts`,
  `backend-invariant-suite-run-state.ts`,
  `backend-invariant-suite-turns.ts`, and
  `backend-invariant-suite-archive.ts`, bringing the public registration
  facade down to roughly `32` lines while the same `kernel-testkit`
  typecheck, build, and exports-smoke lanes stay green and the moved shared
  invariant suite still executes through the `backend-memory:test` lane with
  `58` passing tests.
- `playground.test.ts` now delegates the aimock single-provider scenario
  family into `playground.aimock-openai.test.ts`, the cross-provider aimock
  matrix family into `playground.aimock-matrix.test.ts`, and the shared
  request/fixture/environment helpers into `playground-test-helpers.ts`,
  bringing the remaining main playground suite down to roughly `502` lines
  while the same `host-playground` typecheck and test lanes stay green across
  `41` passing tests in three files.
- `kernel-contract-protocol.test.ts` now delegates its top-level describe
  families into `kernel-contract-deterministic.test.ts`,
  `kernel-contract-schema.test.ts`,
  `kernel-contract-logical.test.ts`, and
  `kernel-contract-stored.test.ts`, with the tiny shared prototype restore
  helper in `kernel-contract-test-helpers.ts`. That brings the original
  monolith down to roughly `23` lines while the same
  `kernel-contract-protocol` typecheck and test lanes stay green across `61`
  passing tests in six files.
- `driver-contracts.ts` now also delegates the public driver contract shapes
  into `driver-contract-shapes.ts` and the structural driver
  validators/assertions into `driver-contract-guards.ts`, bringing the public
  driver-api contract facade down to roughly `37` lines while the same narrow
  `framework-driver-api` typecheck, test, and exports-smoke lanes stay green
  across `20` tests plus `1` package-exports smoke test.
- `react-driver.test.ts` now delegates the contiguous runtime-core and
  end-to-end integration tail into `react-driver.integration.test.ts`, while
  shared driver test scaffolding now lives in
  `react-driver-test-helpers.ts`. That brings the remaining driver test
  monolith down to roughly `2860` lines while the same narrow
  `framework-driver-react` typecheck and test lanes stay green across two test
  files.
- `react-driver.test.ts` now also delegates the contiguous `aroundModel`
  behavior family into `react-driver-around-model.test.ts`, bringing the
  remaining driver test monolith down to roughly `2160` lines while the same
  narrow `framework-driver-react` typecheck and test lanes stay green across
  three test files.
- `react-driver.test.ts` now also delegates the streamed provider failure,
  invalid chunk, and cancellation family into
  `react-driver-stream-failures.test.ts`, bringing the remaining driver test
  monolith down to roughly `1595` lines while the same narrow
  `framework-driver-react` typecheck and test lanes stay green across four
  test files.
- `react-driver.test.ts` now also delegates the structured-output and provider
  validation family into `react-driver-structured-output.test.ts`, bringing the
  remaining driver test monolith down to roughly `1184` lines while the same
  narrow `framework-driver-react` typecheck and test lanes stay green across
  five test files.
- `react-driver.test.ts` now also delegates the streamed tool-call,
  reasoning/structured mapping, and stream-completion validation family into
  `react-driver-stream-mapping.test.ts`, bringing the remaining driver test
  monolith down to roughly `714` lines while the same narrow
  `framework-driver-react` typecheck and test lanes stay green across six
  test files.
- `react-driver.integration.test.ts` now also delegates the end-to-end
  `aroundModel` runtime-core family into
  `react-driver-around-model.integration.test.ts` and the streamed
  tool-call/provider-fanout runtime family into
  `react-driver-stream-runtime.integration.test.ts`, bringing the remaining
  integration suite down to roughly `868` lines while the same narrow
  `framework-driver-react` typecheck and test lanes stay green across eight
  test files and the same `73` passing tests.
- `react-driver.ts` now also delegates the around-model wrapper pipeline,
  replay durability checks, and assistant-event reconciliation family into
  `react-driver-around-model.ts`, while `react-driver-stream.ts` now also
  delegates stream accumulation, partial completion synthesis, and
  cancellation/abort helpers into `react-driver-stream-support.ts`, bringing
  both production files back under the ceiling while the same narrow
  `framework-driver-react` typecheck and test lanes stay green across `73`
  passing tests.
- `ai-sdk-provider-bridge.test.ts` now delegates the ProviderV3 lookup,
  runtime-core integration, and canonical assistant-history preservation family
  into `ai-sdk-provider-bridge-runtime.test.ts`, while shared AI SDK bridge test
  scaffolding now lives in `ai-sdk-provider-bridge-test-helpers.ts`. That
  brings the remaining bridge test monolith down to roughly `2205` lines while
  the same narrow `providers-bridge-ai-sdk` typecheck and test lanes stay green
  across two test files.
- `ai-sdk-provider-bridge.test.ts` now also delegates the baseline rejection
  and streamed tool-input validation family into
  `ai-sdk-provider-bridge-rejections.test.ts`, bringing the remaining bridge
  test monolith down to roughly `1718` lines while the same narrow
  `providers-bridge-ai-sdk` typecheck and test lanes stay green across three
  test files.
- `ai-sdk-provider-bridge.test.ts` now also delegates the tool-call and
  structured-output normalization family into
  `ai-sdk-provider-bridge-tool-calls.test.ts`, bringing the remaining bridge
  test monolith down to roughly `1033` lines while the same narrow
  `providers-bridge-ai-sdk` typecheck and test lanes stay green across four
  test files.
- `ai-sdk-provider-bridge.test.ts` now also delegates the assistant-history
  metadata and reasoning/tool-signature replay family into
  `ai-sdk-provider-bridge-history.test.ts`, bringing the remaining bridge test
  monolith down to roughly `583` lines while the same narrow
  `providers-bridge-ai-sdk` typecheck and test lanes stay green across five
  test files.
- `sqlite-backend.ts`, `runtime-core.ts`, and a few remaining large extracted
  helper modules still sit above the repository's preferred modularity window.

## Extraction Map

### Provider bridge first slice

- Source responsibility:
  - `ai-sdk-provider-bridge.ts` should keep the public factory surface and the
    bridge class.
  - low-level metadata, cloning, JSON parsing, and bridge error utilities move
    into a shared internal utility module.
  - stream-part mapping and tool-call correlation move into a dedicated stream
    module so streaming behavior can be audited without reading prompt and
    generate mapping code.
- Target files:
  - `boundaries/providers/implementations/typescript/bridge-ai-sdk/src/lib/ai-sdk-provider-bridge.ts`
  - `boundaries/providers/implementations/typescript/bridge-ai-sdk/src/lib/ai-sdk-provider-bridge-utils.ts`
  - `boundaries/providers/implementations/typescript/bridge-ai-sdk/src/lib/ai-sdk-provider-bridge-stream.ts`
- Dependency direction:
  - bridge class -> bridge utility module
  - bridge class -> bridge stream module
  - stream module -> bridge utility module
  - utility module -> no dependency on bridge class internals
- Exported seams:
  - `createAiSdkProviderBridge`
  - `createAiSdkProviderBridgeFromProvider`
  - bridge error and clone helpers stay internal to the implementation subtree

### Provider bridge test decomposition

- Source responsibility:
  - `ai-sdk-provider-bridge.test.ts` should shrink by scenario family so it no
    longer carries prompt mapping, stream mapping, rejection coverage, runtime
    integration, and durable-history preservation all in one place.
  - the ProviderV3 lookup and runtime-core-backed integration family should move
    into a dedicated runtime-focused test file.
  - shared mock-model, usage, stream, and async-collection helpers should live
    in a package-local helper module rather than being duplicated across split
    test files.
- Target files:
  - `boundaries/providers/implementations/typescript/bridge-ai-sdk/test/ai-sdk-provider-bridge.test.ts`
  - `boundaries/providers/implementations/typescript/bridge-ai-sdk/test/ai-sdk-provider-bridge-runtime.test.ts`
  - `boundaries/providers/implementations/typescript/bridge-ai-sdk/test/ai-sdk-provider-bridge-rejections.test.ts`
  - `boundaries/providers/implementations/typescript/bridge-ai-sdk/test/ai-sdk-provider-bridge-tool-calls.test.ts`
  - `boundaries/providers/implementations/typescript/bridge-ai-sdk/test/ai-sdk-provider-bridge-history.test.ts`
  - `boundaries/providers/implementations/typescript/bridge-ai-sdk/test/ai-sdk-provider-bridge-test-helpers.ts`
- Dependency direction:
  - test files -> package-local helper module
  - runtime-focused test file -> shared runtime-core fake-kernel helpers only
  - helper module -> no dependency on individual test files
- Classification:
  - behavior-preserving extraction
- Classification:
  - behavior-preserving extraction
- Why this slice first:
  - it is the most isolated helper cluster in the current provider bridge
  - it reduces duplication risk before the prompt and generate maps are split
    into separate modules
  - it is scheduled later in the ticket sequence, after the runtime-core and
    SQLite-facade work that AE depends on
- Current landing status:
  - completed for the utility, stream-helper, prompt-projection, and
    generate-result sub-slices
  - the remaining facade is now below the `1000`-line hard threshold
  - follow-up still remains if future provider-specific clusters need their own
    implementation modules, but the first AE bridge split is now materially
    complete

### Runtime core facade and execution extraction

- Source responsibility:
  - `runtime-core.ts` should become a thin public facade over execution,
    orchestration, recovery, and observability modules.
- Target files:
  - `boundaries/framework/implementations/typescript/runtime-core/src/lib/runtime-core.ts`
  - `boundaries/framework/implementations/typescript/runtime-core/src/lib/runtime-execution-*.ts`
  - `boundaries/framework/implementations/typescript/runtime-core/src/lib/runtime-orchestration-*.ts`
- Dependency direction:
  - public facade -> execution/orchestration helpers
  - helper modules -> shared primitives only
- Exported seams:
  - `createTuvrenRuntimeCore`
  - `RuntimeCoreOptions`
  - `RuntimeWarning`
  - `RuntimeRunLivenessOptions`
- Classification:
  - behavior-preserving extraction
- Circular dependency risks:
  - the facade must not import back from the execution or orchestration modules
    once they are split
  - helpers that need runtime state should depend on narrow interfaces, not the
    concrete class, to avoid import cycles during partial extraction

### SQLite backend repository split

- Source responsibility:
  - `sqlite-backend.ts` should hand off schema validation, row decoding, write
    tracking, and repository CRUD to narrower modules.
- Target files:
  - `boundaries/kernel/implementations/typescript/backend-sqlite/src/lib/sqlite-backend.ts`
  - `boundaries/kernel/implementations/typescript/backend-sqlite/src/lib/sqlite-repositories.ts`
  - `boundaries/kernel/implementations/typescript/backend-sqlite/src/lib/sqlite-schema.ts`
  - `boundaries/kernel/implementations/typescript/backend-sqlite/src/lib/sqlite-validation.ts`
  - `boundaries/kernel/implementations/typescript/backend-sqlite/src/lib/sqlite-records.ts`
  - `boundaries/kernel/implementations/typescript/backend-sqlite/src/lib/sqlite-lookups.ts`
  - `boundaries/kernel/implementations/typescript/backend-sqlite/src/lib/sqlite-write-tracker.ts`
  - `boundaries/kernel/implementations/typescript/backend-sqlite/src/lib/sqlite-repositories-support.ts`
  - `boundaries/kernel/implementations/typescript/backend-sqlite/src/lib/sqlite-repositories-core.ts`
  - `boundaries/kernel/implementations/typescript/backend-sqlite/src/lib/sqlite-state-utils.ts`
  - `boundaries/kernel/implementations/typescript/backend-sqlite/src/lib/sqlite-state-validation.ts`
  - `boundaries/kernel/implementations/typescript/backend-sqlite/src/lib/sqlite-run-invariants.ts`
  - `boundaries/kernel/implementations/typescript/backend-sqlite/src/lib/sqlite-db-lineage.ts`
  - `boundaries/kernel/implementations/typescript/backend-sqlite/src/lib/sqlite-errors.ts`
- Dependency direction:
  - backend facade -> repository and validation modules
  - repository modules -> persisted schema helpers only
- Exported seams:
  - `createSqliteBackend`
- Classification:
  - behavior-preserving extraction
- Circular dependency risks:
  - row decoders and repository modules must not reach back into the facade for
    transaction control
  - validation helpers should stay data-only so schema logic remains acyclic

### Memory backend split

- Source responsibility:
  - `memory-backend.ts` should keep the transaction facade and repository
    orchestration only.
  - low-level record/clone/equality helpers move into a record-utils module.
  - turn-tree path normalization, manifest resolution, and state cloning move
    into a turn-tree helper module.
  - lineage traversal, turn-parent validation, and run-span reasoning move
    into a lineage helper module.
  - committed-state validation and invariant sweeps move into a state helper
    module, with focused run update rules in a run-logic helper.
- Target files:
  - `boundaries/kernel/implementations/typescript/backend-memory/src/lib/memory-backend.ts`
  - `boundaries/kernel/implementations/typescript/backend-memory/src/lib/memory-backend-types.ts`
  - `boundaries/kernel/implementations/typescript/backend-memory/src/lib/memory-backend-record-utils.ts`
  - `boundaries/kernel/implementations/typescript/backend-memory/src/lib/memory-backend-turn-tree.ts`
  - `boundaries/kernel/implementations/typescript/backend-memory/src/lib/memory-backend-lineage.ts`
  - `boundaries/kernel/implementations/typescript/backend-memory/src/lib/memory-backend-run-logic.ts`
  - `boundaries/kernel/implementations/typescript/backend-memory/src/lib/memory-backend-state.ts`
- Dependency direction:
  - facade -> record-utils / turn-tree / lineage / run-logic / state helpers
  - state helper -> lineage / turn-tree / record-utils
  - lineage and turn-tree helpers -> record-utils only
- Exported seams:
  - `createMemoryBackend`
  - `MemoryBackendOptions`
- Classification:
  - behavior-preserving extraction
- Circular dependency risks:
  - the record-utils module must remain a leaf so lineage and state checks do
    not form cycles through cloning/equality helpers
  - committed-state validation must not import the facade back, or transaction
    orchestration and invariant sweeps will tangle again

### Kernel protocol validation split

- Source responsibility:
  - `kernel-validation.ts` should keep the public validator surface only.
  - generic plain-object / array / CBOR / primitive validation helpers move
    into a shared internal helper module.
  - logical runtime-shape validation remains grouped in a dedicated runtime
    validator module.
  - stored-record and identity validation remains grouped in a dedicated
    stored validator module.
- Target files:
  - `boundaries/kernel/contracts/protocol/implementations/typescript/src/lib/kernel-validation.ts`
  - `boundaries/kernel/contracts/protocol/implementations/typescript/src/lib/kernel-validation-shared.ts`
  - `boundaries/kernel/contracts/protocol/implementations/typescript/src/lib/kernel-validation-runtime.ts`
  - `boundaries/kernel/contracts/protocol/implementations/typescript/src/lib/kernel-validation-stored.ts`
- Dependency direction:
  - public facade -> runtime validator / stored validator
  - runtime validator -> shared validator helpers
  - stored validator -> runtime validator and shared validator helpers
- Exported seams:
  - all public `assert*` / `is*` validation helpers already exposed through the
    protocol package entrypoint
- Classification:
  - behavior-preserving extraction
- Circular dependency risks:
  - the shared validator helper module must remain a leaf so plain-object and
    CBOR helpers do not start depending back on higher-level contract shapes
  - stored validators may depend on runtime validators, but runtime validators
    must not depend on stored validators or the public facade will tangle again

### Runtime-kernel facade split

- Source responsibility:
  - `runtime-kernel.ts` should keep the public runtime-kernel facade and
    transactional orchestration only.
  - lineage walking, head-movement classification, recovery/tree checkpoint
    logic, and observe-result validation move into a dedicated lineage module.
  - object persistence, schema/record decoding, ID guards, and record-shaping
    helpers move into a dedicated storage module.
- Target files:
  - `boundaries/kernel/implementations/typescript/runtime-kernel/src/lib/runtime-kernel.ts`
  - `boundaries/kernel/implementations/typescript/runtime-kernel/src/lib/runtime-kernel-lineage.ts`
  - `boundaries/kernel/implementations/typescript/runtime-kernel/src/lib/runtime-kernel-storage.ts`
- Dependency direction:
  - facade -> lineage module
  - facade -> storage module
  - lineage module -> storage module only for low-level record and lookup
    helpers
- Exported seams:
  - `createRuntimeKernel`
  - `RuntimeKernelOptions`
- Classification:
  - behavior-preserving extraction
- Circular dependency risks:
  - the storage module must not import facade orchestration helpers back from
    `runtime-kernel.ts`
  - lineage helpers should depend on storage primitives, not the facade, so
    walk/recovery logic remains acyclic during further extraction

### Framework adapter split

- Source responsibility:
  - `framework-adapter.ts` should keep the conformance adapter facade and
    dispatch table only.
  - operation families move into scenario modules so the adapter cannot grow
    into a hidden semantic runner.
- Target files:
  - `boundaries/framework/implementations/typescript/conformance-adapter/src/framework-adapter.ts`
  - `boundaries/framework/implementations/typescript/conformance-adapter/src/framework-adapter-runtime.ts`
  - `boundaries/framework/implementations/typescript/conformance-adapter/src/framework-adapter-driver.ts`
  - `boundaries/framework/implementations/typescript/conformance-adapter/src/framework-adapter-event-stream.ts`
  - `boundaries/framework/implementations/typescript/conformance-adapter/src/framework-adapter-orchestration.ts`
- Dependency direction:
  - facade -> scenario modules
  - scenario modules -> shared helper module only
- Exported seams:
  - `TypeScriptFrameworkAdapter`
  - `ImplementationAdapter`
- Classification:
  - behavior-preserving extraction
- Circular dependency risks:
  - scenario modules must not import the conformance runner or expected-value
    tables, or they will become semantic authorities by accident
  - the facade should stay on the dispatch edge only and never re-import a
    scenario module that depends on the facade

### Runtime-core test decomposition

- Source responsibility:
  - `runtime-core.test.ts` should be split by scenario family so a single file
    no longer carries the whole lifecycle surface.
- Target files:
  - `boundaries/framework/implementations/typescript/runtime-core/test/runtime-core.lifecycle.test.ts`
  - `boundaries/framework/implementations/typescript/runtime-core/test/runtime-core.approval.test.ts`
  - `boundaries/framework/implementations/typescript/runtime-core/test/runtime-core.approval-decisions.test.ts`
  - `boundaries/framework/implementations/typescript/runtime-core/test/runtime-core.malformed-approval.test.ts`
  - `boundaries/framework/implementations/typescript/runtime-core/test/runtime-core.tool-failures.test.ts`
  - `boundaries/framework/implementations/typescript/runtime-core/test/runtime-core.around-tool-approval.test.ts`
  - `boundaries/framework/implementations/typescript/runtime-core/test/runtime-core.approval-basics.test.ts`
  - `boundaries/framework/implementations/typescript/runtime-core/test/runtime-core.approval-lifecycle.test.ts`
  - `boundaries/framework/implementations/typescript/runtime-core/test/runtime-core.approval-resume.test.ts`
  - `boundaries/framework/implementations/typescript/runtime-core/test/runtime-core.steering.test.ts`
  - `boundaries/framework/implementations/typescript/runtime-core/test/runtime-core.handoff-builders.test.ts`
  - `boundaries/framework/implementations/typescript/runtime-core/test/runtime-core.tooling.test.ts`
  - `boundaries/framework/implementations/typescript/runtime-core/test/runtime-core.orchestration.test.ts`
  - `boundaries/framework/implementations/typescript/runtime-core/test/runtime-core.recovery.test.ts`
  - `boundaries/framework/implementations/typescript/runtime-core/test/runtime-core.stale-step-recovery.test.ts`
  - `boundaries/framework/implementations/typescript/runtime-core/test/runtime-core.after-iteration.test.ts`
  - `boundaries/framework/implementations/typescript/runtime-core/test/runtime-core.stream-synthesis.test.ts`
  - `boundaries/framework/implementations/typescript/runtime-core/test/runtime-core.parallel-batching.test.ts`
  - `boundaries/framework/implementations/typescript/runtime-core/test/runtime-core.turn-linking.test.ts`
  - `boundaries/framework/implementations/typescript/runtime-core/test/runtime-core.handoff-driver.test.ts`
  - `boundaries/framework/implementations/typescript/runtime-core/test/runtime-core.branching.test.ts`
  - `boundaries/framework/implementations/typescript/runtime-core/test/runtime-core.context-engineering.test.ts`
  - `boundaries/framework/implementations/typescript/runtime-core/test/runtime-core.bootstrap.test.ts`
  - `boundaries/framework/implementations/typescript/runtime-core/test/runtime-core.assistant-stream.test.ts`
  - `boundaries/framework/implementations/typescript/runtime-core/test/runtime-core.driver-boundary.test.ts`
  - `boundaries/framework/implementations/typescript/runtime-core/test/runtime-core.stream-validation.test.ts`
  - `boundaries/framework/implementations/typescript/runtime-core/test/runtime-core.reasoning-stream.test.ts`
  - `boundaries/framework/implementations/typescript/runtime-core/test/runtime-core.foundation.test.ts`
  - `boundaries/framework/implementations/typescript/runtime-core/test/runtime-core.execution-lifecycle.test.ts`
  - `boundaries/framework/implementations/typescript/runtime-core/test/runtime-core.tool-batching.test.ts`
- Dependency direction:
  - tests -> shared test helpers only
- Classification:
  - behavior-preserving extraction
- Circular dependency risks:
  - shared helpers must remain in a leaf module so individual test files do not
    re-import one another
  - tests should not depend on package entrypoints that re-export the same test
    helpers, or file-level cycles will hide the intended scenario boundaries

### Runtime API test decomposition

- Source responsibility:
  - `runtime-api.test.ts` should shrink by scenario family so it no longer
    carries provider, approval, manifest, stream-event, message, and
    host-surface checks all in one place.
- Target files:
  - `boundaries/framework/contracts/runtime-api/implementations/typescript/test/runtime-api.test.ts`
  - `boundaries/framework/contracts/runtime-api/implementations/typescript/test/runtime-api.approval.test.ts`
  - `boundaries/framework/contracts/runtime-api/implementations/typescript/test/runtime-api.tool-definition.test.ts`
  - follow-up slices still remain for manifest and stream-event families
- Dependency direction:
  - tests -> shared fixtures only
- Classification:
  - behavior-preserving extraction

### React driver test decomposition

- Source responsibility:
  - `react-driver.test.ts` should keep the driver-local prompt, loop-policy,
    streaming, validation, and aroundModel unit coverage.
  - the runtime-core, adapter fanout, and end-to-end execution tail should move
    into a dedicated integration-focused test file.
  - shared scaffolding for driver contexts, test tool definitions, and async
    stream collection should live in a package-local helper module rather than
    being duplicated across split test files.
- Target files:
  - `boundaries/framework/implementations/typescript/drivers/react/test/react-driver.test.ts`
  - `boundaries/framework/implementations/typescript/drivers/react/test/react-driver.integration.test.ts`
  - `boundaries/framework/implementations/typescript/drivers/react/test/react-driver-around-model.test.ts`
  - `boundaries/framework/implementations/typescript/drivers/react/test/react-driver-stream-failures.test.ts`
  - `boundaries/framework/implementations/typescript/drivers/react/test/react-driver-structured-output.test.ts`
  - `boundaries/framework/implementations/typescript/drivers/react/test/react-driver-stream-mapping.test.ts`
  - `boundaries/framework/implementations/typescript/drivers/react/test/react-driver-test-helpers.ts`
- Dependency direction:
  - test files -> package-local helper module
  - test files -> shared runtime-core fake-kernel helpers only
  - helper module -> no dependency on individual test files
- Classification:
  - behavior-preserving extraction
- Circular dependency risks:
  - split test files should not start importing one another; keep shared setup
    in fixtures or helper modules only

### Provider bridge test decomposition

- Source responsibility:
  - `ai-sdk-provider-bridge.test.ts` should split into generation, streaming,
    metadata-replay, negative-path, and integration families.
- Target files:
  - `boundaries/providers/implementations/typescript/bridge-ai-sdk/test/ai-sdk-provider-bridge.generate.test.ts`
  - `boundaries/providers/implementations/typescript/bridge-ai-sdk/test/ai-sdk-provider-bridge.stream.test.ts`
  - `boundaries/providers/implementations/typescript/bridge-ai-sdk/test/ai-sdk-provider-bridge.replay.test.ts`
  - `boundaries/providers/implementations/typescript/bridge-ai-sdk/test/ai-sdk-provider-bridge.validation.test.ts`
  - `boundaries/providers/implementations/typescript/bridge-ai-sdk/test/ai-sdk-provider-bridge.integration.test.ts`
- Dependency direction:
  - tests -> shared provider bridge test helpers only
- Classification:
  - behavior-preserving extraction
- Circular dependency risks:
  - fixture helpers must stay separate from the generated test families so the
    family files do not form a cycle through shared setup
  - provider bridge tests should only import the bridge public surface and test
    helpers, never other test families

## File-Size Policy

- Soft target:
  - keep active TypeScript implementation files below roughly 800 lines.
- Hard review threshold:
  - treat 1000 lines as the point where a file must either be split or be
    explicitly listed in a temporary allowlist with a reviewable reason.
- Temporary allowlist posture:
  - generated artifacts remain exempt when they are owned by code generation
    or compatibility evidence regeneration
  - the remaining oversized implementation and test files listed above are the
    current candidate allowlist entries until their extraction tickets land
- Review rule:
  - if a file stays above the hard threshold after the next refactor slice, the
    follow-up ticket must name the specific seam that will absorb it

## Current Measured Hotspots

- `boundaries/framework/implementations/typescript/runtime-core/src/lib/runtime-core.ts`
  currently measures about `950` lines.
- `boundaries/framework/implementations/typescript/runtime-core/src/lib/runtime-core-assistant-validation.ts`
  currently measures about `623` lines.
- `boundaries/framework/implementations/typescript/runtime-core/src/lib/runtime-core-assistant-validation-sequences.ts`
  currently measures about `620` lines.
- `boundaries/framework/implementations/typescript/runtime-core/src/lib/runtime-core-facade-execution.ts`
  currently measures about `554` lines.
- `boundaries/framework/implementations/typescript/runtime-core/src/lib/runtime-core-execution-session.ts`
  currently measures about `334` lines.
- `boundaries/framework/implementations/typescript/runtime-core/src/lib/runtime-core-execution-orchestration.ts`
  currently measures about `639` lines.
- `boundaries/framework/implementations/typescript/runtime-core/src/lib/runtime-core-runtime-lifecycle.ts`
  currently measures about `204` lines.
- `boundaries/framework/implementations/typescript/runtime-core/src/lib/runtime-core-transition-support.ts`
  currently measures about `142` lines.
- `boundaries/framework/implementations/typescript/runtime-core/src/lib/runtime-core-facade-adapters.ts`
  currently measures about `77` lines.
- `boundaries/framework/implementations/typescript/runtime-core/src/lib/runtime-kernel-grpc.ts`
  currently measures about `579` lines.
- `boundaries/framework/implementations/typescript/runtime-core/src/lib/runtime-kernel-grpc-codec.ts`
  currently measures about `967` lines.
- `boundaries/framework/implementations/typescript/runtime-core/src/lib/orchestration-runtime.ts`
  currently measures about `279` lines.
- `boundaries/framework/implementations/typescript/runtime-core/src/lib/orchestration-runtime-node.ts`
  currently measures about `953` lines.
- `boundaries/kernel/contracts/protocol/implementations/typescript/src/lib/kernel-identity.ts`
  currently measures about `799` lines.
- `boundaries/kernel/contracts/protocol/implementations/typescript/src/lib/kernel-record-identity.ts`
  currently measures about `364` lines.
- `boundaries/kernel/implementations/typescript/conformance-adapter/src/host.ts`
  currently measures about `764` lines.
- `boundaries/kernel/implementations/typescript/conformance-adapter/src/host-support.ts`
  currently measures about `330` lines.
- `boundaries/kernel/contracts/protocol/implementations/typescript/src/lib/kernel-validation-stored.ts`
  currently measures about `660` lines.
- `boundaries/kernel/contracts/protocol/implementations/typescript/src/lib/kernel-validation-stored-turn-tree.ts`
  currently measures about `697` lines.
- `boundaries/hosts/implementations/typescript/playground/src/lib/playground-scenarios.ts`
  currently measures about `505` lines.
- `boundaries/hosts/implementations/typescript/playground/src/lib/playground-scenarios-support.ts`
  currently measures about `854` lines.
- `boundaries/kernel/implementations/typescript/backend-memory/test/backend-memory.test.ts`
  currently measures about `491` lines.
- `boundaries/kernel/implementations/typescript/backend-memory/test/backend-memory.run-lineage.test.ts`
  currently measures about `642` lines.
- `boundaries/kernel/implementations/typescript/backend-memory/test/backend-memory.run-status.test.ts`
  currently measures about `609` lines.
- `boundaries/kernel/implementations/typescript/backend-memory/test/backend-memory.turn-parenting.test.ts`
  currently measures about `586` lines.
- `boundaries/kernel/implementations/typescript/backend-memory/test/backend-memory.rollback.test.ts`
  currently measures about `762` lines.
- `boundaries/kernel/implementations/typescript/backend-memory/test/backend-memory.chunked-paths.test.ts`
  currently measures about `290` lines.
- `boundaries/kernel/implementations/typescript/backend-sqlite/test/backend-sqlite.test.ts`
  currently measures about `41` lines.
- `boundaries/kernel/implementations/typescript/backend-sqlite/test/backend-sqlite.startup.test.ts`
  currently measures about `531` lines.
- `boundaries/kernel/implementations/typescript/backend-sqlite/test/backend-sqlite.invariants.test.ts`
  currently measures about `575` lines.
- `boundaries/kernel/implementations/typescript/backend-sqlite/test/backend-sqlite.record-validation.test.ts`
  currently measures about `266` lines.
- `boundaries/kernel/implementations/typescript/backend-sqlite/test/backend-sqlite-test-helpers.ts`
  currently measures about `435` lines.
- `boundaries/framework/implementations/typescript/drivers/react/test/react-driver.integration.test.ts`
  currently measures about `868` lines.
- `boundaries/framework/implementations/typescript/drivers/react/test/react-driver-around-model.integration.test.ts`
  currently measures about `527` lines.
- `boundaries/framework/implementations/typescript/drivers/react/test/react-driver-stream-runtime.integration.test.ts`
  currently measures about `427` lines.
- `boundaries/hosts/implementations/typescript/playground/test/playground.test.ts`
  currently measures about `502` lines.
- `boundaries/hosts/implementations/typescript/playground/test/playground.aimock-openai.test.ts`
  currently measures about `490` lines.
- `boundaries/hosts/implementations/typescript/playground/test/playground.aimock-matrix.test.ts`
  currently measures about `444` lines.
- `boundaries/hosts/implementations/typescript/playground/test/playground-test-helpers.ts`
  currently measures about `425` lines.
- `boundaries/kernel/contracts/protocol/implementations/typescript/test/kernel-contract-protocol.test.ts`
  currently measures about `23` lines.
- `boundaries/kernel/contracts/protocol/implementations/typescript/test/kernel-contract-deterministic.test.ts`
  currently measures about `494` lines.
- `boundaries/kernel/contracts/protocol/implementations/typescript/test/kernel-contract-schema.test.ts`
  currently measures about `245` lines.
- `boundaries/kernel/contracts/protocol/implementations/typescript/test/kernel-contract-logical.test.ts`
  currently measures about `470` lines.
- `boundaries/kernel/contracts/protocol/implementations/typescript/test/kernel-contract-stored.test.ts`
  currently measures about `465` lines.
- `boundaries/kernel/contracts/protocol/implementations/typescript/test/kernel-contract-test-helpers.ts`
  currently measures about `29` lines.
- `boundaries/kernel/implementations/typescript/testkit/src/lib/backend-invariant-suite.ts`
  currently measures about `32` lines.
- `boundaries/kernel/implementations/typescript/testkit/src/lib/backend-invariant-suite-foundation.ts`
  currently measures about `474` lines.
- `boundaries/kernel/implementations/typescript/testkit/src/lib/backend-invariant-suite-run-state.ts`
  currently measures about `590` lines.
- `boundaries/kernel/implementations/typescript/testkit/src/lib/backend-invariant-suite-turns.ts`
  currently measures about `492` lines.
- `boundaries/kernel/implementations/typescript/testkit/src/lib/backend-invariant-suite-archive.ts`
  currently measures about `201` lines.
- `boundaries/framework/implementations/typescript/runtime-core/test/orchestration-runtime.test.ts`
  currently measures about `840` lines.
- `boundaries/framework/implementations/typescript/runtime-core/test/orchestration-runtime.child-lifecycle.test.ts`
  currently measures about `809` lines.
- `boundaries/framework/implementations/typescript/runtime-core/test/orchestration-runtime.approval.test.ts`
  currently measures about `336` lines.
- `boundaries/framework/implementations/typescript/runtime-core/test/orchestration-runtime-driver-helpers.ts`
  currently measures about `232` lines.
- `boundaries/framework/contracts/runtime-api/implementations/typescript/test/runtime-api.test.ts`
  currently measures about `274` lines.
- `boundaries/framework/contracts/runtime-api/implementations/typescript/test/runtime-api.validation.test.ts`
  currently measures about `98` lines.
- `boundaries/framework/contracts/runtime-api/implementations/typescript/test/runtime-api.execution-shape.test.ts`
  currently measures about `445` lines.
- `boundaries/framework/contracts/runtime-api/implementations/typescript/test/runtime-api.manifest-status.test.ts`
  currently measures about `580` lines.
- `boundaries/framework/contracts/runtime-api/implementations/typescript/src/lib/runtime-contracts.ts`
  currently measures about `140` lines.
- `boundaries/framework/contracts/runtime-api/implementations/typescript/src/lib/runtime-contract-shapes.ts`
  currently measures about `836` lines.
- `boundaries/framework/contracts/runtime-api/implementations/typescript/src/lib/runtime-contract-guards.ts`
  currently measures about `756` lines.
- `boundaries/framework/contracts/driver-api/implementations/typescript/src/lib/driver-contracts.ts`
  currently measures about `37` lines.
- `boundaries/framework/contracts/driver-api/implementations/typescript/src/lib/driver-contract-shapes.ts`
  currently measures about `99` lines.
- `boundaries/framework/contracts/driver-api/implementations/typescript/src/lib/driver-contract-guards.ts`
  currently measures about `939` lines.
- `boundaries/framework/implementations/typescript/runtime-core/test/runtime-core.recovery.test.ts`
  currently measures about `988` lines.
- `boundaries/framework/implementations/typescript/runtime-core/test/runtime-core.approval.test.ts`
  currently measures about `553` lines.
- `boundaries/framework/implementations/typescript/runtime-core/test/runtime-core.approval-decisions.test.ts`
  currently measures about `889` lines.
- `boundaries/framework/implementations/typescript/runtime-core/test/runtime-core.malformed-approval.test.ts`
  currently measures about `926` lines.
- `boundaries/framework/implementations/typescript/runtime-core/test/runtime-core.tool-failures.test.ts`
  currently measures about `618` lines.
- `boundaries/framework/implementations/typescript/runtime-core/test/runtime-core.around-tool-approval.test.ts`
  currently measures about `809` lines.
- `boundaries/framework/implementations/typescript/runtime-core/test/runtime-core.approval-basics.test.ts`
  currently measures about `587` lines.
- `boundaries/framework/implementations/typescript/runtime-core/test/runtime-core.approval-lifecycle.test.ts`
  currently measures about `503` lines.
- `boundaries/framework/implementations/typescript/runtime-core/test/runtime-core.approval-resume.test.ts`
  currently measures about `814` lines.
- `boundaries/framework/implementations/typescript/runtime-core/test/runtime-core.orchestration.test.ts`
  currently measures about `549` lines.
- `boundaries/framework/implementations/typescript/runtime-core/test/runtime-core.handoff-driver.test.ts`
  currently measures about `509` lines.
- `boundaries/framework/implementations/typescript/runtime-core/test/runtime-core.steering.test.ts`
  currently measures about `355` lines.
- `boundaries/framework/implementations/typescript/runtime-core/test/runtime-core.handoff-builders.test.ts`
  currently measures about `683` lines.
- `boundaries/framework/implementations/typescript/runtime-core/test/runtime-core.stale-step-recovery.test.ts`
  currently measures about `544` lines.
- `boundaries/framework/implementations/typescript/runtime-core/test/runtime-core.tooling.test.ts`
  currently measures about `718` lines.
- `boundaries/framework/implementations/typescript/runtime-core/test/runtime-core.stream-synthesis.test.ts`
  currently measures about `357` lines.
- `boundaries/framework/implementations/typescript/runtime-core/test/runtime-core.tool-batching.test.ts`
  currently measures about `337` lines.
- `boundaries/framework/implementations/typescript/runtime-core/test/runtime-core.parallel-batching.test.ts`
  currently measures about `712` lines.
- `boundaries/framework/implementations/typescript/runtime-core/test/runtime-core.assistant-stream.test.ts`
  currently measures about `630` lines.
- `boundaries/framework/implementations/typescript/runtime-core/test/runtime-core.driver-boundary.test.ts`
  currently measures about `684` lines.
- `boundaries/framework/implementations/typescript/runtime-core/test/runtime-core.stream-validation.test.ts`
  currently measures about `902` lines.
- `boundaries/framework/implementations/typescript/runtime-core/test/runtime-core.reasoning-stream.test.ts`
  currently measures about `250` lines.
- `boundaries/framework/implementations/typescript/runtime-core/test/runtime-core.foundation.test.ts`
  currently measures about `527` lines.
- `boundaries/framework/implementations/typescript/runtime-core/test/runtime-core.execution-lifecycle.test.ts`
  currently measures about `355` lines.
- `boundaries/framework/implementations/typescript/runtime-core/test/runtime-core.lifecycle.test.ts`
  currently measures about `641` lines.
- `boundaries/framework/implementations/typescript/runtime-core/test/runtime-core.turn-linking.test.ts`
  currently measures about `367` lines.
- `boundaries/framework/implementations/typescript/runtime-core/test/runtime-core.hooks.test.ts`
  currently measures about `517` lines.
- `boundaries/framework/implementations/typescript/runtime-core/test/runtime-core.after-iteration.test.ts`
  currently measures about `564` lines.
- `boundaries/framework/implementations/typescript/runtime-core/test/runtime-core.context-engineering.test.ts`
  currently measures about `580` lines.
- `boundaries/framework/implementations/typescript/runtime-core/test/runtime-core.bootstrap.test.ts`
  currently measures about `215` lines.
- `boundaries/framework/implementations/typescript/runtime-core/src/lib/runtime-core-loop.ts`
  currently measures about `408` lines.
- `boundaries/framework/implementations/typescript/runtime-core/src/lib/runtime-core-facade-hosts.ts`
  currently measures about `625` lines.
- `boundaries/kernel/implementations/typescript/runtime-kernel/src/lib/runtime-kernel.ts`
  currently measures about `645` lines.
- `boundaries/kernel/implementations/typescript/runtime-kernel/src/lib/runtime-kernel-runs.ts`
  currently measures about `480` lines.
- `boundaries/kernel/implementations/typescript/runtime-kernel/test/runtime-kernel.test.ts`
  currently measures about `23` lines.
- `boundaries/kernel/implementations/typescript/runtime-kernel/test/runtime-kernel.foundation.test.ts`
  currently measures about `287` lines.
- `boundaries/kernel/implementations/typescript/runtime-kernel/test/runtime-kernel-run-liveness.test.ts`
  currently measures about `229` lines.
- `boundaries/kernel/implementations/typescript/runtime-kernel/test/runtime-kernel-rollback.test.ts`
  currently measures about `414` lines.
- `boundaries/kernel/implementations/typescript/runtime-kernel/test/runtime-kernel-turn-lineage.test.ts`
  currently measures about `154` lines.
- `boundaries/kernel/implementations/typescript/runtime-kernel/test/runtime-kernel-test-helpers.ts`
  currently measures about `65` lines.
- `boundaries/framework/implementations/typescript/runtime-core/src/lib/runtime-core-driver.ts`
  currently measures about `414` lines.
- `boundaries/framework/implementations/typescript/runtime-core/src/lib/runtime-core-tool-resume.ts`
  currently measures about `467` lines.
- `boundaries/framework/implementations/typescript/runtime-core/src/lib/runtime-core-context.ts`
  currently measures about `157` lines.
- `boundaries/framework/implementations/typescript/runtime-core/src/lib/runtime-core-context-ops.ts`
  currently measures about `412` lines.
- `boundaries/framework/implementations/typescript/runtime-core/src/lib/runtime-core-head-state.ts`
  currently measures about `356` lines.
- `boundaries/framework/implementations/typescript/runtime-core/src/lib/runtime-core-events.ts`
  currently measures about `322` lines.
- `boundaries/framework/implementations/typescript/runtime-core/src/lib/runtime-core-persistence.ts`
  currently measures about `195` lines.
- `boundaries/framework/implementations/typescript/runtime-core/src/lib/runtime-core-liveness.ts`
  currently measures about `307` lines.
- `boundaries/framework/implementations/typescript/runtime-core/src/lib/runtime-core-expired-recovery.ts`
  currently measures about `221` lines.
- `boundaries/framework/implementations/typescript/runtime-core/src/lib/runtime-core-turn-progress.ts`
  currently measures about `213` lines.
- `boundaries/framework/implementations/typescript/runtime-core/src/lib/runtime-core-finalization.ts`
  currently measures about `364` lines.
- `boundaries/framework/implementations/typescript/runtime-core/src/lib/runtime-core-startup.ts`
  currently measures about `400` lines.
- `boundaries/framework/implementations/typescript/runtime-core/src/lib/runtime-core-state-commit.ts`
  currently measures about `316` lines.
- `boundaries/framework/implementations/typescript/runtime-core/src/lib/runtime-core-driver-support.ts`
  currently measures about `178` lines.
- `boundaries/framework/implementations/typescript/runtime-core/src/lib/runtime-core-hosts.ts`
  currently measures about `830` lines.
- `boundaries/framework/implementations/typescript/runtime-core/src/lib/runtime-core-facade-utils.ts`
  currently measures about `262` lines.
- `boundaries/framework/implementations/typescript/runtime-core/src/lib/runtime-core-facade-ops.ts`
  currently measures about `215` lines.
- `boundaries/framework/implementations/typescript/runtime-core/src/lib/runtime-core-observability.ts`
  currently measures about `206` lines.
- `boundaries/framework/implementations/typescript/runtime-core/src/lib/runtime-core-status.ts`
  currently measures about `289` lines.
- `boundaries/kernel/implementations/typescript/backend-sqlite/src/lib/sqlite-backend.ts`
  currently measures about `807` lines.
- `boundaries/kernel/implementations/typescript/backend-sqlite/src/lib/sqlite-transaction-validation.ts`
  currently measures about `796` lines.
- `boundaries/kernel/implementations/typescript/backend-sqlite/src/lib/sqlite-integrity-assertions.ts`
  currently measures about `240` lines.
- `boundaries/kernel/implementations/typescript/backend-sqlite/src/lib/sqlite-schema.ts`
  currently measures about `888` lines.
- `boundaries/kernel/implementations/typescript/backend-sqlite/src/lib/sqlite-validation.ts`
  currently measures about `750` lines.
- `boundaries/kernel/implementations/typescript/backend-sqlite/src/lib/sqlite-records.ts`
  currently measures about `862` lines.
- `boundaries/kernel/implementations/typescript/backend-sqlite/src/lib/sqlite-lookups.ts`
  currently measures about `522` lines.
- `boundaries/kernel/implementations/typescript/backend-sqlite/src/lib/sqlite-write-tracker.ts`
  currently measures about `127` lines.
- `boundaries/kernel/implementations/typescript/backend-sqlite/src/lib/sqlite-repositories-support.ts`
  currently measures about `432` lines.
- `boundaries/kernel/implementations/typescript/backend-sqlite/src/lib/sqlite-repositories-core.ts`
  currently measures about `742` lines.
- `boundaries/kernel/implementations/typescript/backend-sqlite/src/lib/sqlite-state-utils.ts`
  currently measures about `567` lines.
- `boundaries/kernel/implementations/typescript/backend-sqlite/src/lib/sqlite-state-validation.ts`
  currently measures about `981` lines.
- `boundaries/kernel/implementations/typescript/backend-sqlite/src/lib/sqlite-run-invariants.ts`
  currently measures about `634` lines.
- `boundaries/kernel/implementations/typescript/backend-sqlite/src/lib/sqlite-db-lineage.ts`
  currently measures about `690` lines.
- `boundaries/kernel/implementations/typescript/backend-sqlite/src/lib/sqlite-errors.ts`
  currently measures about `74` lines.
- `boundaries/kernel/contracts/protocol/implementations/typescript/src/lib/kernel-validation.ts`
  currently measures about `99` lines.
- `boundaries/kernel/contracts/protocol/implementations/typescript/src/lib/kernel-validation-runtime.ts`
  currently measures about `656` lines.
- `boundaries/kernel/contracts/protocol/implementations/typescript/src/lib/kernel-validation-records.ts`
  currently measures about `750` lines.
- `boundaries/framework/implementations/typescript/conformance-adapter/src/framework-adapter.ts`
  currently measures about `797` lines.
- `boundaries/framework/implementations/typescript/conformance-adapter/src/framework-adapter-runtime.ts`
  currently measures about `302` lines.
- `boundaries/framework/implementations/typescript/conformance-adapter/src/framework-adapter-driver.ts`
  currently measures about `369` lines.
- `boundaries/framework/implementations/typescript/conformance-adapter/src/framework-adapter-event-stream.ts`
  currently measures about `415` lines.
- `boundaries/framework/implementations/typescript/conformance-adapter/src/framework-adapter-orchestration.ts`
  currently measures about `906` lines.
- `boundaries/framework/implementations/typescript/conformance-adapter/src/framework-adapter-orchestration-lifecycle.ts`
  currently measures about `742` lines.
- `boundaries/framework/implementations/typescript/conformance-adapter/src/framework-adapter-runtime-scenarios.ts`
  currently measures about `546` lines.
- `boundaries/framework/implementations/typescript/conformance-adapter/src/framework-adapter-provider-scenarios.ts`
  currently measures about `460` lines.
- `boundaries/framework/implementations/typescript/conformance-adapter/src/framework-adapter-recovery-scenarios.ts`
  currently measures about `420` lines.
- `boundaries/framework/implementations/typescript/drivers/react/src/lib/react-driver.ts`
  currently measures about `774` lines.
- `boundaries/framework/implementations/typescript/drivers/react/src/lib/react-driver-around-model.ts`
  currently measures about `525` lines.
- `boundaries/framework/implementations/typescript/drivers/react/src/lib/react-driver-stream.ts`
  currently measures about `337` lines.
- `boundaries/framework/implementations/typescript/drivers/react/src/lib/react-driver-stream-support.ts`
  currently measures about `993` lines.
- `boundaries/providers/implementations/typescript/bridge-ai-sdk/src/lib/ai-sdk-provider-bridge.ts`
  currently measures about `863` lines.
- `boundaries/providers/implementations/typescript/bridge-ai-sdk/src/lib/ai-sdk-provider-bridge-prompt.ts`
  currently measures about `421` lines.
- `boundaries/providers/implementations/typescript/bridge-ai-sdk/src/lib/ai-sdk-provider-bridge-generate.ts`
  currently measures about `347` lines.
- `boundaries/providers/implementations/typescript/bridge-ai-sdk/src/lib/ai-sdk-provider-bridge-stream.ts`
  currently measures about `750` lines.
- `boundaries/providers/implementations/typescript/bridge-ai-sdk/src/lib/ai-sdk-provider-bridge-utils.ts`
  currently measures about `788` lines.

## Recommended Next Slice

- Keep the next major hardening slices focused on the remaining oversized
  TypeScript execution surfaces that are still above the hard ceiling after
  the latest runtime-core, orchestration-runtime, driver, runtime-api
  contract, and gRPC runtime-kernel splits.
- The current highest-value production candidates are no longer concentrated
  in one package; repo-wide measurement now points first at
  the larger boundary-owned test/support files, and any remaining extracted
  helper modules that are still close to the hard ceiling such as
  `runtime-kernel-grpc-codec.ts`,
  `orchestration-runtime-node.ts`, `runtime-core.ts`, and
  `react-driver-stream-support.ts`, plus still-oversized support/test files
  in the kernel and framework boundaries.
- The React driver package no longer needs another immediate production
  decomposition pass, because both `react-driver.ts` and
  `react-driver-stream.ts` are back under the ceiling and the package-local
  test lane is green.
- The runtime-core package still warrants more production seams, but it is now
  one hotspot among several, and the orchestration-runtime public facade is no
  longer one of the over-ceiling files. Any future hardening follow-up should
  pick whichever remaining production or support hotspot offers the strongest
  verification lane rather than reopening Epic AE.
