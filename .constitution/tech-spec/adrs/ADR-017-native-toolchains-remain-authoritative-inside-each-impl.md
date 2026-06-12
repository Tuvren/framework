### ADR-017 Native Toolchains Remain Authoritative Inside Each Implementation Tree

- **Status:** accepted
- **Context:** A language-neutral runtime does not imply a fake universal toolchain. TypeScript, Rust, and later languages each have real package, build, and test workflows that must stay first-class if the repo is to remain honest and maintainable.
- **Decision:** Nx provides repo-wide orchestration and canonical target names, but Bun, Cargo, Buf, and future language-native tools execute the actual build, test, conformance, code-generation, and interop work for their ecosystems.
- **Consequences:** Repo tooling coordinates rather than replaces native tooling. New language lines must bring their own authoritative workspace files, and implementation plans must avoid TypeScript-centric assumptions at the semantic seams.

