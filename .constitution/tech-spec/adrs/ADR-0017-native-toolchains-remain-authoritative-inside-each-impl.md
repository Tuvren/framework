---
id: ADR-0017
status: accepted
date: 2026-06-12
certainty: assumed
assumption: "Migrated; the decision's ruling reference was not found in the status line."
---
### ADR-0017 Native Toolchains Remain Authoritative Inside Each Implementation Tree

- **Status:** accepted. Amended by ADR-0073: the principle that native toolchains and lockfiles stay authoritative is unchanged, and the clause that Nx orchestrates while native tools execute is replaced by Bazel rules for Rust, Go and Python, native-wrapped Bazel actions for Dart, and Bun-executed actions for TypeScript (ADR-0071, ADR-0072).
- **Context:** A language-neutral runtime does not imply a fake universal toolchain. TypeScript, Rust, and later languages each have real package, build, and test workflows that must stay first-class if the repo is to remain honest and maintainable.
- **Decision:** Nx provides repo-wide orchestration and canonical target names, but Bun, Cargo, Buf, and future language-native tools execute the actual build, test, conformance, code-generation, and interop work for their ecosystems.
- **Consequences:** Repo tooling coordinates rather than replaces native tooling. New language lines must bring their own authoritative workspace files, and implementation plans must avoid TypeScript-centric assumptions at the semantic seams.

