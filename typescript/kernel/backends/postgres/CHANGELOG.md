# @tuvren/backend-postgres

## 0.4.0

### Patch Changes

- Updated dependencies [8a76b87]
- Updated dependencies [104052b]
- Updated dependencies [8c5da7a]
- Updated dependencies [1b2e3a9]
- Updated dependencies [98d14f4]
  - @tuvren/kernel-protocol@0.4.0
  - @tuvren/core@0.4.0
  - @tuvren/backend-shared@0.4.0

## 0.3.0

### Patch Changes

- 29de200: Internal tooling update for the Biome 2.5 upgrade with no change to published behavior. `@tuvren/core` replaces six `biome-ignore` comments that Biome 2.5 reports as unused with plain comments, and the `@tuvren/runtime` and `@tuvren/backend-postgres` test suites pick up a lint fix and formatter output.
- 8639023: Toolchain preparation moves TypeScript and JSON formatting and import organization to native Oxfmt and prepares the OXC toolchain (ADR-0070, KRT-BP003/KRT-BP004). These public packages receive the mechanical reformat and import-organization output and the supporting configuration edits. Parsed authority, public APIs, signatures, stored encodings, and runtime behavior are unchanged.
  
  Telemetry codegen passes the JSON attribute artifact and the TypeScript helper to Oxfmt in one invocation. The shipped preset ignores generated directories, so only the JSON artifact matches and Oxfmt normalizes its layout. The JSON path stays in the invocation as the required matched file. The ignored TypeScript helper, parsed values, and runtime behavior remain unchanged. A second generator and formatter pass produces no diff.
- 31a8ddc: Apply lint cleanup to the kernel backends while preserving their public APIs and runtime behavior.
- Updated dependencies [29de200]
- Updated dependencies [0f3e64f]
- Updated dependencies [8639023]
- Updated dependencies [f13a6fe]
- Updated dependencies [31a8ddc]
  - @tuvren/core@0.3.0
  - @tuvren/backend-shared@0.3.0
  - @tuvren/kernel-protocol@0.3.0

## 0.2.0

### Minor Changes

- 915ece5: Record public package changes since 0.1.0. `@tuvren/core` and `@tuvren/sdk`
  add the optional `AgentConfig` sanitization hook and error codes.
  `@tuvren/backend-postgres` replaces blob-per-scope persistence with
  relational row-per-record storage and changes the default schema from
  `public` to `tuvren_kernel`. Existing default-schema hosts must pass
  `schemaName: "public"`; a selected legacy schema migrates on first open.
  Downgrades aren't supported. The remaining package entries cover additions,
  fixes, and internal updates.

### Patch Changes

- Updated dependencies [915ece5]
  - @tuvren/core@0.2.0
  - @tuvren/backend-shared@0.2.0
  - @tuvren/kernel-protocol@0.2.0

## 0.1.0

### Patch Changes

- Updated dependencies
  - @tuvren/core@0.1.0
  - @tuvren/backend-shared@0.1.0
  - @tuvren/kernel-protocol@0.1.0
