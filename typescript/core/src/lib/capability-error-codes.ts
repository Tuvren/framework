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

/**
 * Stable `TuvrenRuntimeError` code emitted when no admissible binding exists
 * for a capability (e.g. the target execution-class endpoint is not yet
 * attached or all candidate bindings are unavailable). Surfaced as a
 * `tool.result` with `isError: true` per §4.21. Shared across the runtime,
 * policy engine, and attribution surfaces.
 */
export const CAPABILITY_BINDING_UNAVAILABLE =
  "capability_binding_unavailable" as const;

/**
 * Stable `TuvrenValidationError` code emitted when a Tuvren-server invocation
 * input fails validation against the declared contract before execution. Per
 * §4.21, surfaced as `tool.result` with `isError: true`. (AX001)
 */
export const TOOL_INPUT_VALIDATION_FAILED =
  "tool_input_validation_failed" as const;

/**
 * Stable `TuvrenValidationError` code emitted when a Tuvren-server invocation
 * output fails validation against the declared result shape before being
 * surfaced. Per §4.21, surfaced as `tool.result` with `isError: true`. (AX001)
 */
export const TOOL_RESULT_VALIDATION_FAILED =
  "tool_result_validation_failed" as const;

/**
 * Stable `TuvrenRuntimeError` code emitted when a Tuvren-server invocation is
 * rejected because the configured per-tenant rate budget is exhausted. Surfaced
 * as `tool.result` with `isError: true` per §4.21. (AX003)
 */
export const TOOL_INVOCATION_RATE_LIMITED =
  "tool_invocation_rate_limited" as const;

/**
 * Stable code emitted when a `tuvren-client` invocation result is discarded
 * because the endpoint echoed a `leaseToken` (or `callId`) that does not match
 * the values generated for this dispatch. The result was produced for a prior
 * invocation and cannot mutate the current one. Surfaced as `tool.result`
 * with `isError: true`. Distinct from `capability_binding_unavailable`, which
 * signals that no endpoint is currently attached for the capability. (KRT-AZ003)
 */
export const CAPABILITY_RESULT_STALE = "capability_result_stale" as const;

/**
 * Stable capability error code synthesized when a `tuvren-client` invocation
 * dispatched to a *reachable* remote peer receives no `client_result` within
 * the configured `dispatchTimeoutMs`. Never thrown: `@tuvren/remote-session`
 * settles the dispatch with a well-shaped `ClientReportedResult` whose
 * `content` carries the `{ code, error }` shape
 * (`spec/host/client-endpoint-integration.md`, "Error handling"), surfaced as
 * `tool.result` with `isError: true` and joining
 * `capability_binding_unavailable` and `capability_result_stale` in the §4.21
 * error family (`docs/KrakenFrameworkSpecification.md`). Distinct from
 * `capability_binding_unavailable` — which means no endpoint is attached, or
 * the disconnect grace window expired with none reattaching — this code means
 * the endpoint *is* attached and accepted the work but went quiet; the two
 * budgets are deliberately independent so a peer given a fresh chance after
 * reconnecting is never handed a deadline that expired while it was
 * unreachable. Owned by `@tuvren/remote-session` (ADR-063 §5).
 */
export const CAPABILITY_DISPATCH_TIMEOUT =
  "capability_dispatch_timeout" as const;

/**
 * Stable code emitted when {@link AgentConfig.sanitizeToolResult} (ADR-064)
 * throws instead of returning a sanitized `ToolResultPart`. The runtime does
 * not swallow the throw into a scrubbed-by-default result — silently
 * substituting content the host did not author would be a worse failure than
 * a loud one — and does not fail the turn either: per framework spec §8.6
 * (tool failures become results, never turn failures), the throw surfaces as
 * this call's own `isError: true` tool result, and the turn continues.
 * Surfaced as `tool.result` with `isError: true`.
 */
export const TOOL_RESULT_SANITIZATION_FAILED =
  "tool_result_sanitization_failed" as const;

/**
 * Stable `TuvrenRuntimeError` code emitted when a turn breaches a framework
 * hard-stop execution bound (`maxIterations`, `maxToolCalls`, or
 * `maxWallClockMs`) above runner discretion. The framework stops the loop,
 * checkpoints a safe terminal outcome, and finalizes the turn as a `failed`
 * `ExecutionResult` carrying this code with `details: ExecutionBoundExceededDetails`,
 * plus a fatal canonical `error` event with the same code/details. The runner
 * cannot raise or disable a bound. (ADR-043 §3.11, KRT-BD005)
 */
export const EXECUTION_BOUND_EXCEEDED = "execution_bound_exceeded" as const;
