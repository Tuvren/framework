# Spike report: OD-07 Bazel-native rulesets for Rust, Go, Python, and Dart

## Effort budget

- **Budget:** 3 story points (decision-owned spike agreed in the 2026-09-29 tech-spec interview)
- **Spent:** 3 story points. Cut for budget: the `rules_rust_prost` path (the `cargo_build_script` path was proven instead), gofmt through `aspect_rules_lint` (nogo was proven instead), a failing-input check for ruff, the Python and Dart gazelle plugins, and a BUILD file for the `dart/kernel-certification` stub package.

## Question

- **Owner:** OD-07 (`.constitution/reports/open-decisions.yaml`)
- **Decision this spike must produce:** Which Bazel-native ruleset setup builds and tests our real lockfiles (Cargo.lock, go.work with no go.sum, uv.lock, pubspec.lock) for Rust, Go, Python, and Dart on both the NixOS devenv machine and ubuntu-like conditions? Which languages need a recorded native-wrapped exception? Decision rule agreed with the owner, applied without softening: a language adopts its Bazel-native ruleset only if the spike shows that ruleset building and testing our code in both environments. Otherwise the language becomes a recorded native-wrapped exception.

## Context and objective

- **Triggering upstream file or section:** `.constitution/reports/open-decisions.yaml` entry OD-07. It blocks the Bazel (Nx removal) epics, an ADR superseding `.constitution/tech-spec/adrs/ADR-0013-workspace-orchestration-uses-devenv-and-nx.md`, and an amendment to `.constitution/tech-spec/adrs/ADR-0017-native-toolchains-remain-authoritative-inside-each-impl.md`.
- **Target:** For each language, a bzlmod ruleset that consumes the committed lockfile, fetches its own toolchain, and runs the real package test suites in the default sandbox. The same test counts must come out as the native tool reports.
- **Archetype / surface:** Build and verification infrastructure for the multi-language kernel ports (`rust/`, `go/`, `python/`, `dart/`) and the protobuf interop surface (`spec/interop/proto`). TypeScript is out of scope by owner ruling.

## Codebase baseline

- **State today:** `MODULE.bazel` pins rules_rust 0.71.2 and has a single hand-written `rust/kernel/BUILD.bazel`. That file does not run the 27 unit tests in `rust/kernel/src/memory.rs`; it only runs `kernel_baseline_test`. The Cargo workspace has 6 members. `rust/kernel-grpc-service/build.rs` uses `tonic-prost-build` 0.14.5 with `../../spec/interop/proto` and needs `protoc`. The 3 Go modules have no `require` lines and no `go.sum`, so there are zero third-party Go dependencies. Two of the modules import `github.com/tuvren/framework/go/kernel` through `go.work` only. `go.work` pins `go 1.24.7`, while devenv provides Go 1.25.7. uv.lock holds 13 packages: 10 third-party and 3 workspace members. The root `pyproject.toml` is a virtual workspace root with no `[project]` table. Each member declares its own `dev` dependency group. pubspec.lock holds 51 hosted packages. The pub workspace members (`tuvren_kernel` and others) do not appear in the lock. devenv provides Dart 3.11.0 and Python 3.13.12. `.bazelrc` passes the host `PATH` into actions (`--action_env=PATH`).
- **Discovered constraints (measured):**
  - Bazel 9.1.1's own `bazel_tools` asks for protobuf 33.4, so every module in this set resolves to protobuf 33.4.
  - On this NixOS machine, Bazel registers only the `processwrapper-sandbox` spawn strategy. `--spawn_strategy=linux-sandbox` fails with "no strategy with that identifier was registered". The ubuntu container ran 797 actions under `linux-sandbox`.
  - Some actions do not inherit the default shell environment, so they get Bazel's fixed `/bin:/usr/bin:/usr/local/bin` PATH. NixOS has no `cat` or `touch` there. Two such actions failed on NixOS only: protobuf's `ProtocAuthenticityCheck` ("cat: command not found") and the `aspect_rules_lint` ruff aspect ("touch: command not found"). Both passed in the ubuntu container.
  - Adding a proto_library and buf lint needs a new `BUILD.bazel` under `spec/interop/proto/`. That conflicts with the recorded disposition that `spec/conformance/kernel/fixtures/BUILD.bazel` is "the one Bazel file under a spec/ root".

## Options and trade-offs

### Method

All scratch work was done in a throwaway worktree of master at `43a8888` and then discarded. Each configuration ran in three environments:

- **N (NixOS devenv):** `devenv shell -- bazel ...`, with the Nix toolchains on PATH and passed into actions.
- **S (NixOS scrubbed):** `env -i` with `PATH` set to only `/run/current-system/sw/bin` plus bazelisk, and a separate output base. The environment had no gcc, cc, python3, go, dart, rustc, cargo, uv, or protoc.
- **U (ubuntu:24.04 container, privileged, non-root user):** only gcc, g++, git, curl, ca-certificates, unzip, and zip were installed via apt, plus bazelisk 1.28.1. The container had no go, python3, dart, rustc, cargo, uv, or protoc.

The same targets ran in all three: `bazel test //rust/... //go/... //python/... //dart/... //spec/...`.

Final module set, all current on registry.bazel.build as of 2026-09-29:

- rules_rust 0.74.0
- rules_go 0.63.0 and gazelle 0.54.0 (rules_dart 0.6.6 forces gazelle 0.54.0 in any case; 0.51.3 is not the resolved version)
- rules_python 2.3.4
- aspect_rules_py 1.12.1 (the latest non-alpha; 2.0.0-alpha.7 exists)
- rules_dart 0.6.6 (single maintainer: aran; requires Bazel >= 9.0.0)
- rules_proto 7.1.0
- rules_buf 0.5.4
- aspect_rules_lint 2.9.1
- protobuf 33.4 (declared explicitly)
- hermetic_cc_toolchain 4.3.0 (used in S only)

### Per-language verdict table

| Language | Ruleset setup proven | N (devenv) | S (scrubbed NixOS) | U (ubuntu container) | Tests matched native count | Verdict |
|---|---|---|---|---|---|---|
| Rust | rules_rust 0.74.0, `crate.from_cargo` over Cargo.lock with all 7 manifests, toolchain 1.95.0 pinned in MODULE.bazel, `cargo_build_script` running the unchanged `build.rs` with `PROTOC` set to protobuf's prebuilt protoc 33.4 | yes: 5 of 5 test targets | yes, with hermetic_cc_toolchain (zig) registered; no, without any C toolchain | yes: 5 of 5 (host gcc) | yes: 78 test cases (27 + 40 + 3 + 2 + 6) | **adopt with caveats** |
| Go | rules_go 0.63.0, gazelle 0.54.0, `go_deps.from_file(go_work)`, `go_sdk.download(1.25.7)`, nogo with `TOOLS_NOGO` | yes: 3 of 3 | yes with zig cc; no without a C toolchain | yes: 3 of 3 | yes: 117 (107 + 9 + 1) | **adopt with caveats** |
| Python | rules_python 2.3.4: python-build-standalone 3.13 plus `pip.parse` over a `uv export --frozen` requirements file | yes: 1 of 1 | yes, with `bootstrap_impl=script`; no with the default bootstrap | yes: 1 of 1 | yes: 289 | **adopt with caveats (rules_python)** |
| Python (alternative) | aspect_rules_py 1.12.1: `uv.project` over uv.lock plus 3 `uv.override_package` entries | yes: 3 of 3 | yes: 3 of 3 | yes: 3 of 3 | yes: 289 + 8 + 1 | viable runner-up |
| Dart | rules_dart 0.6.6 with `pub.from_lock` over pubspec.lock, a local patch, and a root-named SDK 3.11.0 toolchain | 18 of 19 targets pass (1 fails) | 18 of 19 | 18 of 19 | kernel yes: 152; adapter 12 of 13 cases in `protocol_test.dart` | **recorded native-wrapped exception** |
| Protobuf lint | rules_buf 0.5.4 `buf_lint_test` (buf v1.66.1) on a new `proto_library` | yes, with `allow_nonstandard_protoc` | yes, with the same flag | yes, with no flag | n/a (a failing-input check failed as intended) | adopt with a NixOS-only flag |

### Rust

- **Crates expressed:** all 6 workspace crates were expressed (6 BUILD files, 168 lines). crate_universe handled every proc-macro (serde_derive, thiserror, tokio-macros, prost-derive) and every third-party build script with no annotations. None of the crates have native C dependencies.
- **gRPC crate:** `build.rs` is untouched. `cargo_build_script` sets `PROTOC` to the prebuilt protoc 33.4 and takes the `.proto` files through a filegroup in `spec/interop/proto`.
- **Why not rules_rust_prost:** rules_rust_prost 0.74.0 was not used. Its default toolchain ships prost 0.13 and tonic 0.12, but we are on 0.14. It would need a custom toolchain and a change to the `tonic::include_proto!` layout.
- **Toolchain on NixOS:** rules_rust's downloaded rustc 1.95.0 ran through nix-ld.
- **Linker:** on N, the host cc was autodetected and used gold, so every link prints "the gold linker is deprecated". This warning does not fail the build.
- **Caveat, no C toolchain:** with no C toolchain (environment S), `local_config_cc` autoconfiguration fails ("gcc" not found). Every Rust target, every Go target, and the rules_python test then fail analysis. Registering the zig toolchain from hermetic_cc_toolchain 4.3.0 and setting `BAZEL_DO_NOT_DETECT_CPP_TOOLCHAIN=1` makes all of them pass.
- **Caveat, toolchain pin:** rules_rust cannot read `rust-toolchain.toml`, so 1.95.0 is pinned in MODULE.bazel. A sync check between the two is required.
- **Clippy and rustfmt:** both ran through rules_rust's built-in `rust_clippy_aspect` and `rustfmt_aspect` with `clippy_flags=-Dwarnings` on 13 targets, and both passed in N and U. A failing-input check caught `clippy::let_and_return` and a rustfmt diff. aspect_rules_lint is not needed for Rust.
- **Rebuild behavior:**
  - A repeat run of the same targets: 5 action cache hits, 0 tests executed.
  - An edit to a leaf binary (`rust/kernel-conformance-adapter`): 2 actions, 0 of 5 tests re-run.
  - An unused `pub const` added to `rust/kernel`: 11 actions (10 sandboxed compiles), 0 of 5 tests re-run. The test binaries were byte-identical, so the test actions stayed cached. This is content-addressed caching working correctly.
  - A test-affecting edit: 13 actions, and exactly 1 of 5 tests re-ran.

### Go

- **gazelle:** gazelle 0.54.0 generated all 3 BUILD files. It took each import path from the module's `go.mod` with no `# gazelle:prefix`, and resolved the sibling-module import `github.com/tuvren/framework/go/kernel` to `//go/kernel` correctly. A repeat gazelle run left a hand-added `data` attribute in place (no diff).
- **Cross-module case:** the known cross-module problem did not show up here, because none of the modules has a third-party `require`. It is untested for the case where a non-root `go.work` module adds external dependencies.
- **Bootstrap order:** `go_deps.from_file(go_work)` fails until each module directory has a `BUILD.bazel` file ("BUILD file not found ... //go/kernel:go.mod").
- **Caveat, SDK version:** `go_sdk.from_file(go_work)` selects Go 1.24.7. Gazelle 0.54's own tools then fail to build with "go.work requires go >= 1.24.12". The SDK is therefore pinned to 1.25.7 (matching devenv), and a sync check against `go.work` is required.
- **Fixture data:** the `go/kernel` fixture tests need `data = ["//spec/conformance/kernel/fixtures:all"]`, added by hand.
- **nogo:** nogo with `TOOLS_NOGO` ran in the build. A failing-input check caught `fmt.Sprintf format %d has arg "x" of wrong type string (printf)`.
- **gofmt:** not tested through aspect_rules_lint. Its Go formatter default is gofumpt, not gofmt, so it needs a gofmt label.
- **Rebuild behavior:** an edit in `go/kernel` re-ran 2 of 3 tests. The certification test stayed cached.

### Python

- **rules_python 2.3.4:**
  - `uv export --frozen --all-packages --all-groups --no-emit-workspace` produced 10 pinned packages, all of which resolved (colorama is gated to Windows).
  - The python-build-standalone 3.13.13 interpreter ran directly through nix-ld. The cryptography manylinux wheel loaded under the hermetic interpreter.
  - **Caveat, bootstrap:** the default bootstrap launcher starts with `#!/usr/bin/env python3`, so it needs a system python3. In S it failed with "env: 'python3': No such file or directory". `--@rules_python//python/config_settings:bootstrap_impl=script` fixes this. U also passed with that flag and with no python3 installed.
  - **Caveat, derived file:** the requirements file (167 lines) is derived from uv.lock and needs a drift gate.
  - **Caveat, Python patch version:** Bazel ran 3.13.13 while devenv has 3.13.12.
  - **Caveat, test wrapper:** a small pytest entry point (10 lines) was needed.
- **aspect_rules_py 1.12.1:**
  - It reads uv.lock directly, but `uv.project` requires a `[project]` table in its pyproject. Pointing it at the root file fails with `key "project" not found`.
  - Pointing it at a member pyproject gives a hub with only that member's dependency groups, so cryptography is missing.
  - Two `uv.project` entries on one hub fail with "Conflict on configuration name dev".
  - The default `build` build dependency fails ("Unable to resolve a default version for requirement build") and must be set to `[]`.
  - The working setup uses a hand-written 15-line anchor file whose `test` dependency group lists all 3 members plus pytest and ruff. It also needs `--@uvpypi//venv=test` (without it the targets are SKIPPED) and `--repo_env=DO_NOT_TRACK=1` to opt out of aspect telemetry.
  - All 13 lock entries appeared in the hub. The extension lives under a `uv/unstable` path.
- **ruff:** ruff 0.15.21, pinned to match uv.lock, ran through the `aspect_rules_lint` ruff aspect. The version bundled with rules_lint is 0.16.8, which would drift from the lock. The aspect passed in U and failed on N and S only because of the NixOS `touch` problem.
- **Leak risk:** `python/kernel/tests/test_kernel_records.py` uses `Path(__file__).resolve()`, which can walk out of the sandbox through symlinks. It passed under both `processwrapper-sandbox` and `linux-sandbox`, so the leak is possible but not confirmed.

### Dart

rules_dart 0.6.6 builds and tests most of our Dart code, but only after changes to the ruleset and with one test failing:

1. **Lock union conflict.** rules_dart declares its own `pub.from_lock(ext_pub_deps)` as a non-dev dependency. The extension merges every lock into one version per package, so the extension failed with `Package "_fe_analyzer_shared" has conflicting versions` before analysis. 15 of our 51 locked packages conflict, including `test` at 1.26.3 in our lock against 1.31.2 in theirs. Our pubspecs constrain `test: '>=1.26.0 <1.27.0'`. The suggested `on_version_conflict = "upgrade"` would therefore break our lockfile and our constraints. The only working fix was a local `single_version_override` patch (11 lines) that makes rules_dart's extension usage `dev_dependency = True`. That is a carried patch against a single-maintainer ruleset.
2. **SDK pin.** For the default toolchain name, rules_dart selects the highest version across modules: "has multiple versions ["3.11.0", "3.13.4"], selected 3.13.4". Pinning the devenv SDK 3.11.0 needs a root-only named toolchain (`dart_tuvren`).
3. **Format style.** `dart_format_test` defaults to the newest language version and reported "8 changed" files that native `dart format` leaves alone (0 changed). Setting `language_version = "3.7"` fixes this.
4. **Test-shape failure.** `dart/kernel-conformance-adapter/test/protocol_test.dart` shells out to `Process.start('dart', ['run', 'bin/main.dart'])`. Under Bazel it fails in N, S, and U (12 pass, 1 fails). Fixing it needs a source change, such as passing the `dart_binary` path in through runfiles.

What works:

- **Workspace dependencies:** pub workspace members are skipped by `pub.from_lock`, but local `dart_library(package_name = ...)` targets reproduced them.
- **Tests and checks:** `tuvren_kernel` ran 152 test cases, matching native `dart test`. `dart_analyze_test` passed for 2 packages and `dart_format_test` for 2 packages.
- **Fixture lookup:** the fixture-root lookup works through runfiles with `//:pubspec.yaml` in `data`.
- **SDK on NixOS:** the prebuilt SDK ran through nix-ld.

### Protobuf module resolution

`bazel mod explain protobuf` shows these requested versions: 3.19.6, 27.0, 29.0-rc2, 29.0-rc3, 29.0, 29.1, and 32.1. rules_rust_prost 0.74.0 declares 28.3 but was not in the final graph. All of them resolve to 33.4, because Bazel 9.1.1's `bazel_tools` requests it. All of these versions are at compatibility level 1, so there is no resolution error and no module override is needed. No module in this set requests 36.2.

The real conflict is the prebuilt protoc version:

- With toolchains_protoc 0.6.1 at v29.3, `proto_library` failed with "Unknown flag: --option_dependencies".
- With v33.0 (the highest version toolchains_protoc knows), protobuf 33.4's authenticity check failed ("Expected: libprotoc 33.4").

The working setup:

- Drop toolchains_protoc.
- Set `common --@protobuf//bazel/toolchains:prefer_prebuilt_protoc`.
- For `build.rs`, `use_repo` protobuf's own `@protobuf//bazel/private:prebuilt_protoc_extension.bzl` repo `prebuilt_protoc.linux_x86_64`. This is a private API, so it is a caveat.
- On NixOS only, add `--@protobuf//bazel/toolchains:allow_nonstandard_protoc`, because the authenticity action cannot find `cat`. U passes the check without the flag.

### Cache and sandbox evidence (counts only)

- **N, full matrix:**
  - Repeat run: "2 processes: 31 action cache hit". Executed 1 of 32 tests, the failing Dart test, which Bazel never caches.
  - After `bazel shutdown`: "1 process: 1380 action cache hit". Executed 0 of 31 tests.
- **U, full matrix:**
  - Cold run: 1389 total actions, 797 of them under `linux-sandbox`, with 31 of 32 tests passing.
  - Warm run: "2 processes: 31 action cache hit", executed 1 of 32 (again the failing Dart test).
  - Lint: the clippy and rustfmt build ran 25 actions with 902 action cache hits and passed. The ruff aspect ran 8 actions and passed.
- **No special tags needed:** no test needed `no-sandbox`, `local`, or `requires-network`.

### Config size (scratch, all 4 languages plus proto and lint)

The scratch setup was 26 files and 899 lines. That includes the 167-line derived requirements file and a MODULE.bazel of 157 lines:

- Rust: about 34 lines in MODULE.bazel.
- Go: about 12 lines in MODULE.bazel.
- Python: 16 lines (rules_python) or 30 lines (aspect).
- Dart: 28 lines, plus the patch.
- Proto and lint: about 19 lines.
- Zig cc: 5 lines.

BUILD files:

- Rust: 168 lines across 6 files, hand-written. crate_universe covers only third-party code.
- Go: 95 lines across 3 files, fully generated by gazelle except for 1 hand-added `data` line.
- Python: 79 lines across 3 files, hand-written; no gazelle was tried.
- Dart: 93 lines across 2 files, using list comprehensions over `test/*_test.dart`. The rules_dart gazelle plugin was not tried.

For the real repo (6 crates, 3 Go modules, 3 Python packages, 3 Dart packages), gazelle keeps Go small. Rust and Python stay small but hand-maintained. A per-language macro for a "library plus its tests" pattern would cut the Rust and Dart repetition.

## Recommendation

- **Chosen option:** "Bazel-native rules where the spike proves them, native-wrapped actions as recorded exceptions elsewhere".
  - Adopt rules_rust 0.74.0 for Rust, with crate_universe over Cargo.lock and `cargo_build_script` for `build.rs`.
  - Adopt rules_go 0.63.0 with gazelle 0.54.0 for Go.
  - Adopt rules_python 2.3.4 for Python, with `pip.parse` over a requirements file derived from uv.lock by `uv export --frozen` and a drift gate, plus `bootstrap_impl=script`.
  - Use rules_buf 0.5.4 for buf lint, and rules_rust's aspects plus nogo for Rust and Go lint.
  - Dart becomes the one recorded native-wrapped exception.
- **Conditions that come with adoption:**
  - Register a hermetic C toolchain (hermetic_cc_toolchain or equivalent), so Rust, Go, and Python analysis does not depend on host gcc. Environment S proved that host gcc is otherwise a hard dependency.
  - Declare protobuf 33.4 with `prefer_prebuilt_protoc`.
  - Pin the toolchains in MODULE.bazel (Rust 1.95.0, Go 1.25.7, Python 3.13, ruff 0.15.21) with a sync check against `rust-toolchain.toml`, `go.work`, `uv.lock`, and devenv.
  - Accept a NixOS-only config for the actions with a fixed PATH. The candidate machine-level fix is NixOS `services.envfs`, which was not tested and is flagged unverified.
- **Why it fits:** Rust, Go, and Python met the owner's rule on N, on S (with the conditions above), and on U. Each ran the full native test count, from the committed lockfiles, with downloaded toolchains, in the default sandbox. Cache hits and targeted rebuilds were also demonstrated. Dart did not meet the rule. rules_dart could not consume our pubspec.lock without a carried patch to the ruleset, it overrides our SDK pin unless worked around, and 1 of 19 Dart test targets fails under it. Counting that as "it builds and tests our code" would soften the rule.
- **Rejected options:**
  - *Bazel-native for every non-TypeScript language:* rejected because Dart failed the rule. The rules_dart lock-union conflict needs a carried patch, and one test fails.
  - *Native-wrapped for all:* rejected because Rust, Go, and Python are proven hermetic on both machine types.
  - *aspect_rules_py instead of rules_python:* viable and consumes uv.lock directly. It is the runner-up because it needs a hand-maintained anchor pyproject that duplicates the member list, a venv flag, and a telemetry opt-out, and its extension sits under an `unstable` path while 2.0 alphas are in flight.
  - *toolchains_protoc:* incompatible with protobuf 33.4's protoc version enforcement.
- **What would change each verdict:**
  - **Rust:** a toolchain or crate that needs system C libraries beyond what the hermetic cc toolchain provides, or clippy or rustfmt diverging from cargo, would demote it.
  - **Go:** a non-root go.work module adding a third-party `require` that `go_deps.from_file(go_work)` cannot resolve would demote it. Re-test when the first go.sum appears.
  - **Python:** a uv.lock entry that is sdist-only or needs a native build would re-open the choice. So would aspect_rules_py 2.x reading a virtual workspace root without an anchor, which would flip the preference to aspect.
  - **Dart:** the exception is lifted after a rules_dart release on BCR stops merging its own ext lock into root hubs (or scopes version reconciliation per hub), `protocol_test.dart` takes the adapter binary from runfiles, and the matrix re-run passes 19 of 19 targets on N and U with no carried patch.

## Downstream impact

- **ADRs to write or update:**
  - A new ADR superseding `.constitution/tech-spec/adrs/ADR-0013-workspace-orchestration-uses-devenv-and-nx.md`.
  - An amendment to `.constitution/tech-spec/adrs/ADR-0017-native-toolchains-remain-authoritative-inside-each-impl.md` recording:
    - lockfiles stay authoritative, and the Bazel toolchain pins are mirrors with sync checks;
    - the Dart native-wrapped exception;
    - the requirements file derived from uv.lock plus its drift gate.
- **Tickets unblocked:** none. This is a decision-owned spike; it unblocks planning of the Bazel (Nx removal) epics.
- **Register entry closed:** OD-07. Chosen option: "Bazel-native rules where the spike proves them, native-wrapped actions as recorded exceptions elsewhere". Rust (rules_rust), Go (rules_go and gazelle), and Python (rules_python) are adopted. Dart is the recorded native-wrapped exception.
- **Tickets to add or split:**
  1. Hermetic C toolchain registration.
  2. Toolchain-pin sync checks (Rust, Go, Python, ruff).
  3. uv.lock to requirements drift gate.
  4. Rust BUILD for all 6 crates, including the missing `rust/kernel` unit-test target (27 tests currently not run).
  5. Go gazelle wiring, with a `BUILD.bazel` in each module before `go_deps` can run.
  6. Python pytest targets with `bootstrap_impl=script`.
  7. proto_library and buf lint targets.
  8. A NixOS FHS-PATH workaround (evaluate `services.envfs`) or a documented NixOS-only flag set.
  9. A Dart native-wrapped action lane, plus a follow-up to make `protocol_test.dart` hermetic.
  10. A re-evaluation trigger for rules_dart when BCR publishes a version that isolates its ext lock.
- **Spec edits required:** Stage 3 (tech-spec) must record the ADR changes and the new module pins in `stack.yaml`. The structure rule and the recorded "one Bazel file under spec/" disposition need a Stage 3 decision, because proto and buf targets need a `BUILD.bazel` under `spec/interop/proto/`. This spike edited no spec.
