---
id: ADR-0072
status: accepted
date: 2026-09-29
certainty: settled
evidence:
  kind: spike
  ref: SPK-KRT-OD005
  date: 2026-09-29
  note: "Register entry OD-05, ruled by the spike on measured cache soundness; the owner ruled that TypeScript actions execute Bun."
---
### ADR-0072 TypeScript Actions Run in a Staged Bun Workspace

- **Status:** accepted. Refines ADR-0071 for the TypeScript line.
- **Context:** No Bazel ruleset supports `bun.lock` or `bun:test`, so TypeScript is the one line whose actions execute Bun (`bun test`, `tsup`, `tsc`). `.bazelignore` excludes `node_modules`, package `exports` point at `./dist/*`, and the declaration build of one package reads its dependencies' `dist/*.d.ts`, while `bun`'s workspace symlinks point into the real source tree. Repository rules run during loading, before build outputs exist, so they cannot stage upstream `bazel-bin` trees. SPK-KRT-OD005 measured three designs on the real chain `core` → `kernel/protocol` → `kernel/runtime`: the selected repository rule installs external dependencies and exports a content stamp, while each action builds its own private workspace. Typecheck, `bun test` and `tsup` resolve `@tuvren/*` to source through the tsconfig paths, and only the declaration step needs upstream `dist`.
- **Decision:**
  1. **Install dependencies during repository loading.** A repository rule reads the root and workspace manifests, copies them with `bun.lock`, and runs `bun install --frozen-lockfile`. It watches `bun.lock` and the manifests. It exports only a content stamp containing the Bun version, package list and full `bun.lock`, plus a generated `.bzl` package graph. The stamp is the only declared input from the install; the external `node_modules` contents are trusted.
  2. **Stage each action and split the edges.** Every TypeScript action runs sandboxed and builds its own private staged workspace. It copies declared sources instead of symlinking them, links the external dependency store through a root `node_modules` symlink, and copies the per-package `node_modules` symlink directories so their relative `@tuvren/*` links resolve to staged packages. Build actions (the `tsup` build and the declaration build) copy declared upstream package output trees containing `package.json` and `dist` from `bazel-bin` into their source-relative paths. This is the only `dist` edge between packages. Typecheck and test actions stage declared upstream sources and resolve them through the existing tsconfig paths, with no `dist` edge. Every action declares `bun.lock` and the content stamp.
  3. **Call tools by explicit path.** Actions invoke `bun`, `tsup` and `tsc` from the staged workspace. `bunx` fallback is banned because it walked up into the parent checkout when `node_modules` was absent.
  4. **Pin PATH.** A single devenv-generated PATH is written to `user.bazelrc`, because a different PATH invalidates every action and the default PATH does not contain bash.
  5. **Declare the non-manifest inputs.** Test and typecheck actions declare the files they read that are not package manifests, such as backend sources for runtime tests and `spec/kernel/**` for protocol tests. The staged design surfaces missing declarations package by package as loud failures instead of stale passes.
  6. **A `ts_package` macro and runner** generate the per-package targets from the package graph so the pattern scales to the roughly 40 packages.
  7. **Trust boundary.** Bazel trusts the contents of the external installed `node_modules` (23,993 files at measurement time); tampering inside it can still serve a cached pass. The external dependency store is produced only by the repository rule and never edited by hand; each action produces its own staged workspace.
  8. **Prerequisite.** `bun install --offline` and `--prefer-offline` need Bun 1.4.1 or later, which arrives through ADR-0074.
- **Alternatives considered:**
  - In-tree actions tagged `no-sandbox` with a declared `bun.lock` and a `dist` stamp. Rejected by measurement: a deleted `dist` file gave an all-green cached result, an undeclared test input gave a cached pass where the real result is a failure, and `bunx` found tools in the parent checkout.
  - `tsconfig` path-to-source only, with no `dist` between packages. Rejected for the build: the declaration build produced 14 TS6059 errors and 14 stray `.d.ts` files in upstream source folders. A variant using `isolatedDeclarations` is close (8 errors in `core`, none in the other two) and is left for a later survey.
  - Hermetic `rules_js` or `rules_bun`. Rejected: no `bun.lock` and no `bun:test` support, and the community `rules_bun` is immature.
  - No second design was requested. The spike measured the alternatives on real packages.
- **Consequences:** Assumed until observed. This is effectively a small bun-flavored `rules_js` that the repository maintains, with dependency installation during loading and private workspace staging inside each action. Copying declared files prevents Bun and tsc realpath resolution from escaping into the real workspace's `node_modules` or `dist`. Cache soundness was measured only for the in-workspace tampering probes. The external `node_modules` contents remain trusted: only the content stamp is declared from the install, and hiding `cbor-x` there served a cached PASS while both real test targets failed (measurement 4d). `linux-sandbox` is unavailable on this NixOS host, so SPK-KRT-OD005 ran under the weaker sandbox and could not verify the staged design under `linux-sandbox`; CI must check it. Every TypeScript target inherits the pattern, so reversing it later is costly.
