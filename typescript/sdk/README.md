# @tuvren/sdk

The Tuvren host-facing composition tier: `createTuvren`, curated
`@tuvren/core` re-exports, host-facing kernel contract types, developer
helpers, and the `@tuvren/sdk/advanced` composition surface. The single SDK
entrypoint a host imports alongside its chosen leaf packages.

Install alongside [`@tuvren/core`](https://www.npmjs.com/package/@tuvren/core)
and your chosen leaf adapters (a backend such as
[`@tuvren/backend-memory`](https://www.npmjs.com/package/@tuvren/backend-memory),
a runner such as
[`@tuvren/runner-react`](https://www.npmjs.com/package/@tuvren/runner-react),
a provider bridge, stream adapters, …). This package peer-depends on a
single shared `@tuvren/core` instance (ADR-037).

Its dependency graph includes internal engine packages (`@tuvren/runtime`
and kernel packages) that are published only for dependency resolution —
never import those directly; everything host-facing is re-exported here or
in `@tuvren/core`. Exports are semver-stable unless their docs carry a TSDoc
`@experimental` badge.

See
[`docs/guides/publishing-and-adopter-onboarding.md`](https://github.com/Tuvren/framework/blob/master/docs/guides/publishing-and-adopter-onboarding.md)
in the [Tuvren framework repository](https://github.com/Tuvren/framework)
for the full onboarding guide, including an install-plus-first-Turn
walkthrough and telemetry routing topologies.
