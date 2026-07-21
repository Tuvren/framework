# ADR-056 `@tuvren/core/capabilities` Graduation Assessment (Post-#102/#104 Run)

- This is a planning/diagnostic artifact under `.constitution/reports/`. It does
  not extend the live constitutional authority chain and it does not itself
  change ADR-054 or ADR-056's decisions. The active authority chain remains
  `.constitution/prd/`, `.constitution/architecture/`, `.constitution/tech-spec/`,
  and `.constitution/tasks/`.
- **Purpose:** ADR-063's Consequences section records a deferral verbatim:
  > "**Deferred:** graduation of the `@tuvren/core/capabilities` chain out of
  > `@experimental` per ADR-056. This ADR produces the network evidence that
  > gating clause names, but graduation is an ADR-054 public-API stability
  > commitment across several packages and is taken as its own reviewed change
  > rather than as a tail-end commit of the change series that generated its
  > evidence."

  This assessment is that inventory: it names exactly what the #102/#104 run
  (ADR-063/064/065, M1-M8) now supplies toward the ADR-056 graduation gate, what
  still blocks it, and recommends whether graduation should proceed as its own
  ADR-054-reviewed change or continue to wait. It does not perform that change.

## 1. What the ADR-056 gate actually asks for

ADR-056 (`.constitution/tech-spec/adrs/ADR-056-*.md`) marks
`@tuvren/core/capabilities` wholly `@experimental` and excludes it from the
ADR-054 semver freeze. The gate this run's evidence is measured against is the
one ADR-063 itself names: **network evidence** — proof that the capability
chain's reconnect, redelivery, staleness, and idempotency guarantees hold when
a Tuvren-client capability is actually dispatched to a peer over a real,
droppable network link, not merely proven in-process against fakes. Graduation
itself is a separate ADR-054 commitment (freezing `@tuvren/core/capabilities`'s
public surface under semver) that this assessment does not execute.

## 2. Evidence inventory this run adds

| Evidence | What it proves | Where it lives |
| --- | --- | --- |
| Real-socket reconnect-redelivery e2e | A killed raw socket with an unanswered `client_invocation` in flight, followed by client reconnect-with-cursor, causes exactly one handler execution and one effects-log line — genuine server-side redelivery is structurally required for the test to pass (the handler answers before the drop, so client-side dedup alone cannot fake it). | `typescript/host/repl/test/repl-serve-ws.e2e.test.ts` (M6, hardened by the M6 review's `a7bc4ab`); driven through `Bun.serve` WebSockets and the headless `@tuvren/session-client` peer (`scripts/ws-peer.ts`). |
| SIGKILL process-kill durability proof | A completed turn's tool result is read back by a **fully separate reader runtime** after the serving process is SIGKILLed, against disposable PostgreSQL — proving durable commit survives real process death, not just simulated backend failure. | Same e2e file, `process-kill durability` case. |
| Seven promoted conformance checks | Turns this run's semantics into shared, implementation-neutral, plan-graded authority rather than private test assertions: four ADR-063 session-lifecycle checks (exactly-once redelivery, grace-window-expiry settlement, dispatch-timeout settlement with a clock armed only while attached, gapless cross-sink cursor-resumed sequencing) on `host-session.json` (0.2.0 -> 0.3.0); a network-evidence lane (reconnect-redelivery dedup, kill-durability recovery) on `tuvren-client-execution-class.json` (0.2.0 -> 0.3.0), scoped honestly to what an in-process harness can prove; and the ADR-064 sanitize-seam check on `runtime-api-callables-extended.json` (0.7.0 -> 0.8.0). | `spec/conformance/engine/plans/host-session.json`, `spec/conformance/tools/plans/tuvren-client-execution-class.json`, `spec/conformance/engine/plans/runtime-api-callables-extended.json` (not modified by this assessment; cited as evidence only). |
| ADR-065 idempotency-identity correction | Closes a defect that would have undermined every graduation claim resting on redelivery dedup: the idempotency identity is now `(turnId, callId)`, genuinely stable across retry, iteration re-dispatch, approval resume, and ADR-063 redelivery — not the old `(runId, callId, fencingToken)` triple, which churned in a healthy loop. | `.constitution/tech-spec/adrs/ADR-065-*.md`; `typescript/runtime/src/lib/idempotency-identity.ts`. |
| Portability inventory bump | Records the three plan bumps above as required authority and the session-client real-socket obligation as a standing, named row rather than a silent gap. | `.constitution/reports/epic-al-portability-inventory.json` (0.9.0 -> 0.10.0). |

## 3. The honest boundary: what this evidence does *not* establish

- **Cross-process, real-socket evidence remains package-test evidence, not portable conformance authority.** The M6 e2e lives in `typescript/host/repl/test/` and exercises `Bun.serve` plus a real OS-level TCP socket kill — genuine network conditions — but it is not a shared-runner-graded, capability-selected conformance check runnable against any other implementation or adapter. The M8 network-evidence lane on `tuvren-client-execution-class.json` deliberately does not claim otherwise: its own commit message and the portability inventory both record that "the genuinely cross-process, real-socket variant remains package-test evidence in the repl host's e2e suite." Any graduation argument that treats the promoted conformance checks as equivalent to the e2e's real-socket proof would be overclaiming exactly the failure mode ADR-063/065 exist to correct.
- **ADR-065's two open obligations are unresolved, and one is directly network-relevant.**
  1. *Cold preemption recovery still re-mints `callId`.* The M6 e2e's own test text says so explicitly: it "deliberately does NOT claim a cold-recovery resume of the killed session" because framework spec §4.9's staged-result re-presentation is not yet implemented in the TypeScript runtime (`RecoveryState.uncommittedStagedResults` has no runtime consumer). This means the network-evidence chain proves reconnect-redelivery for a *live* turn and durable-read recovery for a *completed* turn, but not idempotent redelivery for a turn whose owning process died while a Tuvren-client dispatch was still outstanding. That is precisely the scenario a network-facing capability chain is most exposed to (a peer's dispatch outliving the host process that issued it), and it is the scenario the idempotency envelope's real-world value is highest for.
  2. *No behavioral test drives a real approval pause/resume and asserts idempotency-key stability across it.* ADR-065's own verification is unit-level over `createToolExecutionContext`; it would catch a regression reintroducing `runId`/`fencingToken` into the derivation, but it does not exercise `handle.turnId` threading through a genuine pause/resume, which is the assumption the whole `(turnId, callId)` decision rests on.
- **`@tuvren/session-client` and `@tuvren/remote-session` are TypeScript-only implementations with no authority packet of their own.** They realize existing authority (`spec/host/session/`, `spec/streaming/ws/`) rather than opening new portable surface, so no other language port has (or is expected to have) an equivalent binding today. This is consistent with ADR-056's `0.x`/experimental posture generally, but it means the network evidence this run produced is single-implementation evidence, not cross-language-proven evidence.
- **The reconnect-vs-close race and ended-session identity shadowing are documented, unresolved limitations**, not defects introduced by this run: the M6 review recorded both as "no behavior change" items rather than fixing them (a race can refuse a legitimate reconnect with a non-retryable `4000`; an ended session's identity can be shadowed). Neither blocks the evidence claims above, but both are real edge cases a graduated, semver-frozen public surface would need to either fix or explicitly document as a stated limitation.

## 4. Recommendation

**Graduation should wait, as its own ADR-054-reviewed change, rather than proceed as a tail-end commit here** — which is exactly what ADR-063's Consequences section already decided, and this assessment finds no new evidence that changes that call. Two independent reasons converge on the same recommendation:

1. **The network evidence is real but partial.** It closes the redelivery/staleness/idempotency gap for the *live-turn* and *completed-turn* cases, which is the majority of the surface ADR-063 exists to prove, but ADR-065 obligation 1 (cold preemption recovery re-mints `callId`) leaves exactly the highest-network-exposure case — a dispatch outstanding when the host process dies — outside the stable-identity guarantee. Freezing `@tuvren/core/capabilities` under semver while that gap is open would freeze a public contract around a guarantee that does not yet hold for one of its own documented failure modes.
2. **ADR-054 graduation is a distinct, cross-package decision that deserves its own review, not inheritance from an unrelated change series' momentum.** ADR-063's own text already anticipated this and drew the line correctly: the deferral is not a placeholder, it is the considered position that graduation criteria (which types, which packages, whether `@tuvren/remote-session`/`@tuvren/session-client` graduate alongside `@tuvren/core/capabilities` or stay separately experimental, what the frozen surface actually contains) need their own interview and ADR, not a rider on the evidence-producing change.

**When graduation is taken up as its own change, it should explicitly scope:**
- Whether ADR-065 obligation 1 (cold recovery `callId` stability) is a graduation blocker or an accepted, documented limitation of v1 of the frozen surface.
- Whether ADR-065 obligation 2 (a real pause/resume behavioral proof) is closed first, given that it pins the assumption the whole idempotency-identity decision depends on.
- Whether `@tuvren/remote-session` and `@tuvren/session-client` — both still `private`/`@experimental` with no ADR-054 freeze commitment named for them anywhere in this run's ADRs — are in scope for the same graduation change or are deliberately left experimental longer than `@tuvren/core/capabilities` itself.
- Whether the documented reconnect-vs-close race and ended-session identity shadowing need a fix before freeze, or an explicit stated-limitation note in the frozen contract.

## 5. Evidence paths cited

- `typescript/host/repl/test/repl-serve-ws.e2e.test.ts` (M6 real-socket e2e, hardened by M6 review commit `a7bc4ab`)
- `scripts/ws-peer.ts` (headless `@tuvren/session-client` peer driver)
- `spec/conformance/engine/plans/host-session.json` (0.2.0 -> 0.3.0)
- `spec/conformance/tools/plans/tuvren-client-execution-class.json` (0.2.0 -> 0.3.0)
- `spec/conformance/engine/plans/runtime-api-callables-extended.json` (0.7.0 -> 0.8.0)
- `.constitution/reports/epic-al-portability-inventory.json` (0.9.0 -> 0.10.0)
- `.constitution/tech-spec/adrs/ADR-063-host-owned-reattachable-remote-client-session.md` (§6 Consequences, the graduation deferral)
- `.constitution/tech-spec/adrs/ADR-065-idempotency-identity-is-call-identity-not-authority-epoch.md` (§ Consequences, the two open obligations)
- `typescript/runtime/src/lib/idempotency-identity.ts`
