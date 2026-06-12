# Epic Q Portability Matrix

This matrix records Epic Q runtime support claims for the post-ReAct
implementation line. It is an internal implementation-readiness matrix, not a
public ecosystem support guarantee.

## Classifications

| Surface | Classification | Validation path |
| --- | --- | --- |
| `@tuvren/core-types` | Bun-and-Node validated | Build/export smoke plus `tools/scripts/portability-check.ts` Bun and Node imports |
| `@tuvren/kernel-protocol` | Bun-and-Node validated | Build/export smoke plus Bun and Node imports |
| `@tuvren/kernel-testkit` | Bun-and-Node validated | Build plus Bun and Node imports |
| `@tuvren/provider-api` | Bun-and-Node validated | Build/export smoke plus Bun and Node imports |
| `@tuvren/provider-testkit` | Bun-and-Node validated | Build/test/export smoke plus Bun and Node imports |
| `@tuvren/runtime-api` | Bun-and-Node validated | Build/export smoke plus Bun and Node imports |
| `@tuvren/driver-api` | Bun-and-Node validated | Build/export smoke plus Bun and Node imports |
| `@tuvren/event-stream` | Bun-and-Node validated | Build/export smoke plus Bun and Node imports |
| `@tuvren/tool-contracts` | Bun-and-Node validated | Build/export smoke plus Bun and Node imports |
| `@tuvren/framework-testkit` | Bun-and-Node validated | Build/test/export smoke plus Bun and Node imports |
| `@tuvren/runtime-core` | Bun-and-Node validated | Build/test plus Bun and Node imports |
| `@tuvren/driver-react` | Bun-and-Node validated | Build/test plus Bun and Node imports |
| `@tuvren/stream-core` | Bun-and-Node validated | Build/test/export smoke plus Bun and Node imports |
| `@tuvren/stream-sse` | Bun-and-Node validated | Build/test/export smoke plus Bun and Node imports |
| `@tuvren/stream-agui` | Bun-and-Node validated | Build/test/export smoke plus Bun and Node imports |
| `@tuvren/provider-bridge-ai-sdk` | Bun-and-Node validated | Build/test/export smoke plus Bun and Node imports |
| `@tuvren/backend-memory` | Bun-and-Node validated | Build/test plus Bun and Node imports |
| `@tuvren/backend-sqlite` | Node-only | Package tests plus `host-playground:scenario-sqlite`; native addon behavior is not claimed as edge/serverless portable |
| `@tuvren/playground-host` | mixed-runtime validated | Bun unit tests for non-reload scenarios plus Node CLI SQLite reload scenario |
| Deno package surface | deferred | Deferred until package surfaces stabilize enough to avoid scaffolding churn |

## Toolchain Drift Note

- `package.json` declares `bun@1.3.11`.
- Local validation during Epic Q implementation observed `bun 1.3.10`.
- `release-check.ts` reports this drift but does not fail solely because of it.
