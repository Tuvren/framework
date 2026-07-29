# @tuvren/backend-postgres

Tuvren PostgreSQL backend leaf: durable session persistence on Postgres with a relational row-per-record schema (ADR-067), constructed by the host and passed into createTuvren.

Install alongside [`@tuvren/core`](https://www.npmjs.com/package/@tuvren/core) and [`@tuvren/sdk`](https://www.npmjs.com/package/@tuvren/sdk); this package peer-depends on a single shared `@tuvren/core` instance (ADR-037).

## Upgrading from a pre-#110 (blob) database

Opening a database that still has the legacy `backend_postgres_snapshots` blob table automatically explodes it into the relational family tables, once, inside the same locked schema-init transaction used for ordinary migrations. The explode is all-or-nothing: if it fails partway through, the enclosing transaction rolls back, the legacy table is left intact, and the migration is simply retried in full on the next open. The migration is one-way — downgrading a migrated database back to a package built against the blob-era schema is not supported. A phase observer attached to the backend attributes the cost of this one-time explode to a `blob-migration` phase, so an unusually slow first open against an older database is explainable rather than mysterious.

See the [Tuvren framework repository](https://github.com/Tuvren/framework) for documentation and adopter onboarding.
