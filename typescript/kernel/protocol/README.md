# @tuvren/kernel-protocol

Internal Tuvren kernel protocol contracts (ADR-057) — an engine dependency of @tuvren/sdk and the backend packages, not a host-facing API. Hosts type kernel instances via @tuvren/sdk re-exports; this package is not semver-guaranteed.

> **Internal engine package.** Do not install or import this package directly — it exists on the registry only so the published Tuvren packages can resolve their dependency graph. It is not semver-guaranteed and may change shape between minors (ADR-057). Hosts compose the framework through [`@tuvren/sdk`](https://www.npmjs.com/package/@tuvren/sdk) and their chosen leaf packages.

See the [Tuvren framework repository](https://github.com/Tuvren/framework) for documentation.
