# Publishing and adopter onboarding

This guide is for a **host developer** adopting the published `@tuvren/*`
packages from the public npm registry: what to install, what the stable
guarantee covers, which packages you must never import directly, how to
route the telemetry funnel at construction time, and a first-Turn program
you can paste and run.

This document is a pointer, not an oracle: the normative authority for
everything here lives in the tech-spec ADRs it cites (ADR-054, ADR-056,
ADR-057, ADR-058) and in the machine-readable authority packets under
`spec/`. If this guide and an ADR ever disagree, the ADR wins.

## 1. What is published, and what the tiers mean

One release of the framework publishes a curated, version-lockstepped
package set with npm provenance attestations. The packages fall into two
tiers:

**Host-facing (stable, semver-guaranteed):**

- `@tuvren/core` — the behavior-free ABI: types, contracts, and assertion
  helpers, exposed through subpaths (`/provider`, `/telemetry`, `/tools`,
  `/capabilities`, …).
- `@tuvren/sdk` — the composition tier (ADR-057): the batteries-included
  `createTuvren` entrypoint, curated `@tuvren/core` re-exports, developer
  helpers, and the `@tuvren/sdk/advanced` composition surface.
- The **leaf adapters** you choose: backends (`@tuvren/backend-memory`,
  `@tuvren/backend-sqlite`, `@tuvren/backend-postgres`,
  `@tuvren/backend-shared`), the runner (`@tuvren/runner-react`), the
  provider bridge (`@tuvren/provider-bridge-ai-sdk`), stream adapters
  (`@tuvren/stream-core`, `@tuvren/stream-sse`, `@tuvren/stream-agui`),
  the MCP client (`@tuvren/mcp-client`), the OTel telemetry adapter
  (`@tuvren/telemetry-otel`), and the remote-kernel client
  (`@tuvren/kernel-grpc-client`).

**Published-internal (visible on the registry, NOT host-facing):**

- `@tuvren/runtime`, `@tuvren/kernel-protocol`, `@tuvren/kernel-runtime`,
  `@tuvren/provider-api`, and `@tuvren/telemetry-semconv` exist on the
  registry only so the host-facing packages' own dependency graphs resolve
  on a fresh install (ADR-057 item 5). They are marked internal, are not
  semver-guaranteed, and can change shape without a major bump. Do not
  install them, do not import them — section 4 spells out the contract.

Every leaf adapter peer-depends on a single `@tuvren/core` instance using
a tilde range (`~<version>`, ADR-037), so your package manager resolves
exactly one copy of the ABI per application tree.

## 2. Install and run a first Turn

The walkthrough below was verified against the actually-published `0.1.0`
packages on registry.npmjs.org (a fresh temp-dir install, no workspace
links); the same check is automated as
`bun tools/scripts/publish-registry.ts --verify-consumer <version>`.

Install the SDK, the core ABI, and your chosen leaves:

```bash
bun add @tuvren/core @tuvren/sdk @tuvren/backend-memory @tuvren/runner-react
```

Then run this program. It builds a stub provider (swap in
`@tuvren/provider-bridge-ai-sdk` for a real model), composes an instance
with `createTuvren`, executes one Turn, and reads the durable result back:

```ts
import { createMemoryBackend } from "@tuvren/backend-memory";
import type { TuvrenModelResponse, TuvrenProvider } from "@tuvren/core/provider";
import { createReActRunner } from "@tuvren/runner-react";
import { createTuvren } from "@tuvren/sdk";

const response: TuvrenModelResponse = {
  finishReason: "stop",
  parts: [{ text: "first-turn-ok", type: "text" }],
  usage: { inputTokens: 1, outputTokens: 1 },
};

const provider: TuvrenProvider = {
  generate: () => Promise.resolve(structuredClone(response)),
  id: "my-first-provider",
  async *stream() {
    await Promise.resolve();
    yield* [];
  },
};

await using instance = await createTuvren({
  backend: createMemoryBackend(),
  provider,
  runner: createReActRunner({ providerCallMode: "generate" }),
});

const thread = await instance.runtime.createThread({});
const handle = instance.orchestration.executeTurn({
  agent: "agent",
  branchId: thread.branchId,
  signal: { parts: [{ text: "hello tuvren", type: "text" }] },
  threadId: thread.threadId,
});

// Consuming the event stream is what starts orchestration execution;
// drain it concurrently with awaiting the result.
const drained = (async () => {
  const events = [];
  for await (const event of handle.allEvents()) {
    events.push(event);
  }
  return events;
})();

const result = await handle.awaitResult();
await drained;

if (result.status !== "completed") {
  throw new Error(`first turn did not complete: ${result.status}`);
}

const read = await instance.runtime.readBranchMessages({
  branchId: thread.branchId,
});
console.log(`first turn completed with ${read.messages.length} durable message(s)`);
```

Three things to know about this shape:

- `createTuvren` accepts **constructed instances only** — you build the
  backend and runner from their leaf packages and pass them in; there are
  no `"memory"` / `"react"` string shorthands (ADR-057 §2).
- The construction-time `provider` binds to `createTuvren`'s default agent
  configuration, addressed as `agent: "agent"` on the orchestration tier.
- `await using` disposes the instance when the scope exits; on runtimes
  without explicit-resource-management, call the disposer manually.

## 3. Stable core vs. `@experimental` surfaces (ADR-056)

The stable guarantee does not cover every export equally. The canonical
experimental marker is the TSDoc **`@experimental`** release tag on an
individual export — you will see it in your editor's hover docs and in
generated documentation, in the same place you see the type signature.

What the badge means for upgrade safety:

- An **untagged** export is part of the frozen stable snapshot: its
  signature cannot change without a semver-major release. A CI freeze gate
  (`tools/scripts/api-freeze-gate.ts`) blocks any commit that breaks it.
- An **`@experimental`** export can change or disappear in any release,
  including a patch. Depend on it deliberately, pin accordingly, and
  expect churn.
- Graduation is additive: when an export stabilizes, only the tag is
  deleted — the import path never moves, so absorbing a graduation costs
  you nothing (semver-minor).
- Adding `@experimental` to a previously stable export is itself treated
  as a breaking change, so a surface you depend on cannot silently lose
  its guarantee.

One whole subpath is declared experimental today: **all exports of
`@tuvren/core/capabilities`** (the advanced capability-orchestration
classes) carry the tag, and the freeze gate enforces that declaration as a
consistency floor. Everything else you reach through `@tuvren/core`,
`@tuvren/sdk`, and the leaf adapters is stable unless its docs show the
badge.

## 4. The host import contract (ADR-057)

A host application imports exactly three kinds of packages:

1. `@tuvren/core` (and its subpaths) for types and contracts,
2. `@tuvren/sdk` for `createTuvren` and the composition surface,
3. the leaf adapters it chose (backend, runner, provider bridge, stream
   adapters, MCP client, telemetry adapter).

**Never import `@tuvren/runtime` or a kernel package
(`@tuvren/kernel-protocol`, `@tuvren/kernel-runtime`) directly**, and
never import `@tuvren/provider-api` or `@tuvren/telemetry-semconv`. They
appear in your lockfile as transitive dependencies — that is expected and
correct — but nothing about their module surface is guaranteed between
releases, and this repository's own verification fails if reference-host
code imports them. Anything they provide that a host legitimately needs is
already re-exported through `@tuvren/sdk` or `@tuvren/core`; if you find a
gap, file an issue rather than reaching under the seam.

(`@tuvren/kernel-grpc-client` is the one kernel-named package that *is*
host-facing: it is the leaf adapter you install to point an instance at a
remote kernel service instead of an in-process one.)

## 5. Routing the telemetry funnel (ADR-058)

One Turn emits two data funnels: the **content funnel** (durable,
session-critical state, routed by the `backend` option) and the
**telemetry funnel** (operational metadata, routed by the `telemetry`
option). You decide how each is persisted once, at construction time —
the topology never changes session behavior, and a telemetry failure can
only ever degrade telemetry, never a content-funnel commit.

The `telemetry` option accepts a bare `TuvrenTelemetrySink` (a push-based
emission consumer), a bare `TelemetryDestination` (a durable delivery
target with declared buffering and an operational-signal channel), or a
route object combining both — all from `@tuvren/core/telemetry`.

**Split topology** — content and telemetry go to different destinations:

```ts
import type { TelemetryDestination } from "@tuvren/core/telemetry";

const centralTelemetry: TelemetryDestination = {
  buffering: { maxBufferedRecords: 1024, overflowStrategy: "drop_oldest" },
  deliver(batch) {
    observabilityClient.enqueue(batch); // your telemetry store, not the backend
  },
  onOperationalSignal(signal) {
    operatorLog.warn(`telemetry funnel degraded: ${signal.kind}`);
  },
};

await using instance = await createTuvren({
  backend: createPostgresBackend({ connectionString: tenantDatabaseUrl }),
  provider,
  runner,
  telemetry: { destination: centralTelemetry }, // telemetry funnel
});
```

**Unified topology** — both funnels land in the same store, via a
host-authored destination backed by the same substrate as `backend`:

```ts
const sharedStore = createPostgresBackend({ connectionString: databaseUrl });

const sameStoreTelemetry: TelemetryDestination = {
  deliver(batch) {
    writeTelemetryRows(databaseUrl, batch); // same database as the backend
  },
};

await using instance = await createTuvren({
  backend: sharedStore,
  provider,
  runner,
  telemetry: sameStoreTelemetry,
});
```

**Mixed-substrate topology** — any other pairing, for example durable
content in SQLite while telemetry fans out to both a live sink and a
network exporter:

```ts
await using instance = await createTuvren({
  backend: createSqliteBackend({ databasePath: "./sessions.db" }),
  provider,
  runner,
  telemetry: {
    destination: otelExporterDestination, // e.g. built on @tuvren/telemetry-otel
    sink: consoleDebugSink,               // live emission for local debugging
  },
});
```

In every topology, `deliver` failures are caught at the telemetry
boundary and surfaced through `onOperationalSignal` (or a last-resort
one-shot warning) — they never throw into, block, or delay your session.

## 6. The Reference Host as a living example

`typescript/host/repl` (the Tuvren REPL reference host) is a complete,
runnable host built strictly on the section-4 import contract: it composes
`createTuvren` from `@tuvren/sdk` with leaf backends and the ReAct runner,
and imports nothing from `@tuvren/runtime` or the kernel packages — a
boundary this repository enforces mechanically in its verification lanes.
Clone the repository and read that package when you want to see the
documented contract carried through a real interactive application
(thread management, streaming consumption, durable replay).

## 7. Install-time note: native modules and lifecycle scripts

`@tuvren/backend-sqlite` depends on `better-sqlite3`, a native module
that compiles during its install lifecycle script. Modern package
managers block lifecycle scripts by default:

- **Bun**: add the dependency to your app's `trustedDependencies`
  (`"trustedDependencies": ["better-sqlite3"]` in `package.json`), then
  reinstall.
- **npm v12+**: npm skips lifecycle scripts by default; approve this one
  explicitly (`npm approve-scripts`) so the native build runs.

The memory and postgres backends have no native install steps and need no
approval.
