# SQLite Backend Validation Spike

- Date: 2026-04-08
- Package posture: `@kraken/backend-sqlite` uses `better-sqlite3@12.8.0` as the first official SQLite adapter.
- Runtime posture: Node.js-first with local filesystem access and native addon support, matching `constitution/TechSpec.md`.
- Transaction posture: kernel writes use SQLite `BEGIN IMMEDIATE` with atomic commit/rollback semantics.
- Durability posture: SQLite foreign keys are enabled and file-backed databases run in WAL mode.
- Migration posture: package-owned forward-only SQL migrations under `migrations/`.
- Bun posture: Bun remains the workspace package manager. Bun 1.3 docs say dependency lifecycle scripts are default-denied except trusted/default-allowlisted packages, and the current Bun default trusted list includes `better-sqlite3`.
- Repository guardrail: the root workspace explicitly declares `trustedDependencies: ["better-sqlite3"]` so package install behavior remains deterministic even if Bun’s default trusted list changes later.
- Verified local smoke check:
  - `bun install` resolves and installs `better-sqlite3@12.8.0`
  - `node -e "const Database=require('better-sqlite3'); const db=new Database(':memory:'); console.log(db.prepare('select 1 as x').get().x)"` returns `1`
- Nx enforcement:
  - `backend-sqlite:smoke-native` performs the Node-side native addon smoke check
  - `backend-sqlite:test` depends on that smoke check before running package tests
