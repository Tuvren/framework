# Repository Guidelines

## Project Structure & Module Organization
This is an architecture-first TypeScript monorepo. Runtime code lives under `boundaries/`:
- `boundaries/framework/` for shared runtime contracts and implementations
- `boundaries/kernel/` for kernel contracts, backends, and `testkit`
- `boundaries/providers/` for provider-facing contracts
- `boundaries/shared/` for truly cross-boundary primitives

Working plans live in `constitution/`. Engine-level specs live in `docs/`. Shared fixtures and scenario assets live in `tests/`. Tooling scripts live in `tools/`.

## Source of Truth
Align behavior changes with `docs/` and implementation changes with `constitution/`.
- Read `docs/KrakenKernelSpecification.md` before changing kernel behavior
- Read `docs/KrakenFrameworkSpecification.md` before changing framework behavior
- Use `constitution/TechSpec.md` and `constitution/Tasks.md` to keep implementation and active scope aligned

Do not invent behavior, contracts, or scope that conflict with those sources.

## Build, Test, and Development Commands
- `bun run lint` checks formatting and lint rules with Biome
- `bun run format` applies Biome fixes
- `bun run typecheck` runs Nx typechecks across the workspace
- `bun run nx run <project>:test` runs a package test target, for example `bun run nx run framework-runtime-api:test`
- `bun run nx graph` opens the Nx project graph

Use `bun` for package management and runtime entry points. Use Nx targets for package-scoped work instead of ad hoc inner-package scripts.

## Coding Style & Naming Conventions
Formatting and linting are owned by Biome. Keep package entrypoints small and explicit, and prefer Nx target wiring over package-local script sprawl.

Name boundaries matter:
- `Tuvren` is the product and host-developer surface: package names, imports, public runtime APIs, and examples
- `Kraken` marks engine internals and subsystem wrappers such as `KrakenKernel` and `KrakenDriver`

If a change makes ordinary library consumers type `Kraken*`, treat that as a boundary check.

## Testing Guidelines
Tests use Bun (`bun test`) and, for some Node-bound targets, package-specific Nx commands. Keep test files near the package they verify under `test/`, and run the narrowest relevant target first before broadening to workspace checks.
