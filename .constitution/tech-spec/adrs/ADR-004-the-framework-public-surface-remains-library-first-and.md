### ADR-004 The Framework Public Surface Remains Library-First and Driver-Neutral

> **Path/terminology note (2026-07, epic #87, M10.3b):** This ADR is a historical decision record; its body below is preserved verbatim and is not rewritten. Epic #87 renamed "driver" → "runner" repo-wide (e.g. the ReAct Driver → the ReAct Runner, `@tuvren/driver-api` → the `@tuvren/core/runner` subpath, `driverId`/`DriverKind` → `runnerId`/`RunnerKind`) and relocated `boundaries/<area>/...` paths into `spec/<port>/...` (language-neutral authority) plus `typescript/<area>/...` / `rust/<area>/...` (language-specific implementations); `implementations/<lang>/` subtrees moved to top-level `typescript/`/`rust/` trees. Any `driver` term or `boundaries/`-rooted path below reflects the pre-epic-#87 name or location as of this decision's date; see `.constitution/tech-spec/guidelines.md` and `.constitution/tech-spec/stack.md` for the current map. This note does not change the decision recorded below.

- **Status:** accepted
- **Context:** Tuvren Runtime is a framework product for developers to embed, while Kraken remains the engine identity behind it. The architecture’s host boundary is an embedding surface.
- **Decision:** The primary TypeScript framework surface remains a library API centered on `TuvrenRuntime`, `ExecutionHandle`, typed events, driver selection, provider ports, and backend ports.
- **Consequences:** HTTP, WebSocket, CLI, editor, and protocol adapters are secondary packages layered over the library API. This does not weaken the protocol-first kernel boundary because the library surface sits above it, and it prevents the first driver from becoming the only host-facing abstraction.

