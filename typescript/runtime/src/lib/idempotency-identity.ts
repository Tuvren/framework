/**
 * Copyright 2026 Oscar Yáñez Cisterna (@SkrOYC)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { createHash } from "node:crypto";

/**
 * Derive the side-effect-once idempotency identity for a tool invocation
 * (ADR-052, KRT-BG003).
 *
 * A side-effecting invocation carries an idempotency identity derived from
 * `(runId, callId, fencingToken)` so the external system or client environment
 * that actually performs the effect can deduplicate a retried dispatch. The
 * identity is a pure, deterministic function of the triple: presenting the same
 * triple — for example when the same logical call is re-dispatched after a
 * recovery that re-presents the same identifiers — always yields the same key.
 *
 * The fencing token is optional: a runtime without run-liveness leases has no
 * fencing token, in which case the identity is derived from `(runId, callId)`
 * alone (with the absent token normalized so it can never collide with an
 * empty-string token). The triple is encoded as a canonical, injective JSON
 * array so no delimiter collision can fold two distinct triples onto one key,
 * then hashed to a fixed-length, opaque hex digest suitable for presenting to
 * an external system as an idempotency key.
 */
export function deriveIdempotencyKey(
  runId: string,
  callId: string,
  fencingToken?: string
): string {
  const canonical = JSON.stringify([runId, callId, fencingToken ?? null]);
  return createHash("sha256").update(canonical).digest("hex");
}
