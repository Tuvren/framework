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

import type {
  CapabilityInvocationAttribution,
  CapabilityObservation,
  ExecutionClass,
} from "@tuvren/core/capabilities";
import type { TuvrenToolDefinition } from "@tuvren/core/tools";
import { createBindingResolver } from "./binding-resolver.js";

/**
 * Standard per-class CapabilityObservation limits per §3.13 / ADR-046.
 *
 * - tuvren-server: full lifecycle control.
 * - provider-native / provider-mediated: observation from provider-exposed
 *   events/results only; no cancel/retry/audit/resume from Tuvren.
 * - tuvren-client: Tuvren owns orchestration, client owns execution; partial
 *   observability through the dispatch/result envelope.
 */
export function observationForClass(
  executionClass: ExecutionClass
): CapabilityObservation {
  switch (executionClass) {
    case "tuvren-server":
      return {
        canAudit: true,
        canCancel: true,
        canObserveIntermediate: true,
        canPersistResult: true,
        canResume: true,
        canRetry: true,
        executionClass: "tuvren-server",
      };
    case "provider-native":
    case "provider-mediated":
      return {
        canAudit: false,
        canCancel: false,
        canObserveIntermediate: false,
        canPersistResult: true,
        canResume: false,
        canRetry: false,
        executionClass,
      };
    // Tuvren owns orchestration and policy; the client endpoint owns
    // environmental execution. Results are recorded from the dispatch/result
    // envelope plus client-reported details only — no intermediate steps,
    // no cancel/retry/audit/resume from the runtime side. (KRT-AZ005)
    case "tuvren-client":
      return {
        canAudit: false,
        canCancel: false,
        canObserveIntermediate: false,
        canPersistResult: true,
        canResume: false,
        canRetry: false,
        executionClass: "tuvren-client",
      };
    default:
      return {
        canAudit: false,
        canCancel: false,
        canObserveIntermediate: false,
        canPersistResult: true,
        canResume: false,
        canRetry: false,
        executionClass,
      };
  }
}

/**
 * Build a CapabilityInvocationAttribution for a tool definition, using the
 * binding resolver to determine its execution class and endpoint.
 *
 * For the Epic AW foundation phase, all developer-defined and MCP-advertised
 * tools resolve to the tuvren-server class. Provider-native and Tuvren-client
 * attribution is additive in Epics AY and AZ respectively.
 */
export function buildToolAttribution(
  tool: TuvrenToolDefinition
): CapabilityInvocationAttribution {
  const resolver = createBindingResolver();
  const binding = resolver.resolveFromToolDefinition(tool);

  const owner =
    binding.executionClass === "provider-native" ||
    binding.executionClass === "provider-mediated"
      ? "provider"
      : "tuvren";

  return {
    capabilityId: binding.capabilityId,
    executionClass: binding.executionClass,
    observation: observationForClass(binding.executionClass),
    owner,
  };
}
