# Interview record: TechSpec, toolchain epics (2026-09-29)

Target: TechSpec (Stage 3, Evolution mode). Pass: full sweep. Scope: three toolchain epics chained in order, Bun 1.4.x upgrade and blast-radius fixes, OXC replacing Biome and the ultracite CLI, and Bazel replacing Nx.

This record is a log. Its rulings reach the constitution through the Stage 3 pass that runs next, cited as `ruling` evidence. Spike files are cited as `spike` evidence, and the pinned sources below as `external` evidence.

## Calibration and method

Domain complexity was judged high: five language ports, codegen through proto, TypeSpec and Weaver, one Bazel island, one Nx graph, and five ADRs the migration supersedes or constrains. The user picked the full pass. Four read-only recon subagents (Sonnet) inventoried Nx and Bazel, Biome and ultracite, Bun 1.4 evidence, and the constitution and CI touchpoints. An Opus advisor reviewed the whole plan for blind spots. Three grounding subagents (Sonnet) pinned external facts. Three decision-owned spikes ran on Opus in throwaway worktrees.

## Rulings

Numbers follow the order asked in the session.

1. Bazel is the single task graph, cache and affected-detection layer. TypeScript actions execute Bun (`bun test`, `tsup`, `tsc`). Every other language uses Bazel-native rulesets, subject to the spike evidence in OD-07. The user first chose native-wrapped actions for all languages and then corrected the meaning of "native" on the Rust question: Bazel-native rules for everything except TypeScript. Language lockfiles and toolchain versions stay authoritative. Ruling: hybrid, Bazel-native rules for Rust, Go, Python, Dart and protobuf where a ruleset works, Bun-executed actions for TypeScript only.
2. No remote cache. CI persists Bazel's disk and repository caches through `actions/cache` (ruling 11).
3. Service-dependent checks (Postgres, gRPC interop smoke, SQLite and Postgres scenarios, the Gemini scenario) are Bazel tests tagged `manual` and `external`, with environment passed through `--test_env`. `services:up` stays a manual session step. Bazel does not manage service lifecycles.
4. The `check`, `verify:kernel` and `verify` lane commands are retired in favor of `bazel test` suites. CLAUDE.md, `tech-spec/guidelines.md` and the NFC meters that quote those commands are rewritten. An affected-detection tool replaces `nx affected`.
5. OXC: ultracite's presets (`ultracite/oxlint/core`, `ultracite/oxfmt`) are consumed as a config-only devDependency. `oxlint` and `oxfmt` run natively. The ultracite CLI is not used. Ultracite is bumped to the latest version by hand, and the temporary Dependabot ignore for ultracite above 7.4.2 (PR #131) is removed then. The presets are adopted as shipped with no parity overrides, because strictness is desired to avoid workarounds in a heavily agent-driven repository. Type-aware linting is enabled, as the preset expects.
6. The formatter change is one large mechanical reformat commit, listed in `.git-blame-ignore-revs` by a follow-up commit that records the merged SHA. The reformat is exempt from the roughly 10,000 to 15,000 line merged-diff budget.
7. Three epics, one per workstream, chained by dependency and run strictly serially: Bun, then OXC, then Bazel. All three edit `package.json`, `devenv.nix`, `dependabot.yml` and `stack.yaml`, so they cannot run concurrently. The lint cleanup and the Bazel port each exceed the diff budget and split further at Stage 4.
8. CI job names are renamed to match reality. ADR-0069 is updated in the same change as the rename. The repository owner updates the branch protection setting.
9. oxfmt formats TypeScript and JSON only. Markdown, YAML, TOML, `.constitution/**` and SHA-pinned evidence are excluded.
10. The Nx to Bazel cut-over runs side by side during the Bazel epics. Nx is removed in the last milestone after parity is measured.
11. CI persists the Bazel disk cache and repository cache through `actions/cache`. Cache saving is disabled on pull requests.
12. Rust uses `rules_rust` for every crate. This is the user's correction of an earlier answer that chose native cargo actions under a different reading of "native". Native cargo actions are not used.
13. Bun 1.4 provisioning: a full nixpkgs refresh. It lands atomically with the Weaver manifest migration, because the devenv Weaver 0.21.2 cannot read `schema_url` and the migration cannot land first. Postgres stays pinned to major 17. Bun then moves to the latest 1.4.x.
14. The memory-backend `deepStrictEqual` failure is fixed in the backend by copying buffers on read and write, not by changing tests.
15. Proto outputs for TypeScript (`protoc-gen-es`) stay checked in, with a Bazel freshness test and a `bazel run` update target. There is no first-party Bazel rule for `protoc-gen-es`.
16. The lint cleanup runs directory by directory with a pilot gate. The first directory is the pilot for the `func-style` and `no-use-before-define` reordering. A runtime or conformance regression there stops the work and raises those two rules with the owner instead of overriding them.
17. OD-04 (does the deferred Bun upgrade block the release work) is closed: the release shipped as 0.2.0 on the retained toolchain, and the Bun upgrade becomes the first of the three epics.

## Spikes (decision-owned)

- OD-05, `spikes/SPK-KRT-OD005.md`: staged `node_modules` built by a `bun install` repository rule, sandboxed actions, a `dist` edge for build only, source resolution for typecheck and test. The in-tree `no-sandbox` variant served wrong cached results under tampering. `linux-sandbox` is unavailable on this NixOS host, and CI behavior is unverified.
- OD-06, `spikes/SPK-KRT-OD006.md`: ultracite presets as shipped. Formatter cost is 463 files, +941 and −317 lines, idempotent, `spec/` JSON unchanged. Linter cost is 15,933 errors across 97 rules, with `no-use-before-define` (4,750) and `func-style` (4,010) dominating and not auto-fixable. Type-aware adds 54 rules and needs TypeScript 7 semantics through `oxlint-tsgolint`. Recommended split: toolchain and format, tsconfig prerequisite, lint by directory, Biome removal.
- OD-07, `spikes/SPK-KRT-OD007.md`: Rust, Go and Python adopt Bazel-native rules under both NixOS devenv and ubuntu conditions. Dart is the one recorded native-wrapped exception (rules_dart 0.6.6 cannot consume our `pubspec.lock` without a carried patch, and one test fails). Conditions: a hermetic C toolchain, protobuf 33.4 with the prebuilt protoc flag, pinned toolchains with sync checks, and a NixOS-only PATH accommodation.

## Corrections and facts established

- 41 `project.json` files call Biome (the first recon count of about 6 was wrong). There are 20 tracked `BUILD.bazel` files, 17 of them Nx shims (the advisor's count of 39 was wrong).
- `cbor-x` sets `dataView` as an own property on the buffer it decodes. Bun 1.4.0 made `node:assert` compare own-enumerable properties on typed arrays like Node, which exposed the memory backend's aliasing of stored buffers (bun PR 34660, merged 2026-08-07).
- The devenv shell provides Weaver 0.21.2, Postgres 17.9 and Bun 1.3.10. The `schema_url` manifest change arrived in Weaver 0.22.1.
- The developer machine is NixOS 26.11 with `nix-ld` enabled.
- The stack pins for Biome, Nx and the Rust crates drifted after the dependency PRs merged, and `packageManager` (`bun@1.3.11`) disagrees with the installed Bun (1.3.10) and with `stack.yaml` (1.4.2, assumed). `derive --write` fixes the mechanical pins as its own commit.
- The `ultracite/oxfmt` export exists from ultracite 7.5.0. The temporary Dependabot ignore above 7.4.2 only stops the bot and does not block a manual bump.

## Design decisions handed to Stage 3

- New ADRs: superseding ADR-0012 (Biome and tsup, lint and format clause only), superseding ADR-0013 (Nx orchestration, the devenv half survives), amending ADR-0017 (executors become Bazel rules, lockfiles and toolchain versions stay authoritative, Bun and Dart are the documented exceptions), updating ADR-0027 (freshness gate must be expressed as Bazel actions plus a diff test, and the authority packets' `regenerateCommand` fields name Nx commands), and updating ADR-0069 (CI check names, Dependabot ecosystems).
- Project identity: keep today's project names as Bazel target names, put tags in a Starlark macro, and have the discovery gates read a generated manifest or parse BUILD files statically.
- Gates that read git (`worktree-guard`, `changeset-check`, `check`, `publish-registry`, `kernel-interop-governance`) run as `bazel run` targets or plain CI steps, not sandboxed tests.
- The release pipeline builds through Bazel and publishes from a staging directory. `release.yml` keeps its filename because npm trusted publishing matches on it.
- `spec/interop/proto/` needs a BUILD file, which conflicts with the recorded rule that `spec/conformance/kernel/fixtures/BUILD.bazel` is the only Bazel file under a `spec/` root. Stage 3 decides.
- Type-aware linting needs `--type-aware` and `oxlint-tsgolint`, a `tsconfig.typecheck.json` reference in 25 package tsconfigs, three new tsconfigs, and a typecheck config for the three conformance adapters.
- The lint cleanup ratchet switches each project's lint target from Biome to `oxlint` once its directory is clean.

## Pinned external sources (checked 2026-09-29)

- oxlint 1.86.0 and oxfmt 0.71.0 (beta, announced 2026-02-24): https://oxc.rs/docs/guide/usage/formatter.html and https://oxc.rs/blog/2026-02-24-oxfmt-beta
- oxlint type-aware linting and tsgolint: https://oxc.rs/docs/guide/usage/linter/type-aware.html
- oxlint suppression directives: https://oxc.rs/docs/guide/usage/linter/ignore-comments.html
- Ultracite with Oxlint and Oxfmt (config snippets): https://www.ultracite.ai/docs/provider/oxlint (ultracite 7.12.2)
- Bun 1.4.0, 1.4.1, 1.4.2 release notes: https://bun.com/blog/bun-v1.4, https://bun.com/blog/bun-v1.4.1, https://bun.sh/blog/bun-v1.4.2
- Bun assert typed-array comparison change: https://github.com/oven-sh/bun/pull/34660
- Weaver 0.22.1 manifest change and 0.26.1 latest: https://github.com/open-telemetry/weaver/releases
- Bazel release lines (9.2.0 latest, 9.x LTS): https://bazel.build/release
- rules_js issue on Bun runtimes (open, unfunded): https://github.com/aspect-build/rules_js/issues/1258
- bazel-diff v49.1.0 and target-determinator v0.34.0: https://github.com/Tinder/bazel-diff, https://github.com/bazel-contrib/target-determinator
- Dependabot Bazel ecosystem (Bazel 7, 8, 9): https://docs.github.com/en/code-security/dependabot/ecosystems-supported-by-dependabot/supported-ecosystems-and-repositories
- npm trusted publishing and the 2FA-bypass token change: https://docs.npmjs.com/trusted-publishers, https://github.blog/changelog/2026-07-08-npm-install-time-security-and-gat-bypass2fa-deprecation/

## Register changes

- OD-04: closed (ruling 17).
- OD-05, OD-06, OD-07: registered and closed by their spikes in this session.
- OD-01, OD-02, OD-03: unchanged, still open.

## Follow-up outside the constitution

- Pull request 131 holds ultracite at 7.4.2 in Dependabot until the OXC epic bumps it by hand.
- The repository owner updates the branch protection setting when the CI job names change.
