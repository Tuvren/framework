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
 *
 * Telemetry-funnel destination contract (ADR-058).
 *
 * `TuvrenTelemetrySink` (in `./index.ts`, ADR-042) is a push-based, fire-and-
 * forget *emission* interface. It is not a durable *destination*: it has no
 * delivery contract, no buffering/backpressure semantics, and no channel to
 * surface a delivery failure. ADR-058 adds the missing half so the two-funnel
 * routing decision (CAP-P0-072) has a construction-time seam to bind to, and so
 * the deferred ready-made destination adapters (CAP-P1-073) have a stable
 * contract to implement against before the SDK freeze (ADR-054).
 *
 * The one-directional failure-isolation invariant (Architecture v0.12.0 Data
 * Funnel Separation Model; ADR-058 §3) is enforced at the runtime telemetry
 * boundary (`@tuvren/runtime` `runtime-core-telemetry.ts`), not here: a
 * `deliver` throw is caught there, converted to a {@link
 * TelemetryOperationalSignal}, and can never fail, block, or delay a
 * content-funnel commit or kernel checkpoint. These types only declare the
 * contract; they carry no runtime behavior.
 */

import type {
  TelemetryEvent,
  TelemetrySpan,
  TelemetrySpanError,
  TuvrenTelemetrySink,
} from "./index.js";

/**
 * How a destination bounds and sheds telemetry records when it cannot keep up.
 * Owned and declared by the destination adapter (ADR-058 §1) — the runtime does
 * not enforce it; it is a descriptor an operator can inspect to reason about
 * funnel health. A destination that never buffers omits this field.
 */
export interface TelemetryBufferingPolicy {
  /**
   * Maximum number of telemetry records the destination retains before applying
   * {@link overflowStrategy}.
   */
  maxBufferedRecords: number;
  /**
   * What the destination does with a record when the buffer is already at
   * {@link maxBufferedRecords}: evict the oldest buffered record, or drop the
   * newly arriving one. Either way the destination should raise a
   * `buffer_overflow` {@link TelemetryOperationalSignal} so the drop is not
   * silent.
   */
  overflowStrategy: "drop_newest" | "drop_oldest";
}

/**
 * Funnel-health signal kinds. `delivery_failed` and `sink_failed` are raised by
 * the runtime telemetry boundary when a `deliver`/sink call throws;
 * `buffer_overflow` is raised by a destination adapter when it sheds a record
 * under {@link TelemetryBufferingPolicy}.
 */
export type TelemetryOperationalSignalKind =
  | "buffer_overflow"
  | "delivery_failed"
  | "sink_failed";

/**
 * Telemetry-about-telemetry: an operator-observable notice that funnel health
 * degraded. It is never an input to session correctness, continuity, or
 * recovery (ADR-058 §3). `error` reuses the already-secret-screened
 * {@link TelemetrySpanError} shape and is absent for non-exceptional signals
 * such as `buffer_overflow`.
 */
export interface TelemetryOperationalSignal {
  error?: TelemetrySpanError;
  kind: TelemetryOperationalSignalKind;
}

/**
 * A durable delivery target for telemetry-funnel records (ADR-058 §1), distinct
 * from {@link TuvrenTelemetrySink}. Records arrive in the existing canonical
 * vocabulary and lineage keys, already secret-screened by the runtime.
 */
export interface TelemetryDestination {
  /**
   * Declared buffering/backpressure policy, if the destination buffers.
   * Informational: the runtime does not read it.
   */
  buffering?: TelemetryBufferingPolicy;
  /**
   * Accept a batch of correlated telemetry records. MUST NOT throw as a normal
   * control path — a delivery failure is reported via {@link onOperationalSignal}
   * (the runtime additionally catches any throw at its telemetry boundary and
   * converts it to a `delivery_failed` signal, so a throw can never reach the
   * session path). The runtime imposes no batching; a destination that wants
   * larger batches buffers internally.
   */
  deliver(batch: ReadonlyArray<TelemetryEvent | TelemetrySpan>): void;
  /**
   * Host/operator-observable funnel-health channel. When present, the runtime
   * routes `delivery_failed`/`sink_failed` signals here; the destination itself
   * raises `buffer_overflow`. When absent, the runtime falls back to a
   * last-resort one-shot warning so a degraded funnel is never fully silent.
   */
  onOperationalSignal?(signal: TelemetryOperationalSignal): void;
}

/**
 * Construction-time funnel-routing seam (ADR-058 §2). Combines an emission
 * {@link TuvrenTelemetrySink} and/or a durable {@link TelemetryDestination};
 * both are optional so a host can route to either, both, or (degenerately)
 * neither. Passed as the `telemetry` option to `createTuvren`, alongside the
 * bare-sink and bare-destination forms, which together express split, unified,
 * and mixed-substrate topologies with no session-behavior difference.
 */
export interface TelemetryRoute {
  destination?: TelemetryDestination;
  sink?: TuvrenTelemetrySink;
}

/**
 * The full construction-time `telemetry` option: a bare sink (ADR-042,
 * backward-compatible), a bare destination, or a route combining both.
 */
export type TelemetryRouting =
  | TelemetryDestination
  | TelemetryRoute
  | TuvrenTelemetrySink;
