#!/usr/bin/env bash
# Thin M1 tracer-bullet shim: proves the Bazel <-> TypeScript seam by
# shelling out to the existing bun/Nx toolchain, rather than adopting a
# full JS Bazel ruleset now. Must run via `bazel run` (not `bazel build`/
# `bazel test`), which is the only Bazel invocation that populates
# BUILD_WORKSPACE_DIRECTORY - the escape hatch this script needs to reach
# the real repo tree (node_modules, workspace symlinks) instead of a
# sandboxed subset of it.
set -euo pipefail

: "${BUILD_WORKSPACE_DIRECTORY:?nx-run.sh must be invoked via 'bazel run', not 'bazel build'/'bazel test'}"
: "${NX_TARGET:?set NX_TARGET (e.g. kernel-contract-protocol:test) via the wrapping native_binary rule env attribute}"

cd "$BUILD_WORKSPACE_DIRECTORY"
exec bun run nx run "$NX_TARGET"
