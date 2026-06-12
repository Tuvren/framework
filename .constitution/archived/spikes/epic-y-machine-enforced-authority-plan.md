# Epic Y Machine-Enforced Neutral Authority Plan

This file opens Epic Y. It is not a closure inventory. It records the
authority-leak hypothesis, the target authority model, and the ticket plan for
eliminating TypeScript, Rust, generic-runner-source, and Markdown as possible
sources of cross-implementation semantic truth across the named contract
surfaces.

This file is now the historical plan for the authority-packet closure layer
(`KRT-Y001` through `KRT-Y012`). The final conformance-engine posture is
superseded by `constitution/spikes/epic-y-single-semantic-conformance-engine-spike.md`
and active Tasks `KRT-Y013` through `KRT-Y023`, which collapse per-language
semantic runners into one shared semantic runner plus language adapter hosts.

## Status

- Epic Y authority-packet closure is closed in current repo reality; final
  conformance-engine closure is active.
- Authority chain: PRD `CAP-P0-037` and `CAP-P1-038` (machine-enforced
  neutral authority); Architecture `1.2` (machine-enforced neutral authority
  principle), `1.4` (forbidden-authority-source and generated-artifact-
  staleness failure classes), and the new logical containers Authority Packet
  Surface, Conformance Plan Authority, Implementation Adapter Boundary, and
  Generic Conformance Runner; TechSpec ADR-023, ADR-024, ADR-025, ADR-026,
  ADR-027, ADR-028 plus the new §4.11 Authority Packet Manifest, §4.12
  Conformance Plan, and §4.13 Implementation Adapter Protocol contracts.
- Epic W and Epic X are closed. Epic Y is the authority-closure follow-up to
  Epic W's semantic maturity work and Epic X's topology normalization, not a
  re-opening of either decision.

## Core Rule

No future implementer should need to inspect TypeScript, Rust, runner source,
or Markdown to know what must be true. They should inspect the relevant
boundary-owned authority packet, generate or inspect the declared artifacts,
implement the language adapter against the §4.13 protocol, run the relevant
conformance plan, and either pass or fail.

A cross-implementation semantic is binding only when it exists in a
boundary-owned machine authority packet (TechSpec §4.11) and has at least one
executable verification path (TechSpec §4.12 conformance plan or
§ADR-027 freshness check).

## Suspected Authority Leaks

KRT-Y001 must verify these against the live repository before promotion
tickets begin. The list below is the prior-analysis hypothesis from the
handoff that opened Epic Y, not measured findings.

### Leak A — `@tuvren/runtime-api` named as the semantic anchor

TechSpec `4.1` currently records: "`@tuvren/runtime-api` is the semantic
anchor for shared framework types and the host-facing runtime surface." That
phrasing makes a TypeScript package the authority for a cross-implementation
surface. Per ADR-023 a TypeScript package may be a binding projection but not
an anchor; the anchor must be the runtime-api authority packet (KRT-Y005).

### Leak B — TypeScript primitives in cross-language signatures

TechSpec `4.1`, `4.2`, `4.6`, and `4.7` express runtime, kernel, driver, and
adapter semantics through TypeScript primitives: `Promise`, `AsyncIterable`,
`AbortSignal`, `Uint8Array`, `unknown`, `Record<string, unknown>`, callable
signatures, and language-native `Error`. Per ADR-028 these belong only inside
binding-specific appendices declared by the relevant authority packet;
authority sources and authority prose must use the neutral vocabulary.

### Leak C — Contract README placeholders pointing at TypeScript or docs

`boundaries/framework/contracts/runtime-api/README.md`,
`boundaries/framework/contracts/driver-api/README.md`,
`boundaries/framework/contracts/event-stream/README.md`, and
`boundaries/shared/contracts/core-types/README.md` (and their
`spec/README.md` siblings) currently exist as placeholders that name the
TypeScript implementation under `implementations/typescript/` or the human
spec under `docs/` as the source of truth. Per ADR-024 a README cannot be
authority for a cross-implementation semantic; the authority is the packet
manifest (KRT-Y003..Y006).

### Leak D — Callables stay in TypeScript

Various TechSpec sections imply that callable seams (provider invoke,
provider stream, tool execute, approval resolve, validation failure,
structured output, timeout, retry, cancellation, idempotency, driver hook)
are TypeScript-shaped at the contract level rather than at the binding level.
Per ADR-023 and KRT-Y007 each callable resolves to a neutral operation in the
runtime-api or driver-api authority packet, with at least one conformance
plan check; TypeScript and Rust shapes live only in the binding appendices.

### Leak E — Conformance runner source as oracle

The existing TypeScript and Rust conformance runners under
`boundaries/<area>/implementations/<lang>/conformance-runner/` may encode
expected event sequences, expected error codes, expected check IDs, or
expected lifecycle transitions in source code. Per ADR-025 those semantics
must arrive only from a §4.12 conformance plan referenced by an authority
packet; runner source may host only generic mechanics. KRT-Y011 wires the
guardrail that rejects product-semantic literals in runner source.

### Leak F — Compatibility / planning prose as binding claim

`reports/compatibility/compatibility-matrix.json` and the prose around it
describe conformance and interop status in language that may imply pass/fail
binds at the prose level rather than at the per-check evidence level. Per
ADR-024 the binding evidence is the per-check entry plus its `evidencePath`;
prose summaries are review aids, not authority.

KRT-Y001 will close or reclassify each of the above against current repo
reality and surface any additional leaks discovered during the inventory.

## Target Authority Stack

Per TechSpec §1.1 authority-stack posture, cross-implementation meaning is
carried by a layered set of formats. Each format owns one authority kind and
appears in authority packet manifests as needed:

- **TypeSpec** — logical contract spine for data models, operations, events,
  errors, versioning, and portable shape contracts.
- **CDDL** — deterministic CBOR/kernel binary-record grammar.
- **Protobuf / Buf** — gRPC transport projections where gRPC is the chosen
  transport.
- **JSON Schema 2020-12** — portable validation artifacts emitted from
  TypeSpec or authored directly for fixtures and authority manifests.
- **Conformance Plan JSON** — executable behavior assertions, scenarios,
  traces, event-ordering expectations, lifecycle rules, and evidence
  requirements (TechSpec §4.12).
- **OpenTelemetry semconv YAML / Weaver** — telemetry vocabulary and
  generated language helpers.
- **Authority Packet Manifest JSON** — per-surface declaration of which of
  the above are authoritative for that surface and which sources are
  forbidden authority (TechSpec §4.11).

TypeScript and Rust remain implementation languages and binding-projection
surfaces, never authority. Markdown remains rationale and workflow prose,
never authority.

## Authority Packet Layout

For each promoted surface, Epic Y produces:

```text
boundaries/<area>/contracts/<surface>/
  spec/
    authority-packet.json              # §4.11 manifest, packetId tuvren.<area>.<surface>
    typespec/                          # neutral TypeSpec sources where applicable
    cddl/                              # neutral CDDL sources where applicable
    bindings/
      typescript.md                    # TS binding appendix (signatures, ergonomics)
      rust.md                          # Rust binding appendix when present
  artifacts/
    json-schema/                       # generated from typespec/, freshness-checked
    openapi/                           # generated when applicable
  implementations/
    typescript/                        # binding projection package
    rust/                              # binding projection crate when present

boundaries/<area>/conformance/
  plans/
    <plan-id>.json                     # §4.12 conformance plans referenced by manifests
  fixtures/                            # neutral fixtures shared across plans
  scenarios/                           # neutral scenario manifests

tools/
  schemas/
    authority-packet.schema.json       # KRT-Y002
    conformance-plan.schema.json       # KRT-Y008
  scripts/authority-packet/            # KRT-Y002 validator
  scripts/authority-guardrails/        # KRT-Y011 four CI gates
  conformance/
    plan-compiler/                     # KRT-Y008 loader/compiler + generic operators
    adapter-protocol/
      protocol.md                      # KRT-Y009 neutral protocol
      bindings/typescript.md           # KRT-Y009 TS adapter binding
      bindings/rust.md                 # KRT-Y009 Rust adapter binding
```

## Promoted Surfaces

Epic Y promotes exactly these five surfaces:

1. `tuvren.shared.core-types` (KRT-Y003)
2. `tuvren.framework.event-stream` (KRT-Y004)
3. `tuvren.framework.runtime-api` (KRT-Y005)
4. `tuvren.framework.driver-api` (KRT-Y006)
5. Callable seams across runtime-api and driver-api (KRT-Y007) — these do not
   add a sixth packet; they extend the runtime-api and driver-api packets and
   add at least one conformance-plan check per callable.

Other surfaces (kernel protocol packet hardening, host stream adapter
packets, telemetry semconv packet, compatibility-ledger packet, AI SDK
bridge packet) are explicitly deferred. The kernel protocol already owns
CDDL grammar and a transport projection from Epic S/T/U; promoting it to a
full Authority Packet manifest is desirable but not required for Epic Y to
close the cross-implementation oracle gap on the framework surfaces.

## Conformance Plan Direction

KRT-Y008 lands the §4.12 plan compiler with these assertion kinds:

- `eventSequence` — assert the ordered list of event types over a JSONPath
- `terminalEvent` — assert the final event of an ordered channel
- `schemaValid` — assert a JSON value validates against a referenced schema
- `errorEnvelope` — assert an error envelope matches a code and shape
- `stateField` — assert an inspected durable state field equals a value
- `evidenceField` — assert an emitted evidence record contains a field
- `ordering` — assert ordering relations between named events
- `noEvent` — assert a given event type does not appear in a window

Plans are JSON; the compiler validates against
`tools/schemas/conformance-plan.schema.json`, resolves fixtures from
`boundaries/<area>/conformance/fixtures/`, and emits a runtime-loadable plan
the transitional TypeScript and Rust conformance entry points consume through
the §4.13 adapter protocol. Final assertion ownership moves to the shared
runner in `tools/conformance/runner/`.

## Implementation Adapter Direction

KRT-Y009 publishes the §4.13 adapter protocol with these operations:

- `initialize(packetId, planVersion)` returning declared adapter capabilities
- `shutdown()`
- `dispatch(operation, input, controls)` returning result or error envelope
- `events(operation, input, controls)` returning an ordered event channel
- `inspectState(query)` returning a JSON projection where applicable
- runner-side evidence collection, superseded by the final no-checkId adapter
  rule in `epic-y-single-semantic-conformance-engine-spike.md`

Adapters bridge to `Promise`, `AsyncIterable`, `AbortSignal`, `Uint8Array`,
Tokio cancellation tokens, etc. internally. The protocol surface stays
neutral so adding Python, Go, or Zig later requires a new adapter, not a new
test suite.

## Ticket Sequence Rationale

```text
KRT-Y001 inventory (spike) → KRT-Y002 manifest+validator (foundation)
                ├─ KRT-Y003 core-types packet (foundational shapes first)
                ├─ KRT-Y008 conformance plan compiler (behavior plumbing)
                └─ KRT-Y009 adapter protocol (verification plumbing)

KRT-Y003 + Y008 + Y009 → KRT-Y004 event-stream packet
                       → KRT-Y005 runtime-api packet  (critical path)
                       → KRT-Y006 driver-api packet

KRT-Y005 + KRT-Y006 → KRT-Y007 callable seam authority

Y004..Y007 → KRT-Y010 TS binding rebase + Rust projection alignment
KRT-Y010 → KRT-Y011 machine authority guardrails (CI gates)
KRT-Y011 → KRT-Y012 closure inventory
```

The critical path runs Y001 → Y002 → Y008 → Y009 → Y005 → Y010 → Y011 → Y012
because runtime-api is the largest oracle leak and the most-cited surface;
Y003, Y004, Y006, and Y007 land in parallel branches once Y008 and Y009
unblock.

Total active story points: 45 (3+3+3+5+5+5+3+5+3+5+3+2). Sized below the
~5,000 LOC planning heuristic for an authoring-heavy epic; the largest
single piece is KRT-Y010, which is mechanical rebase rather than new design.

## Out of Scope

- Opening a Rust framework, a new driver, a new official backend, a new
  host protocol, or a new language line. Activation of those still depends
  on Epic Y closure plus the deferred-scope rule in `Tasks.md` §2.
- Renaming or breaking existing TypeScript public package APIs. Existing
  packages become declared binding projections of their packets; the public
  surface is unchanged.
- Promoting kernel protocol, host stream adapters, telemetry semconv, the
  compatibility ledger, or the AI SDK bridge to full authority packets. Each
  of those is a candidate for a future epic that builds on Epic Y mechanics.
- Re-measuring the compatibility matrix beyond the existing `bun run verify`
  lane. Epic Y rephrases authority lineage; it does not produce a new
  compatibility regime.
- Editing `docs/KrakenKernelSpecification.md` or
  `docs/KrakenFrameworkSpecification.md`. Those remain human authority
  inputs; Epic Y replaces the implication that they are sufficient
  cross-implementation oracles by themselves.

## Definition of "Comprehensive Enough"

Epic Y is comprehensive enough when a future contributor cannot reasonably
conclude that Markdown, TypeScript, Rust, or generic runner code can define
cross-implementation truth for the five promoted surfaces, and when CI
mechanically rejects attempts to make any of them act that way again. KRT-Y012
records the closure evidence against this bar.
