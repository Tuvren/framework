### ADR-013 Workspace Orchestration Uses devenv and Nx

- **Status:** accepted
- **Context:** The project explicitly fixed `devenv + nx` as non-negotiable workspace tooling and the repository now uses a boundary-grouped architecture-first layout.
- **Decision:** Use `devenv` as the reproducible developer environment entry point and pin `nx@22.6.3` with aligned `@nx/workspace@22.6.3` and `@nx/js@22.6.3` for orchestration of the TypeScript subtree.
- **Consequences:** Environment pinning lives in Nix/devenv configuration rather than npm manifests alone. Nx project orchestration is first-class, but limited to the TypeScript subtree and does not define the overall repository ontology.

