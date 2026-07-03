# Adding a new implementation language

This guide walks through bringing a new language implementation into the
framework end to end, using the Rust kernel line — the framework's second
language, after the TypeScript reference implementation — as the running
example.

This document is a pointer, not an oracle: it describes a path through
machine-readable authority and repo tooling. Where it disagrees with
`spec/<port>/authority-packet.json`, a conformance plan, `CLAUDE.md`/
`AGENTS.md`, or the actual gate scripts, those sources win.

"Language" here means an implementation of one or more ports — `kernel`,
`core`, `providers`, `tools`, `runners`, `streaming`, `host`, `telemetry` —
under `spec/`. A language does not need to implement every port at once.
Rust today implements only the `kernel` port (`rust/kernel`); it does not
have `providers`, `tools`, `runners`, or `streaming` implementations, and
this guide does not assume you're filling in more than one port on your
first pass.

## 0. Orient yourself in the authority chain

Before writing any code, read, for the port you are targeting:

- `spec/<port>/README.md` — the port's own "pointer, not oracle" framing
  and directory map.
- The port's authority packet — the machine-readable authority manifest:
  `authoritativeSources`, `conformancePlans`, `bindingProjections`,
  `forbiddenAuthoritySources`, `verificationPaths`. Its location differs
  by port: `kernel`, `core`, `providers`, `telemetry`, and `interop` keep
  a port-root `spec/<port>/authority-packet.json`, while `tools`,
  `runners`, and `streaming` nest their packets per covered surface
  (`spec/tools/mcp/authority-packet.json`,
  `spec/runners/react/authority-packet.json`,
  `spec/streaming/sse/authority-packet.json`) because the packet covers
  only that surface, not the whole port. `host` has no packet at all —
  its contract sections are owned by `tuvren.shared.core` per ADR-037
  (see `spec/host/README.md`).
- The port's neutral artifacts. These differ by port — do not assume one
  shape:
  - `kernel` is CDDL-only: `spec/kernel/cddl/kernel-records.cddl` describes
    record shape (not behavior); there is no TypeSpec/JSON-Schema tree for
    this port.
  - `core`, `providers`, `tools`, `runners`, `streaming`, `host` are
    TypeSpec-driven: `typespec/main.tsp` plus generated `artifacts/`
    (JSON Schema / OpenAPI) and `bindings/*.md` binding appendices.
- The human-authored specs the packet's `humanAuthorityRefs` point at —
  for the kernel port, `docs/KrakenKernelSpecification.md`.
- The port's conformance plans under `spec/conformance/<port>/plans/*.json`
  and any fixtures under `spec/conformance/<port>/fixtures/`. For the
  kernel port: `spec/conformance/kernel/plans/kernel-protocol-core.json`,
  `kernel-protocol-extended.json`, `kernel-run-liveness.json`,
  `kernel-restart-recovery.json`, `kernel-scope-isolation.json`,
  `kernel-reclamation.json`.

Do not treat any Markdown file, including this guide, `docs/`, or
`.constitution/`, as the cross-language oracle for what your implementation
must do — the authority packet and its `authoritativeSources` are.

## 1. Build the implementation against the neutral artifacts

Put language-specific code under `<lang>/<port-or-area>/`, never at a
boundary or contract root (`CLAUDE.md` "Structure"). For Rust today that's
a flat `rust/<name>` per Cargo crate (there is no `rust/kernel/` vs.
`rust/kernel/protocol/` nesting the way TypeScript uses
`typescript/kernel/protocol` — check the existing `rust/` layout before
inventing a new one):

- `rust/kernel` (`tuvren-kernel-rust`) — the reference-shape kernel
  implementation. Its `src/cbor.rs`, `types.rs`, `memory.rs`, `identity.rs`
  encode the CDDL grammar's deterministic CBOR encoding and hashing rules;
  `src/generated/` holds telemetry helpers derived from the shared
  telemetry registry (see `tools/generators/telemetry/`), not hand-authored
  kernel semantics.
- Register the new crate under `[workspace.members]` in the root
  `Cargo.toml` and reuse `[workspace.dependencies]` pins rather than
  re-declaring versions per crate.

Derive from owned neutral sources; do not hand-roll a second, divergent
encoding of the CDDL/TypeSpec shape by eyeballing the reference
implementation's TypeScript.

## 2. Author a conformance adapter — protocol-only, no grading

The conformance adapter is the neutral process seam between your
implementation and the shared semantic conformance engine
(`tools/conformance/harness/run.ts`). Its contract is
`tools/conformance/adapter-protocol/protocol.md` plus
`protocol.schema.json` / `adapter-manifest.schema.json` — read those before
writing a line of adapter code.

Hard rules (from `CLAUDE.md` and the protocol doc — the
`validate-adapter-protocol.ts` gate enforces the schema, not these
English rules, so read the schema too):

- JSON-RPC 2.0 request/response framed over line-delimited stdio.
  Supported methods: `initialize`, `createInstance`, `dispatch`, `events`,
  `inspectState`, `destroyInstance`, `shutdown`.
- The adapter never receives a `checkId`, never exposes `emitEvidence`, and
  never decides pass/fail. It returns an `OperationOutcome`
  (`{ kind: "result", value }` or `{ kind: "error", error }`); the harness
  grades outcomes against the conformance plan's assertions.
- Adapter stdout carries protocol frames only; diagnostics go on stderr or
  in `AdapterObservation.diagnostics`.
- JSON-RPC failures, malformed frames, process exits, and timeouts are
  runner-owned adapter failures — never map them into `$.result.error`
  yourself.
- Fixture replay proves the adapter's own wiring, not implementation
  correctness; it is not a substitute for exercising the real
  implementation.

Concretely, for a new adapter modeled on
`rust/kernel-conformance-adapter/src/main.rs`:

1. Read one line of JSON-RPC per stdin line, dispatch on `method`.
2. Implement `initialize` returning `{ adapterId, capabilities, packetId,
   planVersion }`.
3. Implement `dispatch` by matching `params.operation` against the
   operations your target conformance plan(s) declare, returning
   `{ result: <observation>, evidence: <observation> }` shaped values (see
   the `projection()` helper in the Rust adapter — it emits the same value
   as both `result` and `evidence` so plan assertions can read either).
4. Declare an `adapter.json` manifest next to the adapter binary:
   `adapterId`, `implementationId`, `language`, `boundary`, `protocol`
   (`name`/`version`/`transport`), `command` (the argv the harness spawns),
   `capabilities` (must be a subset of what the target authority packet's
   plans require), `authorityPackets` (paths into `spec/`), `suiteId`,
   `suiteVersion`. Compare
   `rust/kernel-conformance-adapter/adapter.json` against
   `typescript/kernel/conformance-adapter/adapter.json` — the TypeScript
   adapter currently advertises more capabilities
   (`kernel.edge-validation`, `kernel.run-liveness`,
   `kernel.restart-recovery`, `kernel.scope-isolation`,
   `kernel.reclamation`) than the Rust one, which only implements
   `kernel.protocol`, `kernel.logical`, and
   `kernel-protocol.thread.enumeration`. A new language does not have to
   match another language's capability set on day one — it has to be
   honest about what it implements.

Put the adapter under `<lang>/<area>-conformance-adapter/` (Rust) or
`<lang>/<port>/conformance-adapter/` (TypeScript's own layout) — follow the
sibling convention already used for that boundary, don't invent a third
shape.

## 3. Add a certification wrapper project

Certification projects are wrappers only — no assertions, no grading, no
evidence writing (`CLAUDE.md` "Conformance"). Compare
`rust/kernel-certification/src/main.rs` (a two-line stub that tells you to
run the harness directly) against its `project.json`
(`rust/kernel-certification/project.json`): the actual work happens in the
Nx `conformance` target's `command`, which invokes
`bun tools/conformance/harness/run.ts --adapter
<path-to-your-adapter.json> --summary-only` (add `--concurrency N` if your
adapter can run checks in parallel, as
`typescript/kernel/certification/project.json` does).

The wrapper project's `project.json` needs:

- `tags`: `["boundary:<port>", "language:<lang>", "layer:certification"]`
  — the `layer:certification` tag is what discovery keys off.
- A `conformance` target whose `command` invokes
  `tools/conformance/harness/run.ts --adapter <adapter.json>`.
- `build`, `lint`, `test` targets appropriate to your language toolchain
  (Cargo commands for Rust, `bunx`/`bun test` for TypeScript).
- Narrow `inputs` scoping the conformance target to the plans, fixtures,
  and source trees it actually depends on (see the `inputs` array in
  `rust/kernel-certification/project.json` and
  `typescript/kernel/certification/project.json`) so Nx caching stays
  correct.

## 4. Register in the certified-projects manifest

`tools/conformance/certification/certified-projects.json` is a
machine-diffed manifest, checked both directions against tag-based
discovery by
`tools/conformance/certification/validate-certification-discovery.ts`
(part of `bun run codegen`). Add your new wrapper project's Nx project
name (not its path) to the `projects` array. The gate hard-fails if:

- a project tagged `layer:certification` isn't in the manifest,
- the manifest lists a project that isn't tagged `layer:certification`,
- a project's `conformance` target invokes
  `tools/conformance/harness/run.ts` but isn't tagged
  `layer:certification`,
- any project with a `conformance` target is neither
  `layer:certification` nor explicitly `layer:testkit`.

Run the gate directly while iterating:

```sh
bun tools/conformance/certification/validate-certification-discovery.ts
```

## 5. Wire Nx, and optionally a Bazel shim

Nx project discovery here is filesystem-based (`project.json` per
project) — every project in this repo defines itself through a
`project.json`, so add one for each new crate/package you introduce
(adapter, certification wrapper, and the implementation package itself).

A `BUILD.bazel` shim is optional and currently only meaningful for
TypeScript packages, where it's a thin `native_binary` wrapper around
`tools/bazel/nx-run.sh` (see `typescript/tools/mcp-client/BUILD.bazel`):
it shells back out to `bun run nx run <target>` rather than adopting a
hermetic JS Bazel ruleset (`aspect_rules_js` was tried and reverted — see
`MODULE.bazel`'s header and the M3.0 reversal record). Rust crates get
genuinely hermetic Bazel builds/tests via `rules_rust` instead (see
`rust/kernel/BUILD.bazel`) — follow that pattern for a new Rust crate, not
the TS shim pattern.

**What is deliberately NOT required:** a stateful backend does not need
Bazel hermeticity. The PostgreSQL kernel backend and its certification
project intentionally carry no `BUILD.bazel` target at all and stay
Nx-driven, because `devenv`-managed Postgres is not idempotent and cannot
join a hermetic Bazel graph as-is (see the CI workflow header comment in
`.github/workflows/ci.yml`, "Postgres exception (M1.6)"). If your new
language/backend combination is similarly stateful, it is fine to skip
the Bazel shim entirely and rely on `bun run verify`/`verify:kernel`
through Nx.

## 6. Prove it green

Work the lane ladder narrowest-first (`CLAUDE.md` "Commands"):

```sh
bun run check                 # fast inner loop: authority gates + affected typecheck/test/lint
bun run codegen                # includes validate-adapter-protocol + validate-certification-discovery
bun run conformance             # runs active conformance lanes, including your new certification project
bun run verify:kernel           # if you touched the kernel boundary — includes PostgreSQL conformance
bun run verify                  # full release gate, before claiming broad readiness
```

`bun run services:up` starts devenv-managed Postgres once per session if
your lane needs it (`verify:kernel`/`verify` do). It is idempotent to
re-run; raw `devenv up -d` is not.

Confirm the discovery-parity gate specifically accepts your new project
(`bun tools/conformance/certification/validate-certification-discovery.ts`
should print `certification-discovery: OK` with your project counted),
and confirm your adapter round-trips the protocol schema
(`bun tools/conformance/adapter-protocol/validate-adapter-protocol.ts`).

## 7. Update the authority packet's binding projections

Once your implementation exists, add your language to the target port's
`bindingProjections` in its authority packet (port-root
`spec/<port>/authority-packet.json`, or the per-surface nested location
listed in §0 for `tools`/`runners`/`streaming`; e.g.
`"rust": "rust/kernel"`) and add your new implementation, adapter, and
certification paths to that packet's `forbiddenAuthoritySources` list —
implementation trees are binding projections, never authority sources,
and the packet's own guardrail list should say so explicitly.

## See also

- `docs/guides/add-a-driver.md` — authoring a new resource-adapter
  ("driver") rather than a new language.
- `docs/KrakenKernelSpecification.md`, `docs/KrakenFrameworkSpecification.md`
  — the human-authored specs the kernel and framework authority packets
  point back to.
