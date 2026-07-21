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
 * (ADR-052 as amended by ADR-065, KRT-BG003).
 *
 * A side-effecting invocation carries an idempotency identity derived from the
 * **logical call identity** `(turnId, callId)` so the external system or client
 * environment that actually performs the effect can deduplicate a dispatch it
 * has already seen. Every dispatch of one logical call — the first attempt, a
 * framework retry, a re-dispatch after an approval resume or a preemption
 * recovery, and a redelivery after a reconnect (ADR-063) — therefore presents
 * an identical key.
 *
 * Both components are stable by construction, and this pairing is the minimal
 * tuple that is stable *and* unique:
 * - `turnId` identifies the user-visible interaction unit. A Turn deliberately
 *   spans many Runs (kernel spec §5.3: "A Turn may be served by multiple Runs
 *   if execution pauses and resumes"), and every resume and recovery path
 *   threads the existing `handle.turnId` through unchanged rather than minting
 *   a new one.
 * - `callId` is framework-generated exactly once, when the assistant's tool-call
 *   part is first parsed, and is never re-minted. Recovery re-presents it from
 *   committed or staged state — a stability skip-completed-by-`callId` recovery
 *   already depends on (framework spec §4.9, §8.6).
 *
 * Two identifiers ADR-052 originally specified are deliberately **excluded**,
 * because neither is stable for one logical call:
 * - The run **fencing token** rotates on every lease renewal.
 * - The **`runId`** is fresher still: a Run is one execution *attempt*, and the
 *   framework mints a new one for every ReAct iteration, every approval resume,
 *   and every recovery (a replacement execution MUST be a new Run — kernel spec
 *   §5.2). Keying on it made the identity churn even in a healthy loop.
 *
 * Fencing answers "may I commit this?" (still enforced, at the staging fence,
 * ADR-052 §3); this key answers "which logical call is this?". Conflating the
 * two made the second unstable for precisely as long as the first was doing its
 * job.
 *
 * The pair is encoded as a canonical, injective JSON array so no delimiter
 * collision can fold two distinct pairs onto one key, then hashed to a
 * fixed-length, opaque hex digest suitable for presenting to an external system
 * as an idempotency key.
 */
export function deriveIdempotencyKey(turnId: string, callId: string): string {
  const canonical = JSON.stringify([turnId, callId]);
  return createHash("sha256").update(canonical).digest("hex");
}
