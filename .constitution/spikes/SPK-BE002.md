# Spike Report: KRT-BE002 Scope-Binding Realization Across Backends

## 1. Context & Objective
- **Triggering upstream file/section:** `.constitution/tech-spec/adrs/ADR-048-tenancy-agnostic-scope-seam-bound-at-construction.md`; ADR-049; `docs/KrakenKernelSpecification.md` §2.3
- **Target:** The concrete per-backend realization of a construction-bound Scope (memory, SQLite, PostgreSQL) that confines every read, write, and enumeration to the constructing scope without changing the kernel syscall surface.

## 2. Codebase Baseline
- **Current State:** _To be filled during execution._ Backends key durable objects globally by content hash (`objects.hash` PK in `backend-sqlite/migrations/0001_initial_schema.sql`); `RuntimeBackend` construction and `createRuntimeKernel()` do not carry a scope.
- **Discovered Constraints:** _To be filled during execution._ Kernel must stay scope-free (ADR-048); isolation lives at the substrate.

## 3. Options & Trade-offs
- **Memory:** scope-keyed store maps (single obvious option).
- **SQLite:** file-per-scope (strong isolation, more handles) vs. scope-discriminator column + composite keys (one file, requires migration + every query scoped).
- **PostgreSQL:** host-supplied row-level-isolated connection/role (RLS reads the tenant discriminator) vs. dedicated schema/database per scope.

## 4. Execution Directives
- **Chosen Option:** _To be filled during execution._
- **Why it fits:** _To be filled during execution._
- **Downstream Backlog Impact:** Unlocks `KRT-BE003`, `KRT-BE004`, `KRT-BE005`, `KRT-BE006`.
