# Kraken Runtime — Repo Conventions

## First reads

1. Read `docs/KrakenKernelSpecification.md` first.
2. Read `docs/KrakenFrameworkSpecification.md` whenever the task touches framework behavior.
3. Read `constitution/Tasks.md` for active scope and ticket order.
4. Read `constitution/TechSpec.md` for tooling, structure, and package conventions.

## Project guard rails

- The kernel/framework specs in `docs/` are the behavioral source of truth.
- The constitution docs define product, architecture, implementation posture, and execution scope.
- Do not invent contract details that are missing upstream.
- Do not introduce provider-specific concerns into core primitives.
- Do not add abstractions just for future extensibility.
- Read files fully before changing behavior; do not reason from partial snippets.

## Workspace conventions

- Use `bun` as the package manager and runtime entry point.
- Use `devenv init` for `devenv` scaffolding; do not hand-roll initial `devenv` files.
- Track lockfiles in git, including `bun.lock` and `devenv.lock`.
- Use Biome directly for formatting/linting; the Ultracite preset is configuration, not the execution path.
- Keep root scripts workspace-wide and minimal.
- Use Nx for per-project actions; do not duplicate project execution commands into inner package `package.json` scripts unless there is a specific reason.
- Keep inner package manifests lightweight and project-focused.
- Do not point package runtime `exports` at source `.ts` files; package boundaries should target built artifacts, while local development wiring can rely on TypeScript path mapping and Nx.
- Treat `typecheck` as a no-emit validation step; artifact generation belongs to explicit build flows.
- When adding Nx targets or inference, keep them aligned with the TechSpec so the scaffold does not silently standardize on the wrong build tool.

## Monorepo shape

- Keep the repo architecture-first at the top level.
- `boundaries/` is the implementation tree.
- `shared/` stays small and only contains truly cross-boundary primitives.
- Add package manifests only for currently active scope; do not scaffold deferred packages early.
- Preserve the current naming convention for internal packages:
  - `@kraken/shared-*` for shared contracts
  - `@kraken/kernel-*` for kernel contracts/testkits
  - `@kraken/backend-*` for backends

## Delivery conventions

- Git branches should use `type/description`, for example `feat/epic-a-workspace-scaffold`.
- Prefer descriptive commit messages over terse placeholders.
- PR bodies should be comprehensive by default: what changed, why, scope boundaries, and validation.
- Do not include tool/agent branding in commits, branch names, PR titles, or PR bodies unless explicitly requested.
