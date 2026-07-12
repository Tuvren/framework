# Adding a new driver

## Terminology first — read this before anything else

In this repo, **"driver" means a resource adapter**: an integration to an
external tool/resource surface. The MCP bus-driver, `@tuvren/mcp-client`
(`typescript/tools/mcp-client`), is the worked example throughout this
guide. Future Exa/Slack-style tool integrations belong in the same
category.

**"Runner" means an execution strategy** — the thing that drives turn/step
execution around a model (ReAct today: `typescript/runners/react`,
`@tuvren/runner-react`, authority at `spec/runners/`). If you're trying to
add a new execution strategy, not a new resource integration, this is the
wrong guide — read `docs/guides/add-a-runner.md` instead.

This is an inversion of older naming in this codebase's history: what used
to be called "Driver Runtime" / "ReAct Driver" is now "Runner Runtime" /
"ReAct Runner" (see `.constitution/architecture/changelog.md`'s v0.11.0
entry). Resource-adapter "driver" usage (tty/output drivers, syslog
driver, bus-driver, provider drivers) is the surviving sense of the word
and is what this guide covers.

## 1. Decide the package home

New drivers live under the port that owns the resource-adapter surface —
today that's `typescript/tools/` (e.g. `typescript/tools/mcp-client`).
There is no Rust or other-language driver home yet; if you're adding a
driver in a language other than TypeScript, read
`docs/guides/add-a-language.md` first for how a new language earns a
place in the tree at all, then mirror the TypeScript driver's shape in
that language's equivalent directory once one exists.

## 2. Decide whether you need new authority, and where it lives

Not every driver needs a full standalone authority packet. Look at how
MCP is organized before deciding:

- MCP's authority packet is `spec/tools/mcp/authority-packet.json`
  (`packetId: "tuvren.providers.mcp"`, `boundary: "providers"`,
  `surface: "mcp-client"`). Note the port/boundary split: the packet
  *lives* under the `tools` port (grouped with other tool-surface
  authority) but declares `providers` as its owning *boundary* — port
  placement and boundary ownership are independent axes; don't assume
  they must match.
  It nests under `spec/tools/mcp/` as a sub-surface of the `tools` port,
  not as a sibling top-level port. If your driver is similarly a
  narrow, single-integration surface, prefer nesting a sub-surface packet
  under the owning port (`spec/tools/<your-driver>/authority-packet.json`)
  over inventing a new top-level port.
- `spec/tools/README.md` records why MCP joined this port (87-M5.1c) and
  where its conformance plans consolidated
  (`spec/conformance/tools/plans/`). Read it for the "pointer, not
  oracle" voice your own addition should match if you write a
  `spec/tools/<driver>/README.md`.
- The capability/tool-contract surface your driver plugs into
  (`@tuvren/core/tools`, `@tuvren/core/capabilities`) is `core` port
  authority (`spec/core/authority-packet.json`, the `tools` binding
  section) — you do not re-declare that surface per driver.

If your driver introduces no new protocol-level semantics beyond "here's
another tool source translating some external protocol into Tuvren tool
definitions," you may not need a new authority packet at all — extending
`spec/tools/mcp/authority-packet.json`'s conformance plans (if it's
MCP-flavored) or adding fixtures to an existing plan may be enough. Add a
new packet only when the driver introduces genuinely new authority-level
claims a downstream implementation needs to conform to.

## 3. Apply the execution-class classification rule

If your driver can be invoked through more than one path (e.g. a provider
invoking it directly vs. Tuvren invoking it server-side vs. a client
endpoint invoking it), the framework's ruling is:

> Execution class is determined by who invokes or runs the server, not by
> the protocol.

This is exactly why MCP moved the way it did: MCP is a binding mechanism,
not an execution class in itself. An MCP server may be invoked by the
provider (provider-mediated), by Tuvren server-side (Tuvren-server), or by
a client endpoint (Tuvren-client) — the protocol is the same in every
case, but the execution class, and therefore the trust/observability
posture, differs by invoker (see
`.constitution/architecture/containers.md`'s MCP Client Container and
Binding & Endpoint Resolver responsibilities). The client/server
execution-class conformance plans that encode this
(`spec/conformance/tools/plans/tuvren-client-execution-class.json`,
`tuvren-server-execution-class.json`) belong to core/framework authority
(`packetId: "tuvren.shared.core"`), not to any one driver's packet —
apply the same discipline to a new driver: classify by invoker, and don't
let your driver's own packet redefine execution class.

## 4. Add a conformance plan and fixtures

Driver-owned conformance plans and fixtures live under
`spec/conformance/tools/` (or the equivalent path under whichever port
your driver's authority nests in), next to MCP's:
`spec/conformance/tools/plans/providers-mcp-client.json`. Follow that
plan's shape: `planId`, `planVersion`, `packetId` back-reference,
`applicability.capabilities`, and `checks[]` with `checkId`,
`operation`, `evidence`, and `assertions`. Keep assertion names matched
to the actual data source your adapter's `dispatch`/`events` responses
populate (`CLAUDE.md`: "Make assertion names match the data source the
runner actually evaluates").

Wire the plan into your authority packet's `authoritativeSources` and
`conformancePlans` arrays the same way
`spec/tools/mcp/authority-packet.json` references
`spec/conformance/tools/plans/providers-mcp-client.json`.

## 5. Certification wiring

A driver is exercised through the boundary's existing conformance adapter
and certification project unless it needs its own. MCP is certified
through `typescript/providers/conformance-adapter` and the
`providers-typescript-certification` Nx project
(`typescript/providers/certification/project.json`), whose `conformance`
target's `inputs` explicitly include both
`spec/conformance/providers/**/*` and `spec/conformance/tools/**/*`. If
your driver's checks are additive to an existing plan set exercised by an
existing adapter, extend that adapter's dispatched operations rather than
standing up a parallel certification project. Only create a new
certification wrapper (and register it in
`tools/conformance/certification/certified-projects.json`, per
`docs/guides/add-a-language.md` §3–4) if your driver genuinely needs its
own adapter/runtime combination that an existing certification project
can't host.

Whichever path you take, the same adapter rules apply: no `checkId`, no
`emitEvidence`, no pass/fail decisions inside the adapter
(`tools/conformance/adapter-protocol/protocol.md`).

## 6. Package conventions

Match `typescript/tools/mcp-client`'s shape:

- `package.json`: `"name": "@tuvren/<driver-name>"`, `"private": true`,
  `"type": "module"`, an `exports["."]` map with `types`/`import`/
  `default` pointing at `./dist/index.d.ts` / `./dist/index.js`, and
  `peerDependencies` (not bundled dependencies) for `@tuvren/core` and
  `@tuvren/sdk` if the driver needs runtime types from the core/sdk
  packages. Keep the entrypoint small and explicit (`CLAUDE.md`: "Keep
  package entrypoints small and explicit").
- `project.json` tags: `["boundary:<owning-boundary>",
  "layer:implementation"]` (mcp-client uses `boundary:providers`). Targets:
  `build` (`tsup` + `tsc --project tsconfig.dts.json`), `test` (`bun
  test`), `typecheck` (`bun tools/scripts/typecheck-project.ts
  <package-path>`), `lint` (`biome check <package-path>`), and an
  `exports-smoke` target (`bun test ./smoke/package-exports.ts`) if you
  want to assert the built package's public surface, not just its source.
- `tsconfig.json` / `tsconfig.lib.json` / `tsconfig.dts.json` /
  `tsconfig.tsup.json` / `tsconfig.typecheck.json` — copy the mcp-client
  set rather than improvising a subset; the `tsconfig.dts.json` config
  belongs to `build`, not `typecheck` (`CLAUDE.md`'s TypeScript
  `typecheck` rule), because it depends on generated `dist/*.d.ts` from
  package dependencies.
- Reuse the relevant boundary testkit (`typescript/providers/testkit` for
  a provider-facing driver) instead of hand-rolling test fixtures — the
  MCP authority packet's `bindingProjections` explicitly lists
  `typescript-provider-testkit: typescript/providers/testkit` alongside
  the implementation itself.
- Optionally add a `BUILD.bazel` shim: a `native_binary` wrapping
  `tools/bazel/nx-run.sh` with `NX_TARGET` set per target, exactly like
  `typescript/tools/mcp-client/BUILD.bazel`'s `build`/`test` targets. This
  is a thin tracer-bullet shim (proves the Bazel↔TypeScript seam, does not
  make the build hermetic) — see the CI workflow header comment in
  `.github/workflows/ci.yml` for why TypeScript Bazel targets are shims
  and `bun run verify` remains the primary semantic gate.
- If your driver touches secrets (auth tokens, headers, credentials),
  follow the edge-confinement pattern documented in
  `typescript/tools/mcp-client/README.md` ("Secret Isolation — Edge
  Confinement"): credentials never cross onto kernel records, canonical
  stream events, telemetry attributes, or transcripts, and that guarantee
  should be conformance-checked, not just asserted in prose.

## Prove it green

```sh
bun run nx run <your-driver-project>:build
bun run nx run <your-driver-project>:test
bun run nx run <your-driver-project>:typecheck
bun run conformance    # exercises the certification project your driver's checks run under
bun run check
```

## See also

- `docs/guides/add-a-language.md` — authoring a new language
  implementation, adapter, and certification wrapper from scratch.
- `spec/tools/README.md` — the `tools` port's own authority map.
- `docs/guides/add-a-runner.md` — authoring an execution strategy
  ("runner"), if that's actually what you're building.
- `docs/guides/how-conformance-works.md` — the shared conformance engine,
  adapter protocol, and evidence model your driver's checks run through.
