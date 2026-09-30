---
"@tuvren/backend-memory": patch
"@tuvren/runtime": patch
"@tuvren/sdk": patch
"@tuvren/telemetry-semconv": patch
---

Copy buffers at both memory-backend ownership boundaries before any decoder or identity validator reads them. The deterministic CBOR decoder (`cbor-x`) attaches a `dataView` own property to the buffer it decodes, so a write that validated a caller-supplied record could mutate the caller's buffers, and an internal lineage or turn-tree decode could decorate the committed state's stored bytes. Caller records are now isolated field-by-field before validation, internal decodes run on detached copies, and reads continue to return detached buffers. No public API, stored encoding, or error code changes; the 77 pre-existing backend tests are unchanged, and 5 buffer-ownership regression tests are added in `test/buffer-ownership.test.ts`.

`@tuvren/runtime` and `@tuvren/sdk` cover the refreshed-toolchain correction. Expired-run recovery compares the incoming signal against the last durable user message, whose stored maps decode with a null prototype, so the comparison now skips prototype matching while still comparing content, structure, and value types strictly; recovery resumes the same durable turn again instead of discarding it. The SDK's development-time `@tuvren/*` module resolution no longer drops the workspace source aliases, so sdk, runtime, and host code share one `@tuvren/core` module and one error constructor instead of loading a second copy from `dist`. No public signature, error code, or stored encoding changes.

`@tuvren/telemetry-semconv` covers the regenerated runtime telemetry helper. The semantic-convention registry manifest now carries the single `schema_url` field that current Weaver reads instead of the deprecated `semconv_version` plus `schema_base_url` pair, and the generator reads that field. The attribute vocabulary, types, stability, examples, and schema URL are unchanged, so the published helper is byte-identical; this entry records the regenerated artifact and its new manifest provenance.
