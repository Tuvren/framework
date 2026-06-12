### ADR-003 Ship as a Modular Monorepo of Boundary-Owned Projects, Not as Multiple Services

- **Status:** accepted
- **Context:** The architecture is explicitly modular but intentionally in-process and solo-developer-friendly.
- **Decision:** Realize the approved logical containers as projects in one monorepo, grouped first by architectural boundary and then by contract versus implementation, rather than as separate deployable services.
- **Consequences:** Boundary discipline is preserved without adding network topology, deployment orchestration, or remote protocol complexity before it is justified. The repository structure mirrors the architecture docs instead of centering JavaScript package-manager conventions.

