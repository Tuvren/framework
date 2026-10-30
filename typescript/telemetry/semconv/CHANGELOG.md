# @tuvren/telemetry-semconv

## 0.4.0

### Patch Changes

- 98d14f4: Migrate the small TypeScript packages toward the native OXC lint toolchain while preserving their public behavior.

## 0.3.0

### Patch Changes

- 3021423: Copy buffers at both memory-backend ownership boundaries before any decoder or identity validator reads them. The deterministic CBOR decoder (`cbor-x`) attaches a `dataView` own property to the buffer it decodes, so a write that validated a caller-supplied record could mutate the caller's buffers, and an internal lineage or turn-tree decode could decorate the committed state's stored bytes. Caller records are now isolated field-by-field before validation, internal decodes run on detached copies, and reads continue to return detached buffers. No public API, stored encoding, or error code changes; the 77 pre-existing backend tests are unchanged, and 5 buffer-ownership regression tests are added in `test/buffer-ownership.test.ts`.
  
  `@tuvren/runtime` and `@tuvren/sdk` cover the refreshed-toolchain correction. Expired-run recovery compares the incoming signal against the last durable user message, whose stored maps decode with a null prototype, so the comparison now skips prototype matching while still comparing content, structure, and value types strictly; recovery resumes the same durable turn again instead of discarding it. The SDK's development-time `@tuvren/*` module resolution no longer drops the workspace source aliases, so sdk, runtime, and host code share one `@tuvren/core` module and one error constructor instead of loading a second copy from `dist`. No public signature, error code, or stored encoding changes.
  
  `@tuvren/telemetry-semconv` covers the regenerated runtime telemetry helper. The semantic-convention registry manifest now carries the single `schema_url` field that current Weaver reads instead of the deprecated `semconv_version` plus `schema_base_url` pair, and the generator reads that field. The attribute vocabulary, types, stability, examples, and schema URL are unchanged, so the published helper is byte-identical; this entry records the regenerated artifact and its new manifest provenance.
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
