# How conformance works

This guide explains the conformance system end to end: how cross-language behavioral truth is declared, how implementations are exercised against it, and how the resulting evidence gates the repo. It is a pointer, not an oracle: where it disagrees with an authority packet, a conformance plan, the schemas under `tools/schemas/` and `tools/conformance/adapter-protocol/`, `CLAUDE.md`/`AGENTS.md`, or the gate scripts themselves, those sources win.

## The mental model in one paragraph

There is exactly one semantic engine: `tools/conformance/harness/run.ts`. It parses **conformance plans** (schema-validated JSON under `spec/conformance/<area>/plans/`), talks to an **adapter** (a protocol-only stdio process wrapping one implementation) over a neutral JSON-RPC protocol, evaluates the plan's **assertions** against what the adapter returns, and emits **evidence** (a pass/fail JSON report). Every language/boundary combination gets its own adapter and a **certification project** whose Nx `conformance` target is nothing but a CLI invocation of that engine against that adapter's manifest. Adapters and certification projects contain zero grading logic — no check IDs, no pass/fail, no assertions. All semantics live in the plans (owned under `spec/`) and in the shared engine (owned under `tools/conformance/`), so every implementation of a given port is judged against the same neutral checks.

## The cast of characters

- **Authority packet** (`spec/<port>/authority-packet.json`, or nested per-surface for `tools`/`runners`/`streaming`) — the machine-readable authority manifest for a port or surface: `authoritativeSources`, `conformancePlans`, `bindingProjections`, `forbiddenAuthoritySources`, `verificationPaths`. Note that `forbiddenAuthoritySources` explicitly lists the implementation trees — an implementation is never authority.
- **Conformance plan** (`spec/conformance/<area>/plans/*.json`) — the graded contract: `planId`, `planVersion`, a `packetId` back-reference, `applicability.capabilities`, optional `fixtures`/`scenarios` maps, and `checks[]`.
- **Check** — one gradable unit: `checkId`, an `operation` (or `steps[]` for multi-step trace checks), `assertions[]`, and optional `capabilities`, `fixture`/`scenario`, `input`, `controls`, `evidence`.
- **Capability** — a string token (e.g. `kernel.protocol`, `framework.runner-api`) that gates whether a check applies to a given adapter. Declared at plan level (baseline for all checks), check level (additive), and adapter-manifest level (what the implementation honestly supports).
- **Adapter** — a stdio JSON-RPC process, described by an `adapter.json` manifest, implementing the seven-method protocol for exactly one implementation/boundary/backend combination.
- **Certification project** — an Nx project tagged `layer:certification` whose `conformance` target invokes `tools/conformance/harness/run.ts --adapter <manifest>`. Wrappers only.
- **Evidence** — the `ConformanceEvidence` JSON the harness emits per run (status, per-check results, summary), and, one level up, the checked-in compatibility evidence under `reports/compatibility/`.

## Anatomy of a plan

The plan schema is `tools/schemas/conformance-plan.schema.json`; `tools/conformance/plan-compiler/validate-plans.ts` gates every plan against it in CI. A real example, abridged from `spec/conformance/kernel/plans/kernel-protocol-core.json`:

```json
{
  "planId": "tuvren.kernel.protocol.core",
  "planVersion": "0.1.0",
  "packetId": "tuvren.kernel.protocol",
  "applicability": { "capabilities": ["kernel.protocol"] },
  "fixtures": {
    "kernel-protocol-deterministic": "../fixtures/kernel-protocol-deterministic.json"
  },
  "checks": [
    {
      "checkId": "kernel.protocol.deterministic_hashing",
      "operation": "kernel.protocol.deterministic-hashing",
      "fixture": "kernel-protocol-deterministic",
      "assertions": [
        { "kind": "resultField", "field": "$.hashes.rawOpaqueBytes", "equalsPath": "$.fixture.rawOpaqueBytesSha256Hex" }
      ],
      "evidence": ["hashes.rawOpaqueBytes", "hashes.turnTreeSchema", "hashes.turnNodeIdentity"]
    },
    {
      "checkId": "kernel.logical.diff_paths",
      "operation": "kernel.logical.diff-paths",
      "capabilities": ["kernel.logical"],
      "fixture": "kernel-protocol-logical",
      "assertions": [
        { "kind": "resultField", "field": "$.diffPaths", "equals": ["context.manifest", "messages"] }
      ],
      "evidence": ["diffPaths"]
    }
  ]
}
```

Things to notice:

- The second check adds `capabilities: ["kernel.logical"]` on top of the plan-level `["kernel.protocol"]` — check-level capabilities are additive requirements, which is how one plan can carry checks for optional sub-surfaces.
- `fixture` references the plan's `fixtures` map by id; the harness resolves the file relative to the plan and hands the parsed JSON to the adapter as `input.fixture` (narrowable with `input.fixturePath`). `scenario`/`input.scenarioPath` work the same way for richer recorded-interaction data under `scenarios/`. Fixture and scenario files are shape-validated by separate schemas (e.g. `tools/schemas/fixture-set.schema.json`) — authority fixture validation is deliberately separate from implementation conformance.
- `evidence` entries are **required evidence**: paths that must actually be present in the observed context, or the check fails. The plan compiler (`tools/conformance/plan-compiler/index.ts`) additionally derives required-evidence paths from every decisive assertion, and a guardrail rejects "evidence-only" plans that declare evidence no assertion actually reads.

### Assertion kinds

Assertions evaluate against a uniform `AssertionContext` — `{ events, evidence, fixture, input, result, scenario, state }` — using a tiny JSONPath dialect (`$.a.b.0`). The eleven kinds (`tools/conformance/harness/assertion-engine/index.ts`), by what they read:

| Kind | Reads | Notes |
|---|---|---|
| `eventSequence` | `events[*]` (default path `$.type`) | ordered comparison via `equals`/`contains`/`matches` |
| `terminalEvent` | last event | `eventType` shorthand |
| `ordering` | `events` | `contains: [first, second]` — first must precede second |
| `noEvent` | `events` | asserts an event type never appears |
| `resultField` | `result` | `field` required |
| `stateField` | `state` | |
| `evidenceField` | `evidence` | |
| `schemaValid` | value at `path` | validates against a JSON Schema file |
| `errorEnvelope` | default `$.result.error` | must be `{ code, message }`-shaped |
| `secretAbsence` | `result[field]` vs a configured secret list | fails loud if the surface is missing — never silently passes |
| `secretPatternAbsence` | `result[field]` | detects secret-shaped values (JWTs, embedded creds) structurally |

The kind names a data source on purpose. `AGENTS.md`: "Make assertion names match the data source the runner actually evaluates" — don't claim event coverage from an assertion that actually reads `result`.

### Trace checks

A check with `steps[]` instead of a single operation runs as a trace: the harness calls `createInstance` once, dispatches each step against that instance, resolves `$.`-prefixed step refs against earlier steps' captured contexts (so step B's input can reference step A's observed result), evaluates per-step assertions scoped as `<checkId>.<stepId>`, and finally evaluates check-level assertions against the accumulated trace. `destroyInstance` runs in a `finally`. This is how stateful sequences (e.g. kernel checkpoint/restore flows) get graded without the adapter ever knowing it's inside a multi-step check.

## The adapter protocol

The adapter is the neutral process seam between the engine and one implementation under test. Contract: `tools/conformance/adapter-protocol/protocol.md` + `protocol.schema.json`, with per-language projections in `bindings/typescript.md` and `bindings/rust.md`. Transport is JSON-RPC 2.0, one frame per line, over stdio. Seven methods:

```
initialize({ packetId, planVersion }) -> AdapterCapabilities
createInstance({ input })             -> InstanceHandle | null
dispatch({ operation, input, controls, instance? }) -> OperationOutcome
events({ operation, input, controls, instance? })   -> JsonValue[]
inspectState({ query, instance? })    -> StateView | null
destroyInstance({ instance })         -> null
shutdown({})                          -> null
```

`dispatch` returns an `OperationOutcome`: either `{ kind: "result", value: AdapterObservation }` or `{ kind: "error", error: ErrorEnvelope }`, where `AdapterObservation` is raw observed data — `{ result?, events?, state?, evidence?, diagnostics? }`. That's the adapter's entire expressive range: it observes; the harness grades.

The hard rules, verbatim from the protocol doc and `AGENTS.md`:

- The adapter never receives a `checkId`, never exposes `emitEvidence`, and never decides pass/fail. (There is no `emitEvidence` anywhere in this codebase — evidence is computed by the harness from assertion results; the name exists only in the prohibition.)
- Adapter stdout carries protocol frames only; diagnostics go to stderr or `AdapterObservation.diagnostics`. The harness treats any non-protocol stdout line as fatal for all in-flight requests.
- JSON-RPC failures, malformed frames, process exits, and timeouts are **runner-owned adapter failures** — the adapter must never map them into `$.result.error`. When the harness hits one, it marks every assertion of the affected check failed with the harness-level error; the product-owned `$.result.error` surface stays untouched.
- Fixture replay proves adapter wiring, not implementation correctness — it is not a substitute for exercising the real implementation.

Each adapter declares an `adapter.json` manifest (schema: `adapter-manifest.schema.json`): `adapterId`, `implementationId`, `language`, `boundary`, `protocol` (`name`/`version`/`transport` — all pinned constants), `command` (the argv the harness spawns), `capabilities`, `authorityPackets` (paths into `spec/`), `suiteId`, `suiteVersion`. The manifest's `authorityPackets` array is the discovery root: harness → packets → each packet's `conformancePlans[].path` → plans.

Honesty beats coverage in a manifest. `rust/conformance-adapter/adapter.json` (the Rust framework stub) declares `"capabilities": []` against the same authority packets as the TypeScript framework adapter — so every check is recorded as non-applicable rather than faked. The TypeScript kernel adapter ships three manifests (`adapter.json`, `adapter-sqlite.json`, `adapter-postgres.json`) that run the same host binary with different `--backend` flags and capability sets — one adapter manifest per implementation/backend combination under test.

For writing a TypeScript adapter, `tools/conformance/adapter-protocol/stdio-host.ts` provides `serveStdioAdapter(adapter)`: implement the `StdioConformanceAdapter` interface and the host handles framing; any thrown error becomes an `adapter_host_error` JSON-RPC error frame. The Rust reference scaffold is `rust/kernel-conformance-adapter/src/main.rs`.

## The engine: what a run actually does

`bun tools/conformance/harness/run.ts --adapter <adapter.json> [--plan <path>]... [--check <id>]... [--capability <id>]... [--shard i/n] [--concurrency N] [--evidence-out <path>] [--allow-failing-evidence] [--summary-only]`

1. **Load and validate the adapter manifest**, then discover plans: default is the manifest's `authorityPackets` → each packet's `conformancePlans`; `--plan`/`--packet` override.
2. **Select checks by capability.** For each check, the required set is `plan.applicability.capabilities ∪ check.capabilities`; the check is scheduled only if the adapter's declared capabilities are a superset. Everything else becomes **non-applicable** — recorded in evidence, never silently dropped. This is the whole selection mechanism: the harness never branches on `adapterId`, `language`, or implementation name (`AGENTS.md`: "Select promoted checks by capability or surface requirement, not by language, adapter ID, implementation ID, or runner name"). Unknown `--check`/`--capability` filters are errors, not no-ops.
3. **Handshake validation.** Every worker calls `initialize` and cross-checks the returned `adapterId`/`packetId`/`planVersion`/`capabilities` against the manifest — an adapter that lies about its manifest fails loudly, even when zero checks are applicable.
4. **Run scheduled checks** across up to `--concurrency` worker adapter processes; each worker runs its checks serially (stateful adapters must not race `inspectState`). Per check: `dispatch` the operation with the resolved `input` (checkInput + fixture + scenario) and `controls` (`deadlineMs`, `cancelAfterEvent`), then merge in `events(...)` (only if dispatch didn't already return events) and `inspectState(...)` (only as a fallback — adapter-supplied state from a successful dispatch wins), build the `AssertionContext`, and evaluate assertions plus required evidence.
5. **Emit evidence.** Check status is pass iff every assertion passed; run status is pass iff no check failed. The evidence object carries `adapterId`, `boundary`, `capabilities`, `checkResults[]`, `implementationId`, `language`, `nonApplicableCheckIds`, `status`, `suiteId`, `suiteVersion`, and a `summary` (`passedChecks`/`failedChecks`/`applicableChecks`/`nonApplicableChecks`/`totalChecks`). Exit code is 1 on failure unless `--allow-failing-evidence`. The summary is not trusted on faith elsewhere: `assertConformanceEvidence` (`tools/scripts/lib/conformance-contract.ts`) re-derives the counts from the check results and rejects any evidence whose summary or status doesn't match exactly.

## Certification: wrappers, discovery, and the parity gate

A certification project is deliberately boring. `typescript/certification/project.json`'s `conformance` target is one command — `bun tools/conformance/harness/run.ts --adapter typescript/conformance-adapter/adapter.json --summary-only` — plus narrow Nx `inputs` and `dependsOn` for prerequisite builds. The Rust wrappers are even more literal: `rust/certification/src/main.rs` exists only to print "framework Rust conformance is executed by tools/conformance/harness/run.ts through rust/conformance-adapter/adapter.json" and exit non-zero; the real target is in `project.json`. No assertions, no grading, no evidence writing, ever (`AGENTS.md`).

The fleet is discovery-driven with a hard-fail parity gate. `tools/conformance/certification/certified-projects.json` lists every certification project by Nx name; `validate-certification-discovery.ts` (run by `bun run codegen`, `bun run conformance`, and `verify`) checks it bidirectionally against `layer:certification`-tagged projects and additionally back-checks the engine itself: any project whose targets invoke `tools/conformance/harness/run.ts` must be tagged `layer:certification` (or explicitly `layer:testkit`). A certification lane can't silently disappear, go unregistered, or be quietly reimplemented outside the fleet.

The current fleet (see the manifest for the live list): framework TypeScript, framework Rust (expected-fail stub), framework batteries-included, kernel TypeScript × {memory, sqlite, postgres}, kernel Rust, and providers TypeScript.

## Evidence and the compatibility layer

Two enforcement layers consume evidence:

1. **Live gates.** `run.ts` exits non-zero on failing evidence, so `bun run conformance` (which runs the parity gate, then `nx run-many -t conformance` across the fleet), `bun run verify:kernel` (kernel lanes, including PostgreSQL), and `bun run verify` (which re-invokes `bun run conformance` as a phase step) all fail when structured evidence has `status: "fail"` — the `AGENTS.md` rule "Fail normal `conformance`, `codegen`, and `verify` gates when structured evidence has `status: 'fail'`" made concrete.
2. **Checked-in compatibility evidence.** `tools/scripts/compatibility-report.ts` runs every certification lane (plus cross-language interop lanes), captures each run's evidence, and writes `reports/compatibility/compatibility-matrix.json` plus one evidence file per lane under `reports/compatibility/evidence/`. Each lane gets a `reportStatus` richer than pass/fail: `full_pass` (the adapter covers every capability its authority packets could require), `capability_subset_pass`, `expected_fail` (e.g. the Rust framework stub — an intentional red lane), `unexpected_fail`, `unsupported`, or `not_applicable`. Refresh with `bun run compatibility:evidence` (only to intentionally update checked-in evidence); verify without re-running via `bun run compatibility:check`, which re-derives expectations from the current plan/manifest topology and diffs field-by-field — that's what catches "the matrix says full_pass but the plan set changed" drift, and it also re-rejects any checked-in evidence file whose own status is a failure.

Canonical encodings deserve a special note: CBOR bytes, hash digests, and schema signatures committed under `spec/conformance/<area>/fixtures/` are computed with the TypeScript reference implementation, but the committed JSON is the authority and the generator is tooling. Once a second implementation exists for a surface, cross-validate against its encoder before promoting new canonical fixtures — prefer agreement between implementations over single-language computation (`CLAUDE.md` "Conformance").

## The gates that watch the watchers

The conformance system itself is CI-gated:

| Gate | What it enforces |
|---|---|
| `tools/conformance/plan-compiler/validate-plans.ts` | every plan schema-validates; every check has required evidence; operation names cross-check against the owning packet's TypeSpec/plan sources |
| `tools/conformance/adapter-protocol/validate-adapter-protocol.ts` | protocol message shapes round-trip; every `adapter*.json` under `typescript/` and `rust/` validates against the manifest schema |
| `tools/conformance/certification/validate-certification-discovery.ts` | fleet manifest ⇄ tag discovery parity, plus the harness-invocation back-check |
| `tools/conformance/meta-conformance/run.ts` | unit-tests the assertion engine and plan compiler themselves: one case per assertion kind, adapter-error isolation, required-evidence failure modes, the evidence-only-plan guardrail, and evidence-contract validation |
| `tools/conformance/vocabulary/validate-vocabulary.ts` | authority-packet vocabulary (e.g. telemetry semconv IDs) stays consistent with what's actually referenced |

All of these run inside `bun run verify`'s first phase; the plan and adapter-protocol gates also run in `bun run codegen`.

## A day-in-the-life walkthrough

Suppose you're adding a check that a kernel implementation rejects a malformed turn edge:

1. Declare the behavior in authority: extend the relevant plan under `spec/conformance/kernel/plans/` (or add a new plan and wire it into `spec/kernel/authority-packet.json`'s `conformancePlans` + `authoritativeSources` + `verificationPaths`). Give the check a capability that names the surface (`kernel.edge-validation`), an `operation`, fixture data under `../fixtures/`, `assertions` reading the exact surface the implementation reports on, and `evidence` for each decisive field.
2. Teach adapters the operation: each adapter that declares the capability adds a `dispatch` arm for the new operation, returning raw observations. Adapters that don't implement the surface simply don't declare the capability — their evidence records the check as non-applicable, honestly.
3. Run the narrowest lane: `bun tools/conformance/harness/run.ts --adapter typescript/kernel/conformance-adapter/adapter.json --check kernel.edge-validation.rejects_malformed_edge` while iterating, then the project lane (`bun run nx run kernel-typescript-certification:conformance`), then `bun run conformance`.
4. Refresh compatibility evidence if lane topology changed: `bun run compatibility:evidence`, and confirm `bun run compatibility:check` passes.
5. `bun run verify` before claiming readiness.

## See also

- `docs/guides/add-a-language.md` — authoring a new adapter + certification wrapper from scratch (the §2 adapter rules there are the same rules explained here).
- `docs/guides/add-a-driver.md` / `docs/guides/add-a-runner.md` — where driver- and runner-owned plans live and how they ride existing certification projects.
- `tools/conformance/adapter-protocol/protocol.md` — the normative adapter protocol contract.
- `README.md` "The certification model" — the one-paragraph executive version of this guide.
