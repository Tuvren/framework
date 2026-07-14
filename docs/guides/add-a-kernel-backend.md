# Adding a new kernel backend

This guide walks through adding a durable storage backend for the kernel — the layer that persists turn/thread/branch state — using the three existing TypeScript backends (`@tuvren/backend-memory`, `@tuvren/backend-sqlite`, `@tuvren/backend-postgres` under `typescript/kernel/backends/`) as the precedent. It is a pointer, not an oracle: where it disagrees with `spec/kernel/authority-packet.json`, a conformance plan, `docs/KrakenKernelSpecification.md`, `CLAUDE.md`/`AGENTS.md`, or the gate scripts, those sources win.

## 0. Orient yourself in the authority chain

Read, before writing any code:

- `spec/kernel/authority-packet.json` (`packetId: "tuvren.kernel.protocol"`) — the kernel port's authority manifest. Its `authoritativeSources` are the CDDL grammar (`spec/kernel/cddl/kernel-records.cddl` — record shape, not behavior) and six conformance plans under `spec/conformance/kernel/plans/`, plus their supporting fixture sets. Note `forbiddenAuthoritySources` lists the TypeScript and Rust implementation trees: the TS types you'll implement against are a binding projection, never the oracle.
- `docs/KrakenKernelSpecification.md` — the human-authored kernel spec. The sections that map directly onto backend behavior: §2.3 (scope-resolved hash identity — no cross-Scope deduplication, ever), §5.2 (run execution leases, the backend-authoritative lease clock, and the stale-running preemption protocol), §5.5 (the atomic checkpoint transaction and its crash-recovery invariant), and §9 (capability-gated syscalls and the `BackendCapability` descriptor).
- The conformance plans your backend will be graded against: `kernel-protocol-core.json`, `kernel-protocol-extended.json`, `kernel-run-liveness.json`, `kernel-restart-recovery.json`, `kernel-scope-isolation.json`, `kernel-reclamation.json`.

## 1. Implement `RuntimeBackend`

The entire contract is `RuntimeBackend` from `@tuvren/kernel-protocol` (`typescript/kernel/protocol/src/lib/kernel-types.ts`) — `typescript/core` has no kernel backend contract:

```ts
export interface RuntimeBackend {
  capabilities(): BackendCapability;
  health(): Promise<{ ok: true } | { ok: false; reason: string }>;
  purgeScope?(): Promise<void>;
  reclaim?(options?: ReclamationOptions): Promise<ReclamationSummary>;
  transact<T>(work: (tx: RuntimeBackendTx) => Promise<T>): Promise<T>;
}
```

`transact()` hands the kernel a `RuntimeBackendTx` bundling the per-entity repositories — `branches`, `objects`, `observeAnnotations`, `orderedPathChunks`, `runs`, `schemas`, `stagedResults`, `threads`, `turnNodes`, `turns`, `turnTreePaths`, `turnTrees` — each a small write-once/append CRUD surface (see the `*Repository` interfaces in `kernel-types.ts`), plus an optional `now?(): EpochMs` that exists only when the backend advertises the shared lease clock.

The invariants that make a backend correct come from the kernel spec, not from the type signatures:

- **Transactionality (§5.5)**: the checkpoint transaction — TurnNode + TurnTree + branch-head advance + staging clear — commits all-or-nothing. After a crash, either the TurnNode is durably visible (committed) or it is absent and the branch head still points at the prior committed node. There is no partial state.
- **Scope isolation (§2.3)**: Scope is a host-bound partition identity supplied at backend construction, never a kernel syscall argument. Hash resolution is confined to the constructing Scope; identical content stored under two Scopes occupies two independent durable objects, and `store.has`/`store.get` can never observe content outside the constructing Scope.
- **Lease semantics (§5.2)**: a leased running run carries execution-owner identity, a monotonic fencing token, and a lease expiry in kernel time. If your backend is a shared rendezvous for more than one execution owner (like postgres), lease stamping and comparison must use the backend's own transaction-scoped clock (`tx.now()`), not any one owner's wall clock (ADR-050).

For reference shapes: `memory-backend.ts` is a whole-state clone-mutate-validate-swap over JS Maps; `sqlite-backend.ts` is genuinely relational (migrations under `typescript/kernel/backends/sqlite/migrations/`); `postgres-backend.ts` reuses the in-memory state logic and persists it as one JSON snapshot row per `(snapshot_id, scope)` with row-level Scope isolation (ADR-049). Pick whichever storage model fits your substrate — the conformance surface doesn't care, only the invariants do. `@tuvren/backend-shared` offers reusable invariant helpers (`reclaimBackendState`, `createBackendInvariantRecordUtils`, `LEASELESS_RUN_EXPIRY_MS`); check what the existing backends actually import from it before assuming universal reuse — sqlite carries its own reclamation logic, for example.

## 2. Declare an honest `BackendCapability`

`capabilities()` returns the descriptor synchronously:

```ts
export interface BackendCapability {
  readonly "maintenance.reclamation"?: boolean;
  readonly "shared-lease-clock"?: boolean;
  readonly "thread.enumeration": boolean;
  readonly [extraCapability: string]: boolean | undefined;
}
```

The spec's rule (§9.1): the descriptor must be honest. Advertise `true` only for what you implement; a backend advertising `false` for a capability must not implement the optional backing method. Concretely:

- `thread.enumeration: true` requires `ThreadRepository.list()` with `(createdAtMs ASC, threadId ASC)` ordering, durable cursor stability under concurrent inserts, and read-after-write consistency (§9.2–9.3). All first-party backends advertise it.
- `maintenance.reclamation: true` requires `reclaim()`: mark-and-sweep reachability from live roots (non-archived branch heads, thread roots, active-run staged work), grace-windowed against the oldest active execution lease, honoring structural sharing. Reclamation is a mechanism, not a retention policy — the kernel decides structural reachability; the host decides what is still wanted (§9.4). A `false` backend surfaces `TuvrenPersistenceError` code `kernel_capability_unsupported`.
- `shared-lease-clock: true` requires `tx.now()` and is only meaningful for shared-rendezvous substrates. Postgres is the only first-party backend that advertises it; memory and sqlite are single-writer and keep the in-process clock.

The current capability matrix across the three adapter manifests (`typescript/kernel/conformance-adapter/adapter*.json`): all three declare `kernel.protocol`, `kernel.edge-validation`, `kernel.logical`, `kernel.run-liveness`, `kernel.restart-recovery`, `kernel.scope-isolation`, `kernel.reclamation`, and `kernel-protocol.thread.enumeration`; sqlite and postgres add `kernel.persistence.durable`; postgres alone adds `kernel.shared-lease-clock`.

## 3. Shape the package like the existing backends

Create `typescript/kernel/backends/<name>/`:

- `src/index.ts` — the barrel: export `create<Name>Backend(options)` and its options type, nothing else. Match the factory conventions: sqlite's factory returns `RuntimeBackend & { close(): Promise<void> }`; postgres pairs `createPostgresBackend` with `destroyPostgresBackend` for test/conformance teardown.
- `src/lib/<name>-backend.ts` — the backend class, its module-level `<NAME>_CAPABILITIES: BackendCapability` const, and the repositories.
- The fault-injection control: the testkit's `createFaultInjectingBackend` wraps a real backend via a private symbol-keyed property (`Symbol("tuvren.kernel.testkit.fault-injection-control")` exposing `setFaultHooks`/`supportsFaultPoint` with points `before-commit`, `mid-commit`, `after-commit-before-ack`). Implement it, mirroring the existing backend classes — without it the `kernel.restart-recovery.*` conformance operations can't exercise crash points against your backend.
- `package.json` (peer-depend on the protocol package per the sibling backends), `project.json` with the standard targets (`build`, `lint`, `test`, `typecheck` — mirror `backend-memory`'s; sqlite shows the pattern for compile-time migration bundling), and the usual tsconfig set copied from a sibling.

## 4. Wire the shared testkit suites

`@tuvren/kernel-testkit` ships three runner-agnostic suites; your backend's own test file registers all three against its factory. This is the pattern from `typescript/kernel/backends/sqlite/test/backend-sqlite.test.ts`:

```ts
import {
  registerBackendConformanceSuite,
  registerBackendInvariantSuite,
  registerBackendRecoverySuite,
} from "@tuvren/kernel-testkit";
import { create<Name>Backend } from "../src/index.js";

registerBackendConformanceSuite({
  createBackend: () => create<Name>Backend(options),
  suiteName: "@tuvren/backend-<name> shared conformance",
  testApi: { describe, test },
});
// ...same shape for registerBackendInvariantSuite and registerBackendRecoverySuite
```

The suites are test-runner-agnostic through the `BackendTestSuiteApi` shim — memory passes `bun:test`'s `describe`/`test`, sqlite/postgres pass `node:test`'s. The conformance suite covers the base contract (health, rollback isolation, defensive cloning, nested-transaction rejection, chunked ordered-path storage, deterministic ordering); the invariant suite covers run-state, turn, and archive invariants; the recovery suite covers pause/resume checkpoints and crash-recovery flows against the §5.5 invariant.

## 5. Extend the kernel conformance adapter

The kernel boundary runs one adapter host binary for all backends, selected by a `--backend` flag. Three code sites to touch, all in `typescript/kernel/conformance-adapter/`:

- `src/host.ts` — widen `KernelAdapterConfig`'s `backend` union with your name and add a branch to `defaultCapabilities()`. Note the deliberate duplication: the capability list lives both here (as the no-flags fallback) and in the manifest JSON; keep them in sync manually.
- `src/host-support.ts` — add a dynamic-import branch for your factory in `createConfiguredBackend()` and in `withScopedBackendPair()` (the latter powers the cross-scope isolation probe).
- `adapter-<name>.json` — copy `adapter-sqlite.json`: `adapterId`/`implementationId` for your backend, a `command` invoking the host with `--backend <name>` plus one `--capability` flag per advertised capability, a matching top-level `capabilities` array, `authorityPackets: ["spec/kernel/authority-packet.json"]`, and the unchanged `suiteId`/`suiteVersion`.

The adapter's `dispatch` implementation itself is backend-agnostic — it constructs a `RuntimeKernel` over whatever `createConfiguredBackend` returns and drives kernel syscalls — so no per-backend changes are needed there. And the usual adapter discipline applies: no `checkId`, no `emitEvidence`, no pass/fail decisions (see `docs/guides/how-conformance-works.md`).

## 6. Certification project and fleet registration

Create `typescript/kernel/certification-<name>/project.json`, mirroring `certification-sqlite`: tags `["boundary:kernel", "language:typescript", "layer:certification"]`, and a single `conformance` target running `bun tools/conformance/harness/run.ts --adapter typescript/kernel/conformance-adapter/adapter-<name>.json --concurrency 4 --summary-only`, with `dependsOn` building `backend-<name>`, `kernel-runtime`, and the conformance adapter first. The sqlite/postgres certification projects carry only the `conformance` target — no separate test/lint/typecheck — and yours should too; certification projects are wrappers only.

Then add the project name to `tools/conformance/certification/certified-projects.json`'s `projects` array. `validate-certification-discovery.ts` machine-diffs that manifest both directions against `layer:certification` tag discovery and hard-fails CI on any mismatch.

## 7. If your backend needs a live service

Postgres is the precedent. The service is declared in the repo-root `devenv.nix` (`services.postgres` with an initial `tuvren_runtime` database); tests read connection settings from the direnv-loaded environment and assume the caller ran `bun run services:up` once per session (never call raw `devenv up -d` from a runner or test — it is not idempotent and fails hard if the daemon is already up; `CLAUDE.md` "Services"). Follow `typescript/kernel/backends/postgres/test/postgres-test-helpers.ts`: a readiness probe that retries `SELECT 1` to absorb the daemon-ready-but-not-listening race, a fresh randomized schema per test run, and explicit cleanup in `afterAll`. A stateful backend is also deliberately exempt from Bazel hermeticity — skip the `BUILD.bazel` shim and stay Nx-driven, as the postgres lane does (see `docs/guides/add-a-language.md` §5).

## Prove it green

```sh
bun run nx run backend-<name>:test        # the three shared testkit suites
bun run nx run backend-<name>:typecheck
bun run nx run kernel-typescript-<name>-certification:conformance
bun run codegen                            # validate-adapter-protocol + validate-certification-discovery
bun run services:up                        # once per session, if your lane needs a devenv service
bun run verify:kernel                      # the kernel boundary lane, including PostgreSQL conformance
bun run verify                             # full release gate
```

Refresh checked-in compatibility evidence once your lane exists (`bun run compatibility:evidence`), and confirm `bun run compatibility:check` passes.

## See also

- `docs/guides/how-conformance-works.md` — the engine, adapter protocol, and evidence model your certification lane runs through.
- `docs/guides/add-a-language.md` — the same adapter/certification machinery generalized to a whole new language.
- `docs/KrakenKernelSpecification.md` §5, §9 — the normative lease, checkpoint, and capability semantics.
- `spec/kernel/README.md` — the kernel port's own authority map.
