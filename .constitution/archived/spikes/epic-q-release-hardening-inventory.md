# Epic Q Release Hardening Inventory

This file closes Epic Q against current repo reality. Epic Q certifies internal
post-ReAct implementation-line readiness; it is not a public package
publication claim.

## Status

- Epic Q is closed in current repo reality.
- `KRT-Q001` through `KRT-Q006` are complete.
- Deno, future provider-native tools, future host protocols, future concrete
  drivers, and future official backends remain deferred beyond Epic Q.

## Implemented Hardening Surface

- `@tuvren/provider-testkit` now owns provider-contract-first generate,
  stream, rejection, finish, structured-output, and fixture helpers.
- `@tuvren/framework-testkit` now owns reusable canonical stream fixtures,
  stream collectors, event-type assertions, async capture helpers, and bounded
  wait helpers.
- `tools/scripts/verify.ts` owns the internal implementation-line verification
  surface: lint, typecheck, targeted builds/tests, export smoke tests,
  portability imports, and the Node-backed playground SQLite scenario.
- `tools/scripts/release-check.ts` wraps verification with declared-versus-
  observed runtime reporting.
- `tools/scripts/portability-check.ts` validates the clearly portable built ESM
  package surfaces under both Bun and Node.
- `constitution/spikes/epic-q-portability-matrix.md` records the checked-in
  runtime classification matrix.
- Post-closure playground evidence now also includes the user-directed
  aimock/OpenAI E2E lane. It is recorded as repository reality for future
  planning, not as reopened Epic Q scope.

## Validation Evidence

- `bun run verify`
- `bun run release-check`
- `bun run nx run providers-testkit:test`
- `bun run nx run providers-testkit:typecheck`
- `bun run nx run providers-testkit:exports-smoke`
- `bun run nx run framework-testkit:test`
- `bun run nx run framework-testkit:typecheck`
- `bun run nx run framework-testkit:exports-smoke`
- `bun run nx run providers-bridge-ai-sdk:test`
- `bun run nx run providers-bridge-ai-sdk:typecheck`
- `bun run nx run framework-stream-core:test`
- `bun run nx run framework-stream-core:typecheck`
- `bun run nx run framework-stream-sse:test`
- `bun run nx run framework-stream-sse:typecheck`
- `bun run nx run framework-stream-agui:test`
- `bun run nx run framework-stream-agui:typecheck`
- `bun run nx run framework-runtime-core:test`
- `bun run nx run framework-runtime-core:typecheck`
- `bun run nx run host-playground:test`
- `bun run nx run host-playground:typecheck`
- `bun tools/scripts/portability-check.ts`
- `bun run nx run host-playground:scenario-sqlite`
- Final `release-check` observed declared Bun `1.3.11`, local Bun `1.3.10`,
  and Node `v24.3.0`; the Bun drift was reported as non-failing by design.
- Post-closure aimock/OpenAI E2E validation added to `host-playground:test`
  covers streamed text, structured output, tool continuation, approval
  pause/resume, provider metadata, cancellation, provider failure, malformed
  responses, and unmatched fixtures through a local OpenAI-compatible HTTP
  provider boundary.

## Portability Conclusions

- Portable non-native package surfaces are checked through Bun and Node import
  validation after build.
- `@tuvren/backend-sqlite` remains Node-only because it uses `better-sqlite3`
  native addon behavior.
- `@tuvren/playground-host` is mixed-runtime validated: Bun unit tests cover
  non-reload scenarios, and the Node CLI path covers SQLite reload.
- Deno remains explicitly deferred.

## Residual Risks And Deferred Scope

- Bun version drift is visible: `package.json` declares `bun@1.3.11`, while
  local validation observed `bun 1.3.10`. Release tooling reports this drift but
  does not fail solely because of it.
- The testkits are private internal hardening surfaces, not public compatibility
  promises.
- Provider-native tools, AI SDK UI transports, AI SDK agent loops,
  `LanguageModelV2`, LangChain, ACP, future non-ReAct drivers, and future
  official backends remain out of scope until a future TechSpec revision.
