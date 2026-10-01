---
"@tuvren/telemetry-semconv": patch
---

Generated telemetry semantic-convention helpers are now normalized through Oxfmt instead of Biome (ADR-0070, KRT-BP003). The generated TypeScript helper and the checked-in JSON attribute artifact are unchanged in parsed value; only their formatter-owned layout may differ. No runtime behavior changes.
