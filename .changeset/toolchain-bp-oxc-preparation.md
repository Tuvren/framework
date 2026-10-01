---
"@tuvren/backend-memory": patch
"@tuvren/backend-postgres": patch
"@tuvren/backend-shared": patch
"@tuvren/backend-sqlite": patch
"@tuvren/core": patch
"@tuvren/kernel-grpc-client": patch
"@tuvren/kernel-protocol": patch
"@tuvren/kernel-runtime": patch
"@tuvren/mcp-client": patch
"@tuvren/provider-api": patch
"@tuvren/provider-bridge-ai-sdk": patch
"@tuvren/runner-react": patch
"@tuvren/runtime": patch
"@tuvren/sdk": patch
"@tuvren/stream-agui": patch
"@tuvren/stream-core": patch
"@tuvren/stream-sse": patch
"@tuvren/telemetry-otel": patch
"@tuvren/telemetry-semconv": patch
---

Toolchain preparation moves TypeScript and JSON formatting and import organization to native Oxfmt and prepares the OXC toolchain (ADR-0070, KRT-BP003/KRT-BP004). These public packages receive the mechanical reformat and import-organization output and the supporting configuration edits. Parsed authority, public APIs, signatures, stored encodings, and runtime behavior are unchanged.

Telemetry codegen passes the JSON attribute artifact and the TypeScript helper to Oxfmt in one invocation. The shipped preset ignores generated directories, so only the JSON artifact matches and Oxfmt normalizes its layout. The JSON path stays in the invocation as the required matched file. The ignored TypeScript helper, parsed values, and runtime behavior remain unchanged. A second generator and formatter pass produces no diff.
