---
id: ADR-0073
status: accepted
date: 2026-09-29
certainty: settled
evidence:
  kind: spike
  ref: SPK-KRT-OD007
  date: 2026-09-29
  note: "Register entry OD-07, ruled by the spike under the owner's adopt-only-if-it-works rule; the owner ruled Bazel-native rules for every non-TypeScript language."
---
### ADR-0073 Bazel-Native Rules for Rust, Go and Python, with a Dart Exception

- **Status:** accepted. Refines ADR-0071 and amends ADR-0017.
- **Context:** ADR-0017 said native tools execute the work for their ecosystems. The owner's intent is Bazel-native rulesets (bzlmod) for every language except TypeScript, with the language lockfiles and toolchain versions staying authoritative. SPK-KRT-OD007 built and tested our real lockfiles in three environments: the NixOS devenv machine, the same machine with a scrubbed PATH, and an ubuntu:24.04 container. Rust ran 78 of 78 tests and Go 117 of 117. Python's `rules_python` setup ran one target with 289 tests; only `aspect_rules_py` demonstrated all 298 tests across the three packages, so the review amendment makes `rules_python` provisional. `rules_dart` 0.6.6 clashed on 15 of 51 locked packages and worked only with a carried patch, and one test failed in all three environments.
- **Decision:**
  1. **Rust uses `rules_rust` 0.74.0** with `crate_universe` over `Cargo.lock`, `cargo_build_script` for `build.rs`, and the toolchain pinned to 1.95.0 in `MODULE.bazel` with a check that it equals `rust-toolchain.toml`. Clippy and rustfmt run as aspects. All six workspace crates are Bazel targets.
  2. **Go uses `rules_go` 0.63.0 with `gazelle` 0.54.0** and `nogo`. The Go toolchain is pinned to 1.25.7 (the `go 1.24.7` in `go.work` is too old for gazelle 0.54's own tools), with a check against `go.work` and devenv. Resolving third-party dependencies through `go_deps` from non-root `go.work` members remains unverified by the spike; the repository has no third-party Go dependencies today. Re-test when the first third-party `go.sum` appears.
  3. **Python provisionally uses `rules_python` 2.3.4** with `pip.parse` over a requirements file that `uv export --frozen` produces from `uv.lock`, a drift gate that keeps the two in sync, and `bootstrap_impl=script`. Adoption remains provisional until the Python ticket demonstrates all 298 tests (289 + 8 + 1 across the three Python packages) under both NixOS devenv and ubuntu CI conditions. The spike demonstrated only one target with 289 tests for `rules_python`; only `aspect_rules_py` demonstrated all three packages. `aspect_rules_py` is the fallback if the full matrix cannot be demonstrated.
  4. **Buf and lint.** `rules_buf` 0.5.4 runs `buf` lint and breaking checks. `aspect_rules_lint` 2.9.1 wraps `ruff` and, where useful, `gofmt`. `protobuf` resolves to 33.4 because Bazel 9.1.1 requires it, with the prebuilt-protoc flag because `toolchains_protoc` tops out at 33.0.
  5. **A hermetic C toolchain is registered** (`hermetic_cc_toolchain` or an equivalent), because with a scrubbed PATH Rust, Go and Python analysis otherwise depend on host gcc.
  6. **Dart is the one recorded native-wrapped exception.** Dart actions run `dart test`, `dart analyze` and `dart format` as native-wrapped actions pinned to the devenv SDK, with `pubspec.lock` authoritative. The exception is lifted only when a `rules_dart` release on the Bazel Central Registry stops merging its own extension lock into root hubs, the `protocol_test.dart` test takes the adapter binary from runfiles, and the Dart targets (19 at measurement time) pass in both environments with no carried patch.
  7. **Generated proto outputs.** The TypeScript `protoc-gen-es` output has no first-party Bazel rule, so it stays checked in with a Bazel freshness test and an update target. A BUILD file under `spec/interop/proto/` is needed for `proto_library` and buf lint; this record allows it as an exception to the rule that `spec/conformance/kernel/fixtures/BUILD.bazel` is the only Bazel file under a `spec/` root.
  8. **Amendment to ADR-0017.** ADR-0017's principle stands: native toolchains and lockfiles are authoritative inside each implementation (`Cargo.lock`, `go.sum`, `uv.lock`, `pubspec.lock`, and the pinned language versions). Its clause that Nx provides orchestration and native tools execute the work is replaced: Bazel rules execute the work for Rust, Go and Python, native-wrapped Bazel actions execute it for Dart, and Bun executes TypeScript (ADR-0072).
- **Alternatives considered:**
  - Bazel-native rules for every non-TypeScript language. Rejected by the spike's evidence for Dart under the owner's rule, not softened.
  - Native-wrapped actions for all non-TypeScript languages. Rejected: Rust and Go are proven hermetic on both machine types; Python's measured 289-test target supports a provisional `rules_python` selection pending all 298 tests, with `aspect_rules_py` as fallback.
  - `aspect_rules_py` instead of `rules_python`. The fallback for the provisional selection: it alone demonstrated all three packages (289 + 8 + 1 = 298 tests) under both required environments. It reads `uv.lock` directly, but it needs a hand-maintained anchor `pyproject`, a venv flag and a telemetry opt-out, and its extension sits under an `unstable` path.
  - `toolchains_protoc`. Incompatible with protobuf 33.4's protoc version enforcement.
  - No second design was requested. The spike measured the options.
- **Consequences:** Assumed until observed. NixOS-only failures exist for two actions that run with a fixed PATH lacking `cat` and `touch` (protobuf's `ProtocAuthenticityCheck` and the `ruff` aspect); they passed on ubuntu, and ADR-0071 records the accommodation. Toolchain versions are pinned in `MODULE.bazel` with sync checks against the native toolchain files, because `rules_rust` cannot read `rust-toolchain.toml`. Dart keeps a mixed execution model until the exception lifts.
