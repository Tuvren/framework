# Conformance Certification Contracts

Companion for the certification sidecars in this directory: `conformance-operation-catalog`, `conformance-observation-encoding`, `conformance-adapter-protocol`, `conformance-plan`, `certification-profile`, `negative-control-manifest`, `certification-evidence`, and `kernel-identity-recipes`. It fixes the entities and fields that concurrent epics build against (ADR-0075 to ADR-0081). The JSON Schemas at each sidecar's `artifact_path` are the artifacts; this file is not one. The authority packets under `spec/` remain the cross-implementation oracle.

## Operation catalog (pinned)

One file per port, `spec/conformance/<port>/operations.json`, referenced from the port's authority packet.

- `catalogId`, `catalogVersion` (semver), `packetId`.
- `operations[]`, each with:
  - `operationId`: dotted name, unique in the catalog. Kernel ids follow the kernel specification syscalls: `kernel.store.put`, `kernel.tree.diff`, `kernel.run.recover`, and so on.
  - `kind`: `syscall` (one public action of the implementation), `control` (harness lifecycle, clock, fault arming, scheduling), or `double` (scripted test dependency).
  - `binding`: reference to the public surface in the authority packet's binding projections.
  - `capability`: the capability that gates the operation.
  - `input`: JSON Schema for the arguments.
  - `observation`: closed JSON Schemas (`additionalProperties: false`) for `result`, `events`, and `state`, each optional. A field may be boolean only when the native API returns that boolean.
  - `errors`: canonical error codes the operation may raise.
  - `handles`: handle types the operation creates or consumes (instance, operation, subscription).
  - `deprecated`: true for legacy composite operations kept only until every adapter has migrated.

## Observation encoding (pinned)

- Bytes: `{"$bytes": "<lowercase hex>"}`.
- Integers: JSON numbers inside the safe-integer range. Fractions, non-finite values, negative zero, and out-of-range values are rejected.
- Optional fields: absent when absent. `null` only where the CDDL or catalog allows it.
- Hashes: lowercase 64-hex strings. Identifiers and handles are distinct string types.
- Arbitrary records: a recursive tagged union of `{"$map": [[key, value], ...]}`, `{"$bytes": ...}`, arrays, strings, safe integers, booleans, and `null`.
- Duplicate object keys are rejected. Array order is preserved.

## Adapter protocol 0.2.0 (pinned)

Line-delimited JSON-RPC 2.0 over stdio. An error member carries an `ErrorEnvelope {code, message, details?, cause?}`.

- Kept from 0.1.0: `initialize`, `createInstance`, `dispatch`, `events`, `inspectState`, `destroyInstance`, `shutdown`.
- `initialize` result adds `protocolVersion`, `profiles`, `storageKinds`.
- `createInstance {input, storageRef?, scope?, clock?}`, and `openInstance {storageRef, scope?}` to reattach to retained durable state.
- `startOperation {operation, arguments, instance} -> {operationHandle}`, `awaitOperation {operationHandle} -> OperationOutcome`, `cancelOperation {operationHandle, reason}`.
- `subscribe {handle, channel} -> {subscription}`, `pull {subscription, credit}`. Notifications `event {subscription, sequence, event}` and `eventsEnd {subscription, terminal}`.
- `armFault {instance, point, selector, occurrence, mode}`, where `mode` is `throw` or `block`. Notification `faultReached {token, processEpoch, phase}`.
- `setClock {instance, domain, nowMs}`, where `domain` is `backend` or `worker` as the authority distinguishes them.
- Adapter manifest adds `storage` (`none`, `sqlite-directory`, `postgres-database`), `profiles[]`, and an `executable` launched directly by the supervisor.

## Plan extensions (pinned)

Additions to `tools/schemas/conformance-plan.schema.json`:

- `checks[].claimIds[]` and `steps[].claimIds[]`: stable obligation ids.
- `steps[].action`: `dispatch` (default), `start`, `await`, `cancel`, `subscribe`, `pull`, `barrier`, `release`, `restart`, `kill`, `respawn`, `openInstance`, `armFault`, `setClock`.
- `steps[].arguments`: an explicit projection from input roots and earlier trace captures. Whole fixtures are no longer forwarded.
- `steps[].capture`: a named capture of an observation path.
- New assertion fields:
  - `notEquals` and `notEqualsPath`;
  - `lessThan`, `lessThanOrEqual`, `greaterThan`, `greaterThanOrEqual`, each with a literal or path;
  - `length`;
  - `every` and `some`, which take a nested assertion and require an explicit `length`;
  - `when {path, equals}`;
  - `present`.
- New assertion kinds:
  - `digest`, `canonicalCbor`, `identity`, `referenceWalk`;
  - `arrival`;
  - `faultActivated`, `processExit`.
- An unresolved operand is a failure.

## Certification profile

`spec/conformance/<port>/profiles.json`: `profiles[]`, each with `profileId` (for example `kernel.memory`, `kernel.persistent-reopen`, `kernel.process-crash`, `kernel.shared-backend`), `requiredCapabilities[]`, `claimIds[]`, `faultPoints[]`, `negativeControls[]`, and `requiredEvidence[]`.

## Negative-control manifest

`spec/conformance/<port>/negative-controls.json`: `controls[]`, each with `mutantId`, `rule` (an authority reference), `claimIds[]`, `activation` (the precondition and the proof signal), `profiles[]`, `designatedAssertions[]`, and `kind` (`implementation` or `observation`).

Run outcomes per mutant are `activated`, `killed`, `survived`, `equivalent`, `unsupported`, and `invalid`.

## Certification evidence

The existing evidence fields, plus:

- `certificate {status, profile, complete}`;
- `digests {implementation, adapterManifest, harness, packet, plans, catalogs, fixtures, profiles, controls}`;
- `environment`;
- `selection[]`, with a reason for every exclusion;
- `negativeControlRunId`.

Each failed check adds `failure`:

- the resolved arguments and raw observation;
- `operands[]`, each with `path`, `expected`, `actual`, and `expectedSource`;
- the frame log, `stderrTail`, `exit`, `fault`, and `storageRef`;
- `replay`;
- `classification`: `adapter_protocol`, `verification`, `implementation`, or `environment`.

## Kernel identity recipes

`spec/conformance/kernel/identity-recipes.json`: one recipe per record type (`opaque-object`, `turn-node`, `turn-tree`, `schema`), each with `projection` (included fields and staged-result projection), `cborProfile` (map key ordering rule, integer and length encodings), and `hash` (`sha256`). Recipes are pinned to the committed vectors in `spec/conformance/kernel/fixtures/`.

## Invariants

- No adapter computes a comparison, chooses an expectation, scripts a scenario, owns a clock, or simulates restart.
- Every observation is schema-validated before any assertion runs.
- Expected values reach only the runner.
- A certificate requires a complete run, a passing negative-control run at the same plan versions, and proven fault activation for every claimed fault point.
- `tree.diff` returns `changedPaths` in canonical UTF-8 byte order (ADR-0080).
