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

## Tailored code standards

This repository follows Ultracite's code standards as a baseline, tailored to Kraken Runtime's package and boundary structure. Formatting is intentionally owned by the repository's configured tooling; do not force a personal formatting style when Biome or the project config says otherwise.

### Core expectations

- Write code that is accessible, performant, type-safe, and maintainable.
- Prefer clarity and explicit intent over brevity.
- Keep behavior aligned with the constitution docs and authoritative specs before optimizing for elegance.

### Type safety and JavaScript/TypeScript

- Prefer `unknown` over `any` when the type is genuinely unknown.
- Use TypeScript narrowing and well-named helpers instead of broad type assertions.
- Use `const` by default, `let` only when reassignment is necessary, and never `var`.
- Prefer template literals, optional chaining, nullish coalescing, destructuring, and focused helper functions when they improve clarity.
- Use meaningful names and extracted constants instead of magic values.

### Control flow and async work

- Prefer `for...of` over `.forEach()` and index-based loops unless there is a clear reason not to.
- Prefer early returns over nested conditionals.
- Use `async` / `await` instead of promise chains when that improves readability.
- Await promises intentionally and handle async failures meaningfully.

### Errors, debugging, and safety

- Throw `Error` objects with descriptive messages, not strings.
- Remove `console.log`, `debugger`, and `alert` statements from committed production code unless the task explicitly requires them.
- Validate and sanitize untrusted input.
- Avoid `eval()`, direct `document.cookie` writes, and `dangerouslySetInnerHTML` unless explicitly justified.

### Package and module boundaries

- Avoid internal barrel files by default; import from the concrete module you need.
- A package entrypoint such as `src/index.ts` may intentionally re-export the curated public API of that package. Treat that as an API surface, not as permission to add convenience barrels elsewhere.
- Keep package entrypoints small and explicit.
- If a lint rule needs an exception for a package entrypoint, make it as narrow and local as possible.
- Package-local aliases such as `~/` belong to that package only; do not introduce workspace-wide aliases for package-private module layout.
- All source files must carry the repository's Google-style Apache 2.0 license header using the canonical project attribution text already present in the codebase.

### Tests and quality gates

- Write assertions inside `test()` / `it()` blocks.
- Do not commit `.only` or `.skip` unless the task explicitly requires it.
- Keep tests readable and reasonably flat.
- Passing linting is a hard requirement before handoff. Run the relevant Biome checks and do not leave known lint violations behind unless the user explicitly accepts them.
- Passing typecheck is also required for touched scope unless the user explicitly asks otherwise or the repo has an unrelated pre-existing failure you have called out clearly.

### Practical review posture

- Let the linter and formatter handle mechanical issues.
- Spend human attention on correctness, naming, edge cases, architecture, accessibility, and user-visible behavior.
- Document only genuinely non-obvious logic; avoid comments that restate the code.

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
