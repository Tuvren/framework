# @tuvren/sdk

The Tuvren host-facing composition tier: createTuvren, curated @tuvren/core re-exports, host-facing kernel contract types, developer helpers, and the @tuvren/sdk/advanced composition surface. The single SDK entrypoint a host imports alongside its chosen leaf packages.

Install alongside [`@tuvren/core`](https://www.npmjs.com/package/@tuvren/core) and [`@tuvren/sdk`](https://www.npmjs.com/package/@tuvren/sdk); this package peer-depends on a single shared `@tuvren/core` instance (ADR-037).

See the [Tuvren framework repository](https://github.com/Tuvren/framework) for documentation and adopter onboarding.
