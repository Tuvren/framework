---
id: ADR-0012
status: accepted
date: 2026-09-03
certainty: assumed
assumption: "Migrated; the decision's ruling reference was not found in the status line."
---
### ADR-012 TypeScript Tooling Uses Biome and tsup

- **Status:** accepted
- **Context:** The project explicitly prefers Bun-based workflows, Biome, and `tsup`.
- **Decision:** Use `@biomejs/biome@2.4.10` for linting and formatting and `tsup@8.5.1` for package builds.
- **Consequences:** The implementation posture is no longer ambiguous or tool-default-driven. Config, scripts, and examples must reflect this choice directly.

