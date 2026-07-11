# @tuvren/provider-api

Internal Tuvren provider-integration helpers (ADR-057) — an engine dependency of the runner and provider-bridge packages, not a host-facing API. Not semver-guaranteed.

> **Internal engine package.** Do not install or import this package directly — it exists on the registry only so the published Tuvren packages can resolve their dependency graph. It is not semver-guaranteed and may change shape between minors (ADR-057). Hosts compose the framework through [`@tuvren/sdk`](https://www.npmjs.com/package/@tuvren/sdk) and their chosen leaf packages.

See the [Tuvren framework repository](https://github.com/Tuvren/framework) for documentation.
