---
"@tuvren/telemetry-semconv": patch
---

Telemetry codegen formats its generated output with native Oxfmt instead of Biome (ADR-0070, KRT-BP003). The generator passes the JSON attribute artifact and the TypeScript helper to Oxfmt in one invocation. The shipped preset ignores generated directories, so only the JSON artifact matches and Oxfmt normalizes its layout. The JSON path stays in the invocation so the run always has a matched file. The ignored TypeScript helper, parsed values, and runtime behavior remain unchanged.
