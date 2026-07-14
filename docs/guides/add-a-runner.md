# Adding a new runner

## Terminology first — read this before anything else

In this repo, **"runner" means an execution strategy**: the component that drives turn/step execution around a model. ReAct is the only runner today (`typescript/runners/react`, `@tuvren/runner-react`, authority under `spec/runners/`), and it is the worked example throughout this guide.

**"Driver" means a resource adapter** — an integration to an external tool/resource surface such as the MCP client. If you're adding a resource integration rather than an execution strategy, this is the wrong guide; read `docs/guides/add-a-driver.md` instead. That guide's own terminology section records the naming history: what used to be called "Driver Runtime" / "ReAct Driver" is now "Runner Runtime" / "ReAct Runner" (the v0.11.0 rename; packet, plan, check, and capability identities were renamed at 87-M6.4b).

This document is a pointer, not an oracle: where it disagrees with `spec/core/authority-packet.json`, `spec/runners/react/authority-packet.json`, a conformance plan, `CLAUDE.md`/`AGENTS.md`, or the actual gate scripts, those sources win.

## 0. Orient yourself in the authority chain

The neutral execution-model contract — what *every* runner must satisfy — has no packet of its own. It is part of `tuvren.shared.core` authority (`spec/core/authority-packet.json`), specifically its `runner` binding section, per ADR-037. Read, in order:

- `spec/runners/README.md` — the runner port's directory map and history.
- `spec/runners/typespec/main.tsp` — the neutral, serializable runner operation/payload surface (`RunnerExecutionContext`, `RunnerExecutionResult`, the resolution union, the `runner.*` operation names). Note that this TypeSpec models only the portable subset: fields whose live TypeScript shape includes callables or `AbortSignal` (e.g. `AgentConfig`, `HandoffContextPlan`) remain packet-level opaque metadata, refined by the binding contract plus its runtime validators.
- `spec/runners/bindings/typescript.md` — the TypeScript binding appendix. `@tuvren/core/runner` is the binding projection of the neutral contract; concrete runner factories, callable hooks, `Promise`, and `AbortSignal` are binding conveniences only.
- `docs/KrakenFrameworkSpecification.md` §5.6 "Runner Contract" — the human-authored normative text behind the event-emission and reconciliation rules in §3 below.
- The neutral conformance plans: `spec/conformance/runners/plans/runner-api-core.json` and `runner-api-extended.json` (both `packetId: "tuvren.shared.core"`, capability `framework.runner-api`). These encode what any runner must do; the sibling `react-runner-*.json` plans encode ReAct-only behavior (see §5).
- `spec/runners/react/authority-packet.json` — the shape your own runner's packet should imitate if it needs one (see §4).

## 1. Implement `RuntimeRunner` against the neutral contract

The entire contract a runner implements is `RuntimeRunner` from `@tuvren/core/runner` (source: `typescript/core/src/lib/runner-contract-shapes.ts`):

```ts
export interface RuntimeRunner {
  execute(context: RunnerExecutionContext): Promise<RunnerExecutionResult>;
  readonly id: string;
  resume?(context: RunnerResumeContext): Promise<RunnerExecutionResult>;
}

export interface RuntimeRunnerFactory {
  create(): RuntimeRunner;
  readonly id: string;
}
```

The smallest possible valid runner is real code in this repo — `createStaticRunner` in `typescript/conformance-adapter/src/framework-adapter-runtime.ts`:

```ts
export function createStaticRunner(
  execute: (context: RunnerExecutionContext) => RunnerExecutionResult | Promise<RunnerExecutionResult>
): RuntimeRunner {
  return { execute(context) { return Promise.resolve(execute(context)); }, id: RUNNER_ID };
}
```

`execute` receives a `RunnerExecutionContext`: immutable snapshots of `config` (the agent's `AgentConfig`), `messages`, `manifest` (context manifest), and `toolRegistry`, plus identity (`threadId`/`branchId`/`turnId`/`schemaId`), `iterationCount`, an optional `signal: AbortSignal`, a `runtime: RunnerRuntimePort` (`emit`/`now`), and a `handoff: RunnerHandoffPort`. **The runner never mutates framework-owned state by aliasing context objects in place** — it influences framework state only through its returned `RunnerExecutionResult`.

`RunnerExecutionResult` carries `resolution` (required) plus optional `messages`, `partial`, `toolExecutionMode`, `assistantEventReconciliation`, and `stateUpdates`. `RuntimeResolution` is a five-way union: `continue_iteration`, `end_turn`, `pause` (with an `ApprovalRequest`), `handoff` (with a `HandoffContextPlan` built via `context.handoff.createContextPlan(...)`), and `fail` (with `error` and `fatality: "hard" | "soft"`).

The exact validation rulebook for results is `typescript/core/src/lib/runner-contract-guards.ts` — shared core calls `assertRunnerExecutionResult` on every result you return (`typescript/runtime/src/lib/runtime-core-runner-support.ts`), so treat these invariants as conformance requirements, not suggestions:

- Only the six result keys above are allowed; extra keys throw `invalid_runner_result`.
- `messages`, when present, may contain **at most one assistant message**, and that message must not contain a `tool_result` part. Pre-staged provider-owned tool messages (role `"tool"` with `providerMetadata.owner === "provider"`) don't count toward the limit.
- `toolExecutionMode` (`"parallel"` or `"sequential"`) is **required** iff the assistant message requests tool calls, and **forbidden** otherwise.
- If the returned messages request tool calls, `resolution.type` must be `"continue_iteration"` (a failed partial tool call is the one exception); `pause` requires tool-call messages to exist.
- `partial: true` is only valid when `resolution.type === "fail"` **and** an assistant message is staged.
- Per-resolution key allow-lists apply (e.g. `handoff` requires `contextPlan.targetAgent === targetAgent`; `fail` requires `error instanceof Error`).

Prefer returning `{ resolution: { type: "fail", error, fatality: "hard" } }` over throwing: shared core catches a thrown `execute`/`resume` and synthesizes a hard fail, but an explicit fail resolution is the controlled path and is what ReAct does (`typescript/runners/react/src/lib/react-runner.ts` normalizes all errors into fail resolutions at the top of `execute`/`resume`).

**What is deliberately NOT required:**

- `resume(...)` is optional and outside the current shared-core execution path — approval resume is handled by the framework around the paused tool batch. Implement `resume` only if your runner returns `pause` resolutions and wants runner-owned resume semantics (ReAct does; see `validateResumeApprovalContext` for its decision-to-pending-call matching rules).
- ReAct's extension-hook system (`beforeIteration`/`aroundModel`/`aroundTool`/`afterIteration`, implemented in `react-runner-around-model.ts`) is a ReAct implementation choice, not part of `RuntimeRunner`. A new runner may ignore `config.extensions` entirely or implement a different hook model.
- Telemetry integration: shared core wraps turn/iteration execution with telemetry spans generically; a runner needs no telemetry wiring of its own.
- Tool execution: the runner never executes tools itself. It requests execution by returning an assistant message with `tool_call` parts plus `resolution: { type: "continue_iteration" }` and a `toolExecutionMode`; the framework's Tool Execution Gateway dispatches the batch and re-invokes the runner next iteration with results folded into `context.messages`. The one exception is provider-native/provider-mediated tool results (`TuvrenModelResponse.providerToolResults`), which the runner pre-stages itself as a provider-owned `tool` message.

## 2. Decide the package home and shape it like `@tuvren/runner-react`

New runners live under `typescript/runners/<name>/` (there is no Rust runner home yet — `spec/runners/bindings/rust.md` records that Rust runner bindings are not implemented; read `docs/guides/add-a-language.md` first if you're bringing a runner in a new language). Match `typescript/runners/react`'s shape:

- `package.json`: `"name": "@tuvren/runner-<name>"`, `"type": "module"`, an `exports["."]` map pointing at `./dist/index.d.ts` / `./dist/index.js`, and `@tuvren/core` as a **peerDependency** (`"workspace:~"`), never a bundled dependency — every runner shares the host's single `@tuvren/core` instance (ADR-037). Bundle real dependencies only for genuinely embedded libraries (react-runner bundles `ajv` for structured-output validation).
- `project.json`: `name: "runner-<name>"`, `projectType: "library"`, `tags: ["boundary:framework", "layer:implementation"]` — note there is no `layer:certification` tag on a runner package; certification rides the framework adapter (§6). Targets: `build` (tsup + `tsc --project tsconfig.dts.json` + a smoke import), `test` (`bun test`), `typecheck` (`bun tools/scripts/typecheck-project.ts typescript/runners/<name>`), `lint` (biome).
- The five tsconfig files (`tsconfig.json`, `tsconfig.lib.json`, `tsconfig.dts.json`, `tsconfig.tsup.json`, `tsconfig.typecheck.json`) — copy react-runner's set rather than improvising. Any package whose typecheck config needs to resolve `@tuvren/runner-<name>` must add a `paths` entry for it, following the existing `"@tuvren/runner-react": ["../../runners/react/src/index.ts"]` pattern.
- Keep the entrypoint small and explicit (`CLAUDE.md`): react-runner's entire `src/index.ts` is two export statements — the factory (`createReActRunner`), the id constant (`REACT_RUNNER_ID`), and the option types.
- Export a factory function returning `RuntimeRunnerFactory` — `create<Name>Runner(options?): RuntimeRunnerFactory` — not a bare class. Hosts pass the factory instance into `createTuvren({ runner: ... })`; per ADR-057 there is no `"react"`-style kind-string shorthand and no implicit default runner, so the factory is your public API.
- Optionally a `BUILD.bazel` shim (`native_binary` wrapping `tools/bazel/nx-run.sh`), copied from react-runner's.

## 3. Honor the event-emission contract

`context.runtime.emit(...)` is a runner-owned streaming surface, not a framework-lifecycle backdoor. The framework specification's ruling (`docs/KrakenFrameworkSpecification.md` §5.6):

> Runners may use it for custom events and assistant/provider stream-content events only. Shared-core lifecycle events such as `turn.*`, `iteration.*`, `tool.*`, `approval.*`, `state.*`, `error`, and similar framework-owned control events are emitted only by shared core itself.

So a runner may emit exactly: the assistant stream-content family (`message.start`, `text.delta`/`text.done`, `reasoning.delta`/`reasoning.done`, `structured.delta`/`structured.done`, `file.done`, `tool_call.start`/`tool_call.args_delta`/`tool_call.done`, `message.done`) and `custom` events. Everything else is shared core's.

Two further rules govern the relationship between emitted events and the durable assistant message you return:

- **Reconciliation**: if you emit assistant content events, the live-emitted sequence must reconcile to the durable assistant message in `result.messages` — same `messageId`/`callId` identity, canonical `message.start` → … → `message.done` ordering, matching `finishReason`. Shared core rejects results that don't reconcile. The single sanctioned exception is `aroundModel` post-stream replacement: when a wrapper replaced the response after a live stream already went out, set `assistantEventReconciliation: "allow_final_sequence_divergence"` and shared core relaxes to "valid standalone assistant message" — but only when a handler exists, content events were actually emitted, the durable message actually diverges, and neither side requests tools.
- **Emitting is optional**: if you return a durable assistant message without emitting matching stream events, shared core synthesizes the canonical event sequence from the durable message. A simple runner can skip streaming entirely and still be fully event-stream conformant.

If you do stream, react-runner is the reference for both directions: `react-runner-stream.ts` maps live provider chunks to events via a `StreamAccumulator` (emitting `message.start` first and synthesized terminal events, including under cooperative cancellation with `partial: true`), and its `synthesizeAssistantEvents()` is the authoritative `ContentPart` → event mapping for the non-streaming "generate" mode. ReAct buffers synthesized sequences and only flushes them after the iteration resolves successfully — that buffering is what makes `aroundModel` replacement possible before anything is durably committed.

## 4. Decide whether you need new authority, and where it lives

The neutral `RuntimeRunner` contract is already covered by `tuvren.shared.core` and the `runner-api-*` plans — a new runner that simply honors the same contract does **not** need to touch `spec/core/`. Create a nested sub-surface packet only when your runner introduces genuinely new authority-level claims a downstream implementation must conform to (ReAct's extension-hook ordering and post-stream replacement semantics are exactly such claims).

If you do, mirror `spec/runners/react/authority-packet.json` at `spec/runners/<name>/authority-packet.json`: `packetId: "tuvren.framework.<name>-runner"`, `boundary: "framework"`, `surface: "<name>-runner"`, `humanAuthorityRefs` pointing at the framework spec's runner-contract section (extend `docs/KrakenFrameworkSpecification.md` first if your semantics are genuinely new), `authoritativeSources`/`conformancePlans`/`verificationPaths` pointing at your new plans, `bindingProjections: { "typescript-<name>-runner": "typescript/runners/<name>" }`, and a `forbiddenAuthoritySources` list naming your implementation, certification, and conformance-adapter paths plus `docs` and `.constitution` — implementation trees are binding projections, never authority sources.

## 5. Add conformance plans and fixtures

The runner conformance surface is two-tier, and the boundary between the tiers is a hard repo rule (`AGENTS.md`): **"Keep ReAct-specific behavior in ReAct authority packets and plans, not neutral runner plans."**

- **Neutral tier** — `spec/conformance/runners/plans/runner-api-core.json` and `runner-api-extended.json` (capability `framework.runner-api`, `packetId: "tuvren.shared.core"`). These exercise what every runner must satisfy: `runner.execute` resolution shape, `runner.resume` approval handling (including the fail path for a missing pending call), error-envelope shape on provider failure, and loop-policy hard-fail semantics. Your new runner should be able to pass these as-is.
- **Runner-specific tier** — plans owned by your runner's own packet, mirroring `react-runner-callables.json` / `react-runner-extended.json` (capability `framework.react-runner`, `packetId: "tuvren.framework.react-runner"`). ReAct's hook-count and phase-ordering checks live here precisely because the hook chain is ReAct's own behavior. Your runner's behavioral quirks go in your own `<name>-runner-*.json` plans with your own `framework.<name>-runner` capability — never folded into the neutral plans.

Follow the react plans' shape: `planId`, `planVersion`, `packetId` back-reference, `applicability.capabilities: ["framework.<name>-runner"]`, `scenarios` pointing at a scenario fixture, and `checks[]` with `checkId`, `operation` (`runner.execute`/`runner.resume`/`runner.checkpoint`), `scenario` + `input.scenarioPath`, `assertions[]`, and `evidence[]`. Keep assertion kinds matched to the data source actually evaluated (`AGENTS.md`: "Make assertion names match the data source the runner actually evaluates"). Reuse the shared scenario fixture `spec/conformance/runners/scenarios/runner-api-scenarios.json` when your scenarios fit its shape (`operation`, `providerResponses`, `pendingToolCalls`, `approvalDecisions`, `loopPolicy`, `streamChunks`); add a new fixture file only for genuinely new scenario shapes.

## 6. Certification wiring

The ReAct runner has **no standalone certification project**. It is exercised through the framework boundary's existing pair: the `framework-typescript-certification` Nx project (`typescript/certification/project.json`) invokes the shared harness against `typescript/conformance-adapter/adapter.json`, and that adapter's `src/framework-adapter-runner.ts` imports `createReActRunner` directly to dispatch `runner.execute`/`runner.resume`/`runner.checkpoint` operations. Extend the same seam for a new runner:

- Add your capability string (`"framework.<name>-runner"`) and, if you created one, your authority packet path to `typescript/conformance-adapter/adapter.json`'s `capabilities`/`authorityPackets` arrays.
- Add a dispatch module analogous to `framework-adapter-runner.ts` (or extend it) that constructs your runner and handles your plans' operations, wired into the operation switch in `typescript/conformance-adapter/src/framework-adapter.ts`.
- Only stand up a new certification project — and register it in `tools/conformance/certification/certified-projects.json`, per `docs/guides/add-a-language.md` §3–4 — if your runner genuinely needs an adapter/runtime combination the framework certification project can't host.

Whichever path you take, adapter discipline applies unchanged: the adapter never receives a `checkId`, never exposes `emitEvidence`, never decides pass/fail, and never maps protocol failures into `$.result.error` (`tools/conformance/adapter-protocol/protocol.md`; see also `docs/guides/how-conformance-works.md`).

## 7. Wire it into a host

Hosts select runners explicitly, by instance (ADR-057 — instances only, no string shorthand):

```ts
import { createTuvren } from "@tuvren/sdk";
import { createMyRunner } from "@tuvren/runner-my";

const tuvren = createTuvren({
  backend,
  runner: createMyRunner(),
  // ...
});
```

`createTuvren` builds a `RunnerRegistry` from the instance you pass and sets `defaultRunnerId` to its `id` (`typescript/sdk/src/lib/create-tuvren.ts`). At execution time, shared core resolves the runner from the registry and materializes it via `materializeRunner` (`typescript/runtime/src/lib/runner-registry.ts`), which calls `.create()` on factories and validates the result with `assertRuntimeRunner`. Registration requires a non-empty, unique `id` — duplicate ids throw `duplicate_runner_registration`. Multi-runner registries exist for orchestration scenarios, but a runner package's job ends at exporting a well-behaved factory.

Unit-test the runner with `bun:test` under `typescript/runners/<name>/test/`, following react-runner's helpers (`test/react-runner-test-helpers.ts` constructs a full fake `RunnerExecutionContext` — `handoff`, `manifest`, `messages`, `runtime.emit`/`now`, `toolRegistry`).

## Prove it green

```sh
bun run nx run runner-<name>:build
bun run nx run runner-<name>:test
bun run nx run runner-<name>:typecheck
bun run conformance    # exercises framework-typescript-certification, which now covers your runner's operations
bun run codegen        # includes validate-adapter-protocol + validate-certification-discovery
bun run check
bun run verify         # full release gate, before claiming broad readiness
```

## See also

- `docs/guides/add-a-driver.md` — authoring a resource adapter ("driver") rather than an execution strategy, and the canonical terminology section for the driver/runner split.
- `docs/guides/how-conformance-works.md` — the shared conformance engine, adapter protocol, and evidence model your runner's plans run through.
- `docs/guides/add-a-language.md` — bringing a new language implementation (adapter + certification wrapper) into the tree, prerequisite reading for a first non-TypeScript runner.
- `spec/runners/README.md` — the runner port's own authority map.
- `docs/KrakenFrameworkSpecification.md` §5.6 — the normative runner contract text.
