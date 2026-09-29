# @tuvren/core

## 0.2.0

### Patch Changes

- 915ece5: Record public package changes since 0.1.0. `@tuvren/core` and `@tuvren/sdk`
  add the optional `AgentConfig` sanitization hook and error codes.
  `@tuvren/backend-postgres` replaces blob-per-scope persistence with
  relational row-per-record storage and changes the default schema from
  `public` to `tuvren_kernel`. Existing default-schema hosts must pass
  `schemaName: "public"`; a selected legacy schema migrates on first open.
  Downgrades aren't supported. The remaining package entries cover additions,
  fixes, and internal updates.

## 0.1.0

### Minor Changes

- First public registry release of the Tuvren SDK (Epic BL, ADR-0054/0056/0057): the frozen stable core (`@tuvren/core`, `@tuvren/sdk`), the published leaf packages, and the internal engine packages (`@tuvren/runtime`, `@tuvren/kernel-protocol`, `@tuvren/kernel-runtime`, `@tuvren/provider-api`, `@tuvren/telemetry-semconv`) published for dependency resolution only. Versions move in lockstep via the fixed `@tuvren/*` group.
