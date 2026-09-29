---
id: ADR-0068
status: accepted
date: 2026-09-29
certainty: settled
evidence:
  kind: ruling
  ref: "user ruling, planning session 2026-09-29"
  date: 2026-09-29
---
### ADR-0068 Session-Carriage Packages Stay Private Until a Public Session API Exists

- **Status:** accepted. Amends ADR-0062 and ADR-0063 only as to whether `@tuvren/stream-ws` belongs to the published package set; their protocol, session-lifecycle, and WebSocket carriage semantics remain unchanged. ADR-0057 item 5 is unaffected.
- **Context:** The registry has only the `0.1.0` `@tuvren/*` release from 2026-07-11, no git release tags exist, and `@tuvren/stream-ws` has never been published. Its current package manifest is public but depends on private `@tuvren/host-session` and `@tuvren/remote-session`; `@tuvren/session-client` is also private. Consequently `bun run publish:preflight` fails before a curated public release can be shipped. ADR-0062 called the WebSocket carriage a shipped `@experimental` 0.x package, and ADR-0063 described its session composition, but neither establishes a publishable dependency graph for the present package shape.
- **Decision:**
  1. **Keep the session-carriage package private.** Set `"private": true` on `typescript/streaming/ws/package.json`, alongside `@tuvren/host-session`, `@tuvren/remote-session`, and `@tuvren/session-client`. Withhold all four from the curated published set. Their code and experimental protocol semantics continue to serve the repository's host and test surfaces.
  2. **Defer a public session surface.** A later ADR may define a slim publishable session API and its dependency boundary. That work is deferred and is not scheduled by this decision. Marking `@tuvren/stream-ws` experimental does not itself make it installable from the registry.
- **Consequences:**
  - Registry publish preflight must pass with the curated set after the manifest and release selection are aligned; this is an implementation outcome to verify, not yet observed.
  - Adopter documentation must not list `@tuvren/stream-ws` as an installable registry package. A future public session API requires its own ADR and release evidence.
  - The WebSocket frame, cursor, reattachment, and carriage rules in ADR-0062 and ADR-0063 remain in force inside the repository.
