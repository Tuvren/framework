### ADR-007 Memory and SQLite Are the Official Initial Backends

- **Status:** accepted
- **Context:** The project needs a usable development backend immediately and a usable persistent backend package without pretending that one backend defines Kraken’s ontology.
- **Decision:** `@tuvren/backend-memory` is the reference non-persistent backend for development and semantic testing. `@tuvren/backend-sqlite` is the first officially supported persistent backend adapter.
- **Consequences:** SQLite is the first official persistent implementation and the baseline proving-host backend for Node-capable environments, but not the canonical physical model for all future backends. PostgreSQL is now the second official persistent backend and proves that later backends remain peer adapters against the same kernel contract rather than SQLite-shaped derivatives. MySQL/MariaDB, MongoDB, and others remain future peer adapters against that same contract.

