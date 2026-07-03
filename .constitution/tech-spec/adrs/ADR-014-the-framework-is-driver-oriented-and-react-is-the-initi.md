### ADR-014 The Framework Is Driver-Oriented and ReAct Is the Initial Driver

> **Path/terminology note (2026-07, epic #87, M10.3b):** This ADR is a historical decision record; its body below is preserved verbatim and is not rewritten. Epic #87 renamed "driver" → "runner" repo-wide (e.g. the ReAct Driver → the ReAct Runner, `@tuvren/driver-api` → the `@tuvren/core/runner` subpath, `driverId`/`DriverKind` → `runnerId`/`RunnerKind`) and relocated `boundaries/<area>/...` paths into `spec/<port>/...` (language-neutral authority) plus `typescript/<area>/...` / `rust/<area>/...` (language-specific implementations); `implementations/<lang>/` subtrees moved to top-level `typescript/`/`rust/` trees. Any `driver` term or `boundaries/`-rooted path below reflects the pre-epic-#87 name or location as of this decision's date; see `.constitution/tech-spec/guidelines.md` and `.constitution/tech-spec/stack.md` for the current map. This note does not change the decision recorded below.

- **Status:** accepted
- **Context:** The architecture now distinguishes shared framework services from concrete execution models. The current behavioral specification is strongly ReAct-shaped, but the product must support future workflow-oriented drivers over the same durable runtime foundation.
- **Decision:** Implement the framework as shared contracts plus shared runtime services, with concrete drivers as explicit implementation packages. The first driver is the ReAct Driver.
- **Consequences:** Package structure, task planning, and future implementation sequencing must separate shared framework logic from driver-specific logic. Future drivers can be added without redefining the kernel, host API, or provider-neutral content model.

