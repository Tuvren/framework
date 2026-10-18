# @tuvren/core

## 0.3.0

### Minor Changes

- 0f3e64f: Add the optional host-owned `admissionKey` to user messages and input signals. Preserve the key through durable input and steering while excluding it from runner and provider messages.

### Patch Changes

- 29de200: Internal tooling update for the Biome 2.5 upgrade with no change to published behavior. `@tuvren/core` replaces six `biome-ignore` comments that Biome 2.5 reports as unused with plain comments, and the `@tuvren/runtime` and `@tuvren/backend-postgres` test suites pick up a lint fix and formatter output.
- 8639023: Toolchain preparation moves TypeScript and JSON formatting and import organization to native Oxfmt and prepares the OXC toolchain (ADR-0070, KRT-BP003/KRT-BP004). These public packages receive the mechanical reformat and import-organization output and the supporting configuration edits. Parsed authority, public APIs, signatures, stored encodings, and runtime behavior are unchanged.
  
  Telemetry codegen passes the JSON attribute artifact and the TypeScript helper to Oxfmt in one invocation. The shipped preset ignores generated directories, so only the JSON artifact matches and Oxfmt normalizes its layout. The JSON path stays in the invocation as the required matched file. The ignored TypeScript helper, parsed values, and runtime behavior remain unchanged. A second generator and formatter pass produces no diff.

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
