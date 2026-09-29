---
id: ADR-0070
status: accepted
date: 2026-09-29
supersedes: [ADR-0012]
certainty: settled
evidence:
  kind: ruling
  ref: .constitution/reports/2026-09-29-interview-tech-spec.md
  date: 2026-09-29
  note: "Rulings 5, 6, 9, 16 and 17; adoption cost measured by SPK-KRT-OD006."
---
### ADR-0070 OXC Replaces Biome for TypeScript Lint and Format

- **Status:** accepted. Supersedes ADR-0012. The `tsup` build decision in ADR-0012 is retained unchanged by this record.
- **Context:** ADR-0012 fixed Biome with the Ultracite Biome preset for TypeScript linting and formatting, and `tsup` for package builds. Biome runs through 41 per-project `lint` targets, four generator scripts and about six artifact targets that pipe output through `biome check --write`. Ultracite ships OXC presets (`ultracite/oxlint/core`, `ultracite/oxfmt`) that plain `oxlint` and `oxfmt` consume with no Ultracite CLI. The repository is heavily agent-driven, so a strict shared preset is preferred to a repository-local rule policy that would become a place for workarounds. SPK-KRT-OD006 measured the cost on this repository: the formatter changes 463 files (+941 and −317 lines, idempotent, `spec/` JSON unchanged), and the preset unchanged reports 15,933 lint errors across 97 rules, with `no-use-before-define` (4,750) and `func-style` (4,010) not auto-fixable.
- **Decision:**
  1. **Use `oxlint` and `oxfmt` natively for TypeScript and JSON.** Both run as their own binaries. The Ultracite CLI is not used. `ultracite` remains a devDependency for its config presets only, bumped to the latest version when the migration lands.
  2. **Adopt the presets as shipped.** The repository config is `oxlint.config.ts` extending `ultracite/oxlint/core` and `oxfmt.config.ts` spreading `ultracite/oxfmt`. There are no rule overrides and no parity overrides. The only additions are ignore patterns (the preset's own list repeated, because `extends` does not pass `ignorePatterns` through, and `.constitution/**`). The formatter excludes Markdown, YAML and TOML.
  3. **Enable type-aware linting.** Run `oxlint` with `--type-aware` and `oxlint-tsgolint`, because the preset enables 54 type-aware rules that are otherwise silently skipped. The prerequisites are a `tsconfig.typecheck.json` reference in the package tsconfigs, three new tsconfigs, and a typecheck config for the three conformance adapter packages.
  4. **Migrate suppressions.** Biome suppressions become `oxlint-disable` comments where the rule still fires (82 of 144 at measurement time) and are deleted where the rule reports nothing (62). The gate reports unused suppressions.
  5. **Land the formatter as one mechanical reformat commit.** It is exempt from the merged-diff budget and is listed in `.git-blame-ignore-revs` by a follow-up commit that records its merged SHA. Generators call `oxfmt` instead of Biome and regenerate their outputs once through the new pipeline. `oxfmt` layout of JSON depends on the input layout, so the regeneration is part of the same change. SHA-pinned evidence under `.constitution/` is excluded from both tools.
  6. **Ratchet the lint cleanup by directory.** Each project's lint target switches from Biome to `oxlint` once its directory is clean. The first directory is a pilot for the `func-style` and `no-use-before-define` reordering. A runtime or conformance regression there stops the work and returns those two rules to the owner instead of overriding them. Biome and `@biomejs/biome` are removed after the last directory switches.
  7. **Keep `tsup`.** Package builds are unchanged.
- **Alternatives considered:**
  - Keep Biome and hold ultracite at 7.4.x. Rejected by the owner because the toolchain direction is OXC.
  - Adopt the presets with repository overrides for Biome parity. Rejected: the four rules behind 68% of the diagnostics would be switched off, which is the workaround the owner ruled out.
  - Run `oxlint` without `--type-aware`. Rejected: it drops 54 of the preset's rules, which is not "as shipped" in effect.
  - Formatter only, keeping Biome for lint. Rejected: two toolchains indefinitely.
  - No second design was requested. The owner ruled the choice in the session and the cost was measured by a spike.
- **Consequences:** Assumed until observed. `oxfmt` is in beta (0.71.0 on 2026-09-29), so a beta release may change JSON layout for `spec/**` artifacts and reopen generator stability. Type-aware linting requires TypeScript 7 semantics through `oxlint-tsgolint`, and dependencies must be built before it runs, which affects ordering in the task graph (ADR-0071). The lint cleanup is far beyond one epic's diff budget and is split by directory. `func-style` combined with `no-use-before-define` forces reordering of about 2,180 top-level definitions, which could change module initialization order, so the pilot gate exists. The temporary Dependabot ignore for ultracite above 7.4.2 is removed when the manual bump lands.
