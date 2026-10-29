---
id: ADR-0082
status: accepted
date: 2026-10-29
certainty: assumed
assumption: "The owner ruled the package and its name, the trust model, retirement of the legacy suites, the portability floor, and the two-epic sequencing in the 2026-10-29 Claude Code session. The mechanism below (substrate lifecycle, transports, applicability, in-runtime controls) is that session's design sketch and settles by ruling when the owner approves this pass."
---
### ADR-0082 Published, Runtime-Portable Backend Testkit

- **Status:** accepted. Amends ADR-0075 (decision 5, the adapter launch boundary), ADR-0076 (decisions 2 and 3, harness-owned storage and process supervision), and ADR-0081 (decision 3, certificate contents) for the certification of out-of-tree `RuntimeBackend` implementations. Reopens github#154, which was closed on 2026-10-14 although nothing was published.
- **Context:**
  - `RuntimeBackend` is a public SPI: `@tuvren/sdk` re-exports it (`typescript/sdk/src/index.ts:166`), and `createTuvren` accepts any constructed backend. An implementer outside this repository has no way to prove that an implementation is correct, because every proof path is private, tied to the repository layout, or tied to Node.
  - Two evidence systems exist today.
    - The self-asserting `registerBackend{Conformance,Invariant,Recovery}Suite` suites in the private `@tuvren/kernel-testkit` assert with `node:assert/strict` at the SPI level. Only the memory, SQLite, and PostgreSQL package tests use them.
    - Certification under ADR-0075 to ADR-0081 runs the shared harness (`tools/conformance/harness`) against the kernel plans, catalog, profiles, and negative controls through a stdio JSON-RPC adapter (`typescript/kernel/conformance-adapter`, backend chosen by `--backend`). Only this path is certification.
  - The testkit reads fixtures through `node:fs` and `fileURLToPath(import.meta.url)` and compiles Ajv validators at module scope (`typescript/kernel/testkit/src/lib/kernel-conformance-fixtures.ts:17-19,118,170,193`).
  - The harness uses `node:fs`, `node:path`, `node:child_process`, `node:readline`, `node:os`, and `node:crypto`. It compiles Ajv at runtime (`tools/conformance/harness/assertion-engine/schema.ts`, `observation-encoding.ts`, `run-plans.ts`) and resolves files from `REPO_ROOT` (`run.ts:181`).
  - The adapter imports `tools/conformance/adapter-protocol` through relative repository paths.
  - The production kernel path carries Node-specific APIs: `node:crypto` in `@tuvren/kernel-runtime` (`runtime-kernel.ts:17`), `node:async_hooks` in `@tuvren/backend-memory` (`memory-backend.ts:17,995`), and `node:process` in `@tuvren/backend-shared`.
  - Isolate runtimes cannot spawn subprocesses, and runtimes under a content security policy or an isolate policy reject `new Function`.
  - PRD CAP-036 and CAP-038 already require implementations to prove parity against shared machine authority. This ADR delivers that requirement to implementers outside the repository and does not change product scope.
- **Decision:**
  1. **One public package.** `typescript/kernel/testkit` is reshaped into the public `@tuvren/backend-testkit`, released in the fixed `@tuvren/*` group under ADR-0069. There is no compatibility shim, because nothing outside the repository depends on `@tuvren/kernel-testkit`. Benchmark helpers move to an internal location. Mutants, barrier controls, and fault controls remain documented test-only exports, and production packages must not import them.
  2. **One verdict path.** `tools/conformance/harness` splits into a portable core and a Node driver. The core covers plan selection, step execution, the assertion engine, observation validation, lossless encoding, integrity assertions, fault-activation and barrier rules, applicability, and certificate assembly. The driver covers file loading, spawning, the stdio transport, storage provisioning, and the CLI. The CLI harness and the published package run the same core source, and the package bundles it at build time. Go, Python, Dart, and Rust keep using the CLI.
  3. **Authority ships as data.** A build step generates modules that export the kernel authority packet, plans, operation catalog, profiles, negative-control manifest, identity recipes, encoding schema, and fixtures, each with its canonical digest. Nothing reads files at runtime. Digests are recomputed with WebCrypto.
  4. **No runtime code generation.** Every schema the runner validates against is known at build time. These schemas compile ahead of time to standalone validator modules, and the CLI harness uses the same precompiled validators. The verifier keeps Ajv semantics, which is deliberately independent of the production validator chosen in ADR-0083.
  5. **A transport-neutral binding.** The TypeScript kernel binding is extracted from the stdio host so it implements the adapter-protocol methods over a host-supplied substrate. Three transports exist:
     - an in-process transport whose observations still round-trip through the ADR-0078 encoding;
     - the existing stdio child-process transport;
     - a host-supplied transport.

     This amends ADR-0075 decision 5. When the implementation under test is a `RuntimeBackend` driven through the reviewed Tuvren binding, the binding and runner may share a process. The backend receives only SPI calls and never plans or expected values. The trust model stays first-party verification (ADR-0075 decision 1).
  6. **The host supplies the substrate lifecycle.** The host provides an implementation identity, a declared durability (`process` or `durable`), and four calls:
     - `provision` creates fresh isolated storage for each check;
     - `open` creates a new backend instance over that storage, taking the scope and clock options the binding passes;
     - `close` shuts an instance down gracefully;
     - `release` drops the storage.

     Optionally, the host also declares concurrent attachment to one storage reference, and supplies a process boundary that can start a binding behind a transport and kill it, reporting the epoch and signal.

     This amends ADR-0076 decisions 2 and 3 for out-of-tree substrates: the host provisions, the runner sequences, and adapters still never choose expected outcomes. The package's Node driver ships an operating-system process boundary. Any other boundary, such as a worker, an isolate, or a remote sandbox, qualifies for `kernel.process-crash` only when killing it discards all in-memory state of the instance and its connections.
  7. **The same profiles, with honest applicability.** Out-of-tree backends claim the same kernel profiles as first-party backends. Applicability is computed from three sources: the substrate's declarations, the backend's observed capabilities, and the transport. A claimed profile with a non-applicable required check fails (ADR-0081 decision 1). Every unclaimed or non-applicable case is reported as `not_applicable` with its reason and is never registered as a skipped test.
  8. **Faults at the SPI boundary.** Faults are injected by EPIC-DF's hook-free decorator at `RuntimeBackend.transact`, in `throw` and `block` modes, at these points:
     - `before-commit`;
     - `after-turn-node-write-before-head`;
     - `after-head-move-before-staging-clear`;
     - `after-commit-before-ack`.

     A commit submitted with an unknown outcome cannot be reached at the SPI boundary and stays unsupported for every backend. No backend fault-hook interface is added.
  9. **The legacy suites retire into plans.** An obligation audit under ADR-0075 decision 8 maps every assertion of the three `register*Suite` suites, with stable `claimId`s, to one of four outcomes:
     - an existing claim;
     - a new kernel plan check when the behavior is observable through syscalls;
     - a new SPI-level plan family under a `kernel.backend-spi` capability when it is observable only at the SPI, such as defensive cloning or nested-transaction rejection;
     - a deletion with a stated reason.

     The suites and every `node:assert` use are then deleted. A persisted-field round-trip family is added. It writes every stored record kind with each optional field both present and absent, reads them back on the same instance and after reopen, and compares opaque objects (including large objects and chunked ordered paths) by digest. Framework fields inside opaque objects, such as `admissionKey`, are covered by that byte-exact round trip.
  10. **Negative controls run where the backend runs.** The package ships the control manifest and its mutants of the reference memory backend. `certify()` runs the control set in the same runtime as the backend under test, which proves the verifier works there. The certificate links that passing control run through matching verifier-authority digests (ADR-0081 decision 3). Release CI runs the same controls.
  11. **No dependency on a test runner.** `certify()` returns the evidence bundle without any test runner. A `{ describe, test }` registration registers one test per applicable check, plus an inventory test that fails on an unclaimable or filtered run. It works with Vitest, `bun:test`, `node:test`, and Deno's standard BDD module.
  12. **Certificate contents.** This amends ADR-0081 decision 3. For an out-of-tree backend, the certificate records the host-declared implementation identity in place of an artifact digest the package cannot compute, together with the transport kind and, for `kernel.process-crash`, the boundary kind.
  13. **Web-standard APIs.** The package and every package on its import path (`@tuvren/kernel-protocol`, `@tuvren/kernel-runtime`, `@tuvren/backend-shared`, `@tuvren/backend-memory`) replace Node-specific APIs with web-standard ones:
      - `crypto.randomUUID` and `crypto.subtle`;
      - `performance.now`;
      - `TextEncoder`;
      - promise-based timers;
      - structural equality written in the package.

      They use no filesystem, no subprocess outside the separate Node-driver entry, and no runtime code generation. `AsyncLocalStorage` has no web standard. EPIC-DK's spike either designs it out (per-operation backend views for barrier and fault attribution, and an explicit transaction token for nested-transaction detection) or reports the narrowest dependency that remains for an owner ruling.
  14. **Dogfooding.** The memory, SQLite, and PostgreSQL certification lanes run through the package's public entry point and define their substrates exactly as an outside implementer would. Portability lanes prove the floor with four runs:
      - Node with `--disallow-code-generation-from-strings`;
      - Bun;
      - Deno with no permissions;
      - a static check of a platform-neutral bundle of the core entry.
  15. **Sequencing.** EPIC-DK (portable certification core) depends on EPIC-DF. EPIC-DL (published testkit) depends on EPIC-DK and EPIC-DJ, so the package never carries legacy adapter-scripted composites, and EPIC-CB depends on EPIC-DL.
- **Alternatives considered:**
  - Publish `@tuvren/kernel-testkit` as it is, as github#154 and the downstream ticket asked. Rejected by the owner: it publishes the self-asserting suites as a second oracle beside the ADR-0075 runner, and it does not load without a filesystem or with code generation disabled.
  - Keep the three suites as non-certifying diagnostics beside the certification checks. Rejected by the owner: it leaves two oracles and keeps `node:assert` in a public package.
  - Require a process boundary for every certification run. Rejected by the owner: backends on runtimes without subprocesses could never certify.
  - Document the Node-compat subset that the kernel already needs as the floor. Rejected by the owner, who directed that Node-specific APIs be replaced with web-standard ones wherever necessary.
  - Other names for the package: `@tuvren/kernel-testkit` made public, or `@tuvren/backend-certification`. The owner chose `@tuvren/backend-testkit`, which matches the `backend-*` package names an implementer looks for.
  - No second independent design was requested. The owner ruled each choice above in the session.
- **Consequences:** These are assumed until observed.
  - An out-of-tree backend certifies with the same plans, fault points, controls, and certificate shape as the first-party backends, on any runtime that meets the floor.
  - The legacy suites, their `node:assert` uses, and the fault-hook instruction in `docs/guides/add-a-kernel-backend.md` disappear, and the guide is rewritten for outside implementers.
  - In-process certification is weaker than a process boundary against a dishonest binding. That residual is bounded by the first-party trust model and the negative controls, as in ADR-0075.
  - The plans grow an SPI family and a round-trip family, each with mutants under ADR-0079.
  - The Bazel layer epics pick up the renamed package through their layering rule.
  - The first publication is at least 0.4.0, because master already carries minor changesets, and the real publish stays human-gated (ADR-0069 decision 4).
  - The rename touches every workspace dependent of `@tuvren/kernel-testkit`: the memory, SQLite, and PostgreSQL backends, the kernel certification package, and `@tuvren/runtime`'s development dependencies.
  - Architecture BND-29 describes the runner as a process. An in-process run keeps its responsibilities unchanged, and a Stage 2 alignment may restate the wording.
