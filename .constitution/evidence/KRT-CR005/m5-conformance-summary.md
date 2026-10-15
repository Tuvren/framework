# KRT-CR005 M5 conformance summary

The runtime lifecycle extended plan is promoted from `0.2.0` to `0.3.0`, with the same version pinned by the core authority packet. Three shared-harness checks under `runtime-lifecycle-ext.stale-recovery` grade implementation-emitted observations:

- recovered interrupted batches do not invoke the runner before resumed dispatch completes;
- dispatched call IDs equal the durable missing set, including the missing `nonRetryable` call;
- each resumed call presents the idempotency key observed for the same original `(turnId, callId)` identity.

The TypeScript adapter drives the scenario and returns runtime events, dispatch contexts, and durable messages. It does not receive check IDs, grade results, emit check-scoped evidence, or replay fixtures.

Lead verification passed the full conformance fleet, with 502 applicable TypeScript framework checks and zero failures, and the focused certification lane. The first compatibility refresh recorded a transient Rust gRPC startup timeout and was correctly rejected. The isolated interop target then passed all eleven scenarios under serial scheduling. A complete serial refresh replaced the transient artifact, and `compatibility:check` passed. The final compatibility diff contains only the matrix and three certification evidence files affected by the promoted checks; the Rust interop artifact returned to its accepted pass bytes.

Milestone review found that pair equality alone would accept matching absent idempotency keys because the adapter records absence as `null`. The shared plan now also requires every original and resumed `idempotencyKey` observation to match a nonempty-string pattern. The adapter remains observation-only. Plan validation and focused certification pass, a complete serial compatibility refresh records the four additional passing assertions, and the final compatibility check passes.
