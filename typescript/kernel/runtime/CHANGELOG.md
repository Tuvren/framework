# @tuvren/kernel-runtime

## 0.4.0

### Minor Changes

- 8a76b87: Return unique tree.diff changedPaths in ascending unsigned UTF-8 byte order, including paths with supplementary Unicode characters. Document the canonical result order in the kernel protocol and forward native diff results through the TypeScript conformance adapter without sorting.
  
  Emit the canonical turn_node_thread_mismatch, run_lease_owner_mismatch, and run_lease_token_mismatch error codes from @tuvren/kernel-runtime. Native errors now reach conformance unchanged; consumers matching the previous kernel_runtime-prefixed codes must update their handlers.
  
  Recognize canonical lease-fence errors in @tuvren/runtime so execution fails with runtime_execution_lease_lost and discards late runner output. The error-code change requires a minor release under ADR-0069 decision 3.

### Patch Changes

- 76379fa: Stop advertising mid-commit fault injection and remove the memory backend's midCommit test hook because it cannot expose a genuine storage boundary. This changes untagged exported behavior and requires a minor release under ADR-0069 decision 3.
  
  Remove kernel runtime tests superseded by the shared syscall certification plans. This patch does not change runtime behavior.
- Updated dependencies [8a76b87]
- Updated dependencies [104052b]
- Updated dependencies [8c5da7a]
- Updated dependencies [1b2e3a9]
- Updated dependencies [98d14f4]
  - @tuvren/kernel-protocol@0.4.0
  - @tuvren/core@0.4.0

## 0.3.0

### Minor Changes

- f13a6fe: Apply lint cleanup to the kernel protocol and runtime. Protocol repository and syscall callables use property signatures, which reject implementations with narrower input parameters under strict function checking. Protocol `hashKernelRecord` and `hashTurnTreeIdentity` report invalid inputs through Promise rejection instead of synchronous throws; validation codes, messages, order, and canonical identities are preserved.
  
  The SDK re-exports `RuntimeBackend`, `RuntimeKernel`, and `RuntimeKernelRunLiveness`; their callable properties enforce the same strict input-parameter variance.
  
  Runtime `verdicts.compose` reports malformed-input failures through Promise rejection instead of synchronous throws. Verdict priority, returned values, and error values are preserved. Runtime async iteration remains lazy and sequential, preserving transaction writes and lineage reads.

### Patch Changes

- 8639023: Toolchain preparation moves TypeScript and JSON formatting and import organization to native Oxfmt and prepares the OXC toolchain (ADR-0070, KRT-BP003/KRT-BP004). These public packages receive the mechanical reformat and import-organization output and the supporting configuration edits. Parsed authority, public APIs, signatures, stored encodings, and runtime behavior are unchanged.
  
  Telemetry codegen passes the JSON attribute artifact and the TypeScript helper to Oxfmt in one invocation. The shipped preset ignores generated directories, so only the JSON artifact matches and Oxfmt normalizes its layout. The JSON path stays in the invocation as the required matched file. The ignored TypeScript helper, parsed values, and runtime behavior remain unchanged. A second generator and formatter pass produces no diff.
- Updated dependencies [29de200]
- Updated dependencies [0f3e64f]
- Updated dependencies [8639023]
- Updated dependencies [f13a6fe]
  - @tuvren/core@0.3.0
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

## 0.1.0

### Patch Changes

- Updated dependencies
  - @tuvren/core@0.1.0
  - @tuvren/kernel-protocol@0.1.0
