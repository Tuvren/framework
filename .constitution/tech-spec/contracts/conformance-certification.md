# Conformance Certification Contracts

Companion for the certification sidecars in this directory: `conformance-operation-catalog`, `conformance-observation-encoding`, `conformance-adapter-protocol`, `conformance-plan`, `certification-profile`, `negative-control-manifest`, `certification-evidence`, and `kernel-identity-recipes`. It fixes the entities and fields that concurrent epics build against (ADR-0075 to ADR-0081). The JSON Schemas at each sidecar's `artifact_path` are the artifacts; this file is not one. The authority packets under `spec/` remain the cross-implementation oracle.

## Operation catalog (pinned)

One file per port, `spec/conformance/<port>/operations.json`, referenced from the port's authority packet. OD-16 assigns deterministic codec operations to `kernel.codec`: encode a kernel record to canonical bytes, decode bytes to a record or a native rejection, and hash opaque bytes and kernel identities. Catalog each as `kind: syscall`. Each invokes one native codec action and returns data or a native error; the runner compares it to committed vectors and identity recipes. The TypeScript codec exposes these actions in `typescript/kernel/protocol/src/lib/kernel-record-identity.ts` and `typescript/kernel/protocol/src/lib/kernel-identity.ts`. The cross-language binding and observations remain assumed until the migrated plans exercise them.

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
- `seams[]`: reviewed test seams that barriers may hold, each with `seamId` and the `operationIds[]` whose native path contains it.

## Observation encoding (pinned)

- Bytes: `{"$bytes": "<lowercase hex>"}`.
- Integers: kernel record numbers and every field a binding schema types as an integer are JSON numbers inside the safe-integer range; for these, fractions, non-finite values, negative zero, and out-of-range values are rejected.
- Other numbers: keep the domain their binding schema admits. A `float64` field such as `TelemetryAttributeValue.number` crosses as a finite JSON number, with non-finite values and negative zero handled as that schema specifies.
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
- `subscribe {instance, channel, operationHandle?} -> {subscription}`, where `operationHandle` scopes the channel to one started operation, and `pull {subscription, credit}`. Notifications `event {subscription, sequence, event}` and `eventsEnd {subscription, terminal}`.
- `armFault {instance, point, selector, occurrence, mode} -> {token}`, where `mode` is `throw` or `block`. Notification `faultReached {token, processEpoch, phase}`; a `throw` fault outcome carries the same `token`.
- `setClock {instance, domain, nowMs}`, where `domain` is `backend` or `worker` as the authority distinguishes them.
- Adapter manifest adds `storage` (`none`, `sqlite-directory`, `postgres-database`), `profiles[]`, and an `executable` launched directly by the supervisor.

**Planned additive change (ADR-0082):** The adapter manifest's `protocol.transport` gains `in-process` and `host` values carrying the same messages, and adapter manifest `storage` gains `host` for host-supplied substrates.

**Temporary legacy packet:** `spec/kernel/legacy/authority-packet.json` has the distinct packet ID `tuvren.kernel.legacy` and references the six legacy plans as authoritative sources, conformance plans, and verification paths. Update each legacy plan's `packetId` to match while preserving its plan ID, checks, assertions, fixtures, and expected observations. Go, Python, and Dart load this packet alongside the canonical kernel packet through their adapter manifests; TypeScript and Rust load only the canonical packet. The canonical packet no longer references the six legacy plans. The legacy packet is report-only and has no certification profile or control manifest; it owns a separate catalog at `spec/conformance/kernel/legacy-operations.json`, containing the 21 composite operations removed from the canonical catalog. The catalog packetId is `tuvren.kernel.legacy`, preserving lossless observations and observation-schema validation. Plan loading, compiler operation discovery, compatibility inventory, guardrails, and provenance must recognize and hash the selected legacy packet, catalog, and plans while keeping canonical profile certification fail-closed. A claimed-profile certificate cannot rely on the legacy packet. The packet declares `transitionalAdapters`, the exact adapter-manifest path set that must reference it; portability-gate.ts rejects missing or unexpected references, while ordinary packets retain boundary-wide coverage. DQ revises EXPECTED_PACKET_TOPOLOGY and both AL inventory files and fixes the kernel plan generator packetId. TypeScript and Rust composite handlers are deleted in DQ. Each remaining adapter retains its handlers until it drops them, its packet reference, and its transitional adapter entry together when it migrates, and DJ deletes the packet and its plans. Selection uses manifest-declared packets and capabilities, never language or adapter identity.

## Plan extensions (pinned)

Additions to `tools/schemas/conformance-plan.schema.json`:

- `checks[].claimIds[]` and `steps[].claimIds[]`: stable obligation ids.
- `steps[].action`: `dispatch` (default), `start`, `await`, `cancel`, `subscribe`, `pull`, `barrier`, `release`, `restart`, `kill`, `respawn`, `openInstance`, `armFault`, `setClock`.
- `steps[].arguments`: an explicit projection. Any value in it is a literal or a reference `{"$ref": "<root>.<path>"}`. Allowed roots are `input` (the check's `input`), `fixture.input` (the input section of the check's fixture; migrated fixtures split into `input` and `expected` sections), and `capture` (a named capture from an earlier step of the same check). Any other root, including `fixture.expected`, is a compile error, and the no-echo rule still applies. `{"$literal": <value>}` passes a value verbatim where it would otherwise parse as a reference. Whole fixtures are no longer forwarded.
- `steps[].capture[]`: `{name, path}` entries. `path` reads the step's observation (`result`, `events`, or `state`) and must lie inside the catalog's observation schema; `name` is unique within the check and is read later as `capture.<name>`.
- `barrier` steps: `{barrierId, seam, participants[]}`. A barrier step arms the gate and must come before the `start` steps of its participants; the runner waits for the adapter's arming acknowledgement before starting any participant, and the compiler rejects a barrier that follows a participant's `start`. `seam` is a `seamId` from the catalog. `participants[]` are `stepId`s of later `start` steps. The runner holds each participant at the seam and records its implementation-entry receipt; it releases none until every participant has arrived.
- `release` steps: `{barrierId, participants[]?}`, releasing all held participants or only those listed, in list order.
- **Planned cross-scope selection:** `steps[].instance` is a logical instance name scoped to the selected process. A `createInstance` step creates a named instance with an explicit scope on the check's isolated substrate; later steps route through that instance's opaque handle. An omitted selector uses the primary instance. Two named instances can bind different scopes to the same per-check substrate, including an in-process memory substrate. The runner owns names and routing; the adapter receives only ordinary instance handles and scope options. Duplicate names, unknown names, or a request to reuse a released substrate fail compilation or execution. The existing runner tracks only one instance per process (`tools/conformance/harness/multi-trace.ts`); this addition is assumed until the cross-scope syscall checks exercise it.
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

Under OD-16, `kernel.memory` requires `kernel.codec` and includes the migrated codec claims. It also requires `kernel.scope-isolation` and includes the cross-scope syscall claims needed by the scope-resolution control. Its two-way inventory includes applicable codec-only plans as well as syscall plans; omitting a required claim or capability cannot produce a certificate. The Rust shared-substrate binding remains assumed until DQ exercises its positive run; DQ requires the TypeScript control kill and DS owns the Rust codec and scope reproductions. Every backend claims kernel.memory, including SQLite and PostgreSQL with their own control runs and required barrier capability. Durable backends add their durable profiles. RuntimeBackend-only checks belong to a separate kernel.backend-spi profile claimed by TypeScript backends; syscall-observable round trips and their mutants retain the existing memory and durable profile tags.

## Negative-control manifest

`spec/conformance/<port>/negative-controls.json`: `controls[]`, each with `mutantId`, `rule` (an authority reference), `claimIds[]`, `activation` (the precondition and the signal proving the mutant executed, which is distinct from fault-activation evidence), `profiles[]`, and `kind`: `implementation` (a behavioral mutant, detected by `designatedAssertions[]`), `observation` (a corrupted observation path, detected by the runner's rejection named in `expectedRejection`), or `instrumentation` (a fault seam that never fires, detected by the runner's rejection for missing fault-activation evidence, also named in `expectedRejection`).

Run outcomes per mutant are `activated`, `killed`, `survived`, `equivalent`, `unsupported`, and `invalid`. An out-of-tree host cannot declare a tagged control unsupported; a survived, invalid, unsupported, or unactivated required control withholds its certificate (ADR-0084). Each designated check passes unmutated before and after its mutant run.

## Undetected claim registers

`tools/schemas/certification-undetected-register.schema.json` validates one object per profile, mapping `claimId` to a nonempty reason string. Keys must belong to that profile and must not already have a designated, killed detector. The kernel packet's `undetectedRegisters` maps every declared profile ID to one repository-relative register path and contains no unknown profile IDs. The gate validates both the schema and the exact profile claim inventory. The selected register participates in verifier-authority provenance. An empty object means no undetected claims. The pinned register shape lands in DP003 after DO; generated authority modules and freshness checks include these registers. The testkit-undetected-claims gate in tools/scripts/publish-registry.ts preflight fails on any nonempty durable register and on memory reasons lacking a referenced closed OD in .constitution/reports/open-decisions.yaml. Remaining memory entries name that closed OD id in their reason strings. A proposal is not closure. Apply the same memory rule to spec/conformance/kernel/kernel-backend-spi-undetected.json: it is empty, or each remaining entry's reason names a closed OD; reject missing, unknown, or open OD ids.

## Certification evidence

The existing evidence fields, plus:

- `certificate {status, profile, complete}`;
- `digests {implementation, adapterManifest, harness, packet, plans, catalogs, fixtures, profiles, controls, verifierAuthority}`, where `verifierAuthority` is one aggregate digest over every authority input the runner reads, including identity recipes, generated record schemas, encoding schemas, and selected undetected registers. Legacy paths are included only when the adapter selects the legacy packet; otherwise the aggregate excludes the legacy packet, catalog, plans, and legacy-only fixtures. Global validation does not add unselected paths to a run digest;
- `environment`;
- `selection[]`, with a reason for every exclusion;
- `negativeControlRunId`: a passing implementation-matched control run whose implementation identity, adapter-manifest digest, `harness`, `packet`, `plans`, `catalogs`, `fixtures`, `profiles`, `controls`, and `verifierAuthority` digests equal the certificate's;
- `undetectedClaims[]`: `{claimId, reason}` entries for the profile register, including an empty list when there are no gaps;
- conditional assertion coverage for the backend capability observed in this run: the selected branch must be evaluated, while the other branch is release-CI fleet evidence and is not required for this host;
- the control-run execution boundary; a published-testkit certificate records `in-process` for the binding and backend runtime, distinct from the positive run's `transport` and `processBoundary`.

**Planned additive change (ADR-0082):** `tools/schemas/certification-evidence.schema.json` allows `digests.implementation` to hold a digest or a host-declared identity. A generated adapter manifest carried by the in-process binding supplies `digests.adapterManifest`. The evidence adds `transport` (`stdio`, `in-process`, or `host`) and `processBoundary` (kind and description), distinct from the top-level `boundary` authority boundary. For an out-of-tree backend, this amends ADR-0081 decision 3: a host-declared identity replaces the implementation-artifact digest, which weakens provenance for out-of-tree certificates, and the certificate says so.

Each failed check adds `failure`:

- the resolved arguments and raw observation;
- `operands[]`, each with `path`, `expected`, `actual`, and `expectedSource`;
- the frame log, `stderrTail`, `exit`, `fault`, and `storageRef`;
- `replay`;
- `classification`: `adapter_protocol`, `verification`, `implementation`, or `environment`.

## Kernel identity recipes

`spec/conformance/kernel/identity-recipes.json`: one recipe per record type (`opaque-object`, `turn-node`, `turn-tree`, `schema`), each with `projection` (included fields and staged-result projection), `cborProfile` (map key ordering rule, integer and length encodings), and `hash` (`sha256`). Recipes are pinned to the committed vectors in `spec/conformance/kernel/fixtures/`.

## Published backend testkit

`@tuvren/backend-testkit` (`typescript/kernel/testkit/src/index.ts`, ADR-0082) is the public way to certify an out-of-tree `RuntimeBackend`. Its entities:

- **Substrate.** The host supplies:
  - an implementation identity (a string, recorded in evidence);
  - a durability, either `process` or `durable`;
  - `provision()`, which returns an opaque storage reference;
  - `open(ref, options)`, which returns a new `RuntimeBackend`; `options` carries the scope and clock that the binding chooses;
  - `close(backend)` and `release(ref)`;
  - optional concurrent attachment;
  - a host-side reader of the substrate server clock when claiming clock.backend-server; without it kernel.shared-backend is also unclaimable;
  - an optional process boundary, which starts a binding behind a transport and kills it, reporting the epoch and signal.
- **Claims.** The profile ids the author claims from `spec/conformance/kernel/profiles.json`: every backend claims kernel.memory, durable backends add their durable profiles, and TypeScript backends also claim kernel.backend-spi.
- **Inventory.** Every selected check with `applicable`, `not_applicable` with a reason, or `unsupported` with a reason for a fault point the seam cannot reach. Profiles list only fault points the SPI seam can reach, so `unsupported` never fails a claimed profile; a claimed profile with a `not_applicable` required check fails.
- **Certificate.** The ADR-0081 evidence bundle records the host-declared implementation identity, `transport`, `processBoundary`, the in-process control-run statement, and the id of the implementation-matched control run. The run matches implementation identity, adapter-manifest digest, and verifier-authority digests. The bundle lists every remaining undetected profile claim and reason (ADR-0084). Control kills and report validity are evaluated per implementation; Rust cannot borrow TypeScript kills and a Rust diagnostic cannot invalidate TypeScript. Rust has no matrix certificate row until DS but retains its suite result in implementations. Only published-testkit certificates require the in-process control-run statement.

## Invariants

- No adapter computes a comparison, chooses an expectation, scripts a scenario, owns a clock, or simulates restart.
- An in-process binding passes only SPI calls to the backend under test, never plans, fixtures, or expected values (ADR-0082).
- Every observation is schema-validated before any assertion runs.
- Expected values reach only the runner.
- A certificate requires a complete run, a passing implementation-matched control run with matching identity, adapter-manifest and verifier-authority digests, and proven fault activation for every claimed fault point. Release CI runs memory controls as verifier evidence; a host memory diagnostic runs only after a control failure and never supplies the certificate's linked run.
- `tree.diff` returns `changedPaths` in canonical UTF-8 byte order (ADR-0080).

The packed-consumer proof uses a foreign fixture backend without first-party backend imports or workspace links. It certifies kernel.memory, kernel.backend-spi, kernel.persistent-reopen, and kernel.process-crash through public tarball entries, retaining real reopen, forced child death, fresh-process recovery, activation receipts, and implementation-matched control kills. First-party public-entry proof also requires shared-backend control kills.
