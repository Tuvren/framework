# @tuvren/backend-postgres

Tuvren PostgreSQL backend leaf: durable session persistence on Postgres with a relational row-per-record schema (ADR-067), constructed by the host and passed into createTuvren.

Install alongside [`@tuvren/core`](https://www.npmjs.com/package/@tuvren/core) and [`@tuvren/sdk`](https://www.npmjs.com/package/@tuvren/sdk); this package peer-depends on a single shared `@tuvren/core` instance (ADR-037).

## Schema name

Always set a dedicated `schemaName` when constructing this backend — never rely on the default. The relational schema (ADR-067) is thirteen generic, unprefixed family tables (`objects`, `schemas`, `threads`, `branches`, `turns`, `runs`, `staged_results`, …) plus twenty-one `idx_*` indexes, created with bare `CREATE TABLE`/`CREATE INDEX` and no package-specific prefix, so sharing a schema with anything else the host owns risks a name collision or silent cohabitation. When `schemaName` is omitted, the backend defaults to the backend-owned name `"tuvren_kernel"`, not `"public"` — a default-constructed backend can no longer collide with or colonize an adopter's default schema. `destroyPostgresBackend`'s `{ dropSchema: true }` option drops the entire configured schema with `CASCADE`; because that schema is shared identity for every backend instance pointed at it, only pass `dropSchema: true` against a schema this backend exclusively owns (throwaway test/conformance schemas), never against a schema that also holds host tables.

## Upgrading from a pre-#110 (blob) database

Opening a database that still has the legacy `backend_postgres_snapshots` blob table automatically explodes it into the relational family tables, once, inside the same locked schema-init transaction used for ordinary migrations. The explode is all-or-nothing: if it fails partway through, the enclosing transaction rolls back, the legacy table is left intact, and the migration is simply retried in full on the next open. The migration is one-way — downgrading a migrated database back to a package built against the blob-era schema is not supported. A phase observer attached to the backend attributes the cost of this one-time explode to a `blob-migration` phase, so an unusually slow first open against an older database is explainable rather than mysterious.

Pre-existing deployments built before this schema-name default changed relied on the old implicit `"public"` default; if such a deployment omitted `schemaName`, its legacy `backend_postgres_snapshots` table lives in `public`, not in the new default `"tuvren_kernel"`. Those deployments must now set `schemaName: "public"` explicitly (or move the legacy table into their intended dedicated schema before upgrading) so the open-time migration described above can find it — otherwise the backend opens a fresh, empty `"tuvren_kernel"` schema and never sees the legacy data at all.

See the [Tuvren framework repository](https://github.com/Tuvren/framework) for documentation and adopter onboarding.
