# @tuvren/backend-shared

Shared kernel-backend invariant core: the reclamation, record-utils, and run-transition-legality logic common to the memory, SQLite, and PostgreSQL backends, parameterized by backend-owned error-code prefix.

Install alongside [`@tuvren/core`](https://www.npmjs.com/package/@tuvren/core) and [`@tuvren/sdk`](https://www.npmjs.com/package/@tuvren/sdk); this package peer-depends on a single shared `@tuvren/core` instance (ADR-037).

See the [Tuvren framework repository](https://github.com/Tuvren/framework) for documentation and adopter onboarding.
