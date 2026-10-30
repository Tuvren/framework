# @tuvren/runtime

## 0.4.0

### Patch Changes

- 8a76b87: Return unique tree.diff changedPaths in ascending unsigned UTF-8 byte order, including paths with supplementary Unicode characters. Document the canonical result order in the kernel protocol and forward native diff results through the TypeScript conformance adapter without sorting.
  
  Emit the canonical turn_node_thread_mismatch, run_lease_owner_mismatch, and run_lease_token_mismatch error codes from @tuvren/kernel-runtime. Native errors now reach conformance unchanged; consumers matching the previous kernel_runtime-prefixed codes must update their handlers.
  
  Recognize canonical lease-fence errors in @tuvren/runtime so execution fails with runtime_execution_lease_lost and discards late runner output. The error-code change requires a minor release under ADR-0069 decision 3.
- 030339b: Prepare runtime core internals for native linting while preserving public behavior.
- 1b2e3a9: Preserve the first fatal execution error and expose later failures in the optional `subsequentErrors` field of a failed execution result.
  Map an absent or non-snake_case error code to `execution_failed` in the typed result and its `subsequentErrors`, keeping the published error in the event stream, so `awaitResult()` resolves where a non-snake_case code previously prevented it.
  Preserve subsequent execution errors in failed orchestration results and resolve child initialization failures with invalid error codes using the same fallback.
  Document the at-least-once tool dispatch and recovery contract for hosts, including idempotency requirements.
- 15ce8bc: Prepare runtime execution and tool-dispatch internals for native linting while preserving public behavior.
- de358ab: Preserve runtime regression coverage while preparing the remaining test surface for native linting.
- 4829233: Apply behavior-preserving lint cleanup to the framework runtime while preserving public signatures and runtime semantics.
- Updated dependencies [8a76b87]
- Updated dependencies [104052b]
- Updated dependencies [8c5da7a]
- Updated dependencies [1b2e3a9]
- Updated dependencies [98d14f4]
  - @tuvren/kernel-protocol@0.4.0
  - @tuvren/core@0.4.0
  - @tuvren/telemetry-semconv@0.4.0

## 0.3.0

### Minor Changes

- 0f3e64f: Add the optional host-owned `admissionKey` to user messages and input signals. Preserve the key through durable input and steering while excluding it from runner and provider messages.

### Patch Changes

- 29de200: Internal tooling update for the Biome 2.5 upgrade with no change to published behavior. `@tuvren/core` replaces six `biome-ignore` comments that Biome 2.5 reports as unused with plain comments, and the `@tuvren/runtime` and `@tuvren/backend-postgres` test suites pick up a lint fix and formatter output.
- ed385c0: Resume interrupted tool batches after stale-run recovery by dispatching only missing calls with their original call identity. Recovery reports `runtime_recovery_interrupted_iteration_unreadable` when the interrupted assistant state is unreadable or erased.
- 3021423: Copy buffers at both memory-backend ownership boundaries before any decoder or identity validator reads them. The deterministic CBOR decoder (`cbor-x`) attaches a `dataView` own property to the buffer it decodes, so a write that validated a caller-supplied record could mutate the caller's buffers, and an internal lineage or turn-tree decode could decorate the committed state's stored bytes. Caller records are now isolated field-by-field before validation, internal decodes run on detached copies, and reads continue to return detached buffers. No public API, stored encoding, or error code changes; the 77 pre-existing backend tests are unchanged, and 5 buffer-ownership regression tests are added in `test/buffer-ownership.test.ts`.
  
  `@tuvren/runtime` and `@tuvren/sdk` cover the refreshed-toolchain correction. Expired-run recovery compares the incoming signal against the last durable user message, whose stored maps decode with a null prototype, so the comparison now skips prototype matching while still comparing content, structure, and value types strictly; recovery resumes the same durable turn again instead of discarding it. The SDK's development-time `@tuvren/*` module resolution no longer drops the workspace source aliases, so sdk, runtime, and host code share one `@tuvren/core` module and one error constructor instead of loading a second copy from `dist`. No public signature, error code, or stored encoding changes.
  
  `@tuvren/telemetry-semconv` covers the regenerated runtime telemetry helper. The semantic-convention registry manifest now carries the single `schema_url` field that current Weaver reads instead of the deprecated `semconv_version` plus `schema_base_url` pair, and the generator reads that field. The attribute vocabulary, types, stability, examples, and schema URL are unchanged, so the published helper is byte-identical; this entry records the regenerated artifact and its new manifest provenance.
- 8639023: Toolchain preparation moves TypeScript and JSON formatting and import organization to native Oxfmt and prepares the OXC toolchain (ADR-0070, KRT-BP003/KRT-BP004). These public packages receive the mechanical reformat and import-organization output and the supporting configuration edits. Parsed authority, public APIs, signatures, stored encodings, and runtime behavior are unchanged.
  
  Telemetry codegen passes the JSON attribute artifact and the TypeScript helper to Oxfmt in one invocation. The shipped preset ignores generated directories, so only the JSON artifact matches and Oxfmt normalizes its layout. The JSON path stays in the invocation as the required matched file. The ignored TypeScript helper, parsed values, and runtime behavior remain unchanged. A second generator and formatter pass produces no diff.
- Updated dependencies [29de200]
- Updated dependencies [0f3e64f]
- Updated dependencies [3021423]
- Updated dependencies [8639023]
- Updated dependencies [f13a6fe]
  - @tuvren/core@0.3.0
  - @tuvren/telemetry-semconv@0.3.0
  - @tuvren/kernel-protocol@0.3.0

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
- Updated dependencies [915ece5]
  - @tuvren/core@0.2.0
  - @tuvren/kernel-protocol@0.2.0
  - @tuvren/telemetry-semconv@0.2.0

## 0.1.0

### Patch Changes

- Updated dependencies
  - @tuvren/core@0.1.0
  - @tuvren/kernel-protocol@0.1.0
  - @tuvren/telemetry-semconv@0.1.0
