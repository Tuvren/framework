# Epic P Playground Host Closure Inventory

## Status

- Epic P is closed in current repo reality.
- Implementation package: `boundaries/hosts/implementations/typescript/playground`
- Workspace package: `@tuvren/playground-host`
- Package posture: private local harness, not a production web app or authentication boundary.

## Implemented Host Surface

- Embedded runtime host creation over `createTuvrenRuntimeCore`, the ReAct Driver, memory backend, SQLite backend, and deterministic playground providers.
- Public host operations for thread creation, branch creation from a head turn node, turn execution, approval resolution, cancellation, steering, runtime access, durable branch message/status inspection, and stream projection.
- CLI scenario runner through `src/cli.ts`, with environment and argument parsing for backend, provider mode, scenario, and SQLite path. The CLI exits non-zero when any boolean scenario check reports `false`.
- Package export smoke coverage for the private package entrypoint.

## Scenario Matrix

- `streaming`: canonical stream, SSE frames, and AG-UI events over a full turn lifecycle.
- `tools`: deterministic tool-call and tool-result flow.
- `approval`: approval pause, edited approval decision, resumed continuation, and durable tool continuation.
- `metadata`: AI SDK mock provider mode without credentials plus durable provider-metadata evidence.
- `structured`: structured-output scenario hook for the deterministic fixture provider.
- `branching`: branch creation from a completed source head, durable branch message inspection, and alternate branch execution.
- `cancel`: active turn cancellation and failed terminal stream observation.
- `steering`: host `steer` control path, durable steering message incorporation, and provider response to the injected steering signal.
- `reload`: SQLite reload through a fresh host instance after a completed turn, durable message visibility after reload, branch-head advancement, root preservation, and successful follow-up execution from the reloaded host.

## Backend Notes

- Non-reload memory backend scenarios run under Bun tests; reload evidence is reserved for the Node-backed SQLite smoke target.
- SQLite reload is validated through the built Node CLI target because `@tuvren/backend-sqlite` depends on `better-sqlite3`, which is Node-first and does not load under Bun.
- The playground kernel facade stores content-addressed objects, turn trees, and turn nodes idempotently by checking their hashes before writing, so replayed continuation records and repeated scenario runs do not collide on fresh timestamps.
- Root turn nodes include a per-thread bootstrap event hash. This preserves an empty initial manifest while satisfying SQLite's unique root-node constraint across repeated scenario runs.
- Run step indexes respect backend validation: running runs keep `currentStepIndex` on an available step, while completed runs store `currentStepIndex` equal to the declared step count.

## Stream Adapter Handoff

- Full-turn streams use tee-based fanout to canonical, SSE, and AG-UI projections.
- Approval resume emits a continuation fragment rather than a full `turn.start` to `turn.end` lifecycle. The playground projects resumed continuation streams to canonical and SSE only; AG-UI remains covered by full-turn streams and should not be asked to translate partial continuation fragments without a future adapter contract.
- Epic Q should preserve the single-consumer `ExecutionHandle.events()` rule and keep fanout above the handle with `teeTuvrenStreamEvents`.

## Type Safety Notes

- The playground implementation avoids type assertions and uses exported validators, assertion functions, discriminated unions, and local narrowing helpers instead.
- Kernel record conversion is explicit and rejects unsupported values instead of casting unknown data into protocol shapes.

## Validation Evidence

- `bun run nx run host-playground:typecheck`
- `bun run nx run host-playground:test`
- `bun run nx run host-playground:build`
- `bun run nx run host-playground:exports-smoke`
- `bun run nx run host-playground:scenario-sqlite`
- `bun run lint`

## Epic Q Handoff

- Extract reusable provider/framework test fixtures from the package-local playground and bridge tests only after deciding which fixtures are stable enough to share.
- Add release checks that include private-package export smoke coverage and the Node-backed SQLite scenario path.
- Record runtime portability honestly: core non-native packages can be tested across Bun and Node, while SQLite remains Node-scoped until its native dependency story changes.
