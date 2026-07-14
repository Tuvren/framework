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

import type { HashString } from "@tuvren/core";
import type {
  AgentConfig,
  ContextEngineeringHelpers,
  HandoffContextPlan,
  HandoffSourceContext,
} from "@tuvren/core/execution";
import type { TuvrenMessage } from "@tuvren/core/messages";
import type { RuntimeRunner } from "@tuvren/core/runner";
import type { FacadeOpsDependencies } from "./runtime-core-facade-ops.js";
import {
  materializeContextMessagesFacade,
  materializeRunnerFacade,
  resolveFailureActiveConfigFacade,
  resolveHandoffSourceContextFacade,
} from "./runtime-core-facade-ops.js";
import type { HeadState, LoopState } from "./runtime-core-loop.js";

/**
 * Resolves the {@link HandoffSourceContext} for an agent handoff; a
 * runtime-core-named adapter over
 * {@link resolveHandoffSourceContextFacade}.
 */
export function resolveRuntimeCoreHandoffSourceContext(
  dependencies: Pick<
    FacadeOpsDependencies,
    "cloneAgentConfigForRequest" | "kernel"
  >,
  plan: HandoffContextPlan,
  headState: HeadState,
  loopState: LoopState,
  targetConfig: AgentConfig,
  helpers: ContextEngineeringHelpers
): HandoffSourceContext {
  return resolveHandoffSourceContextFacade(
    dependencies,
    plan,
    headState,
    loopState,
    targetConfig,
    helpers
  );
}

/**
 * Materializes context messages from their hashes; a runtime-core-named
 * adapter over {@link materializeContextMessagesFacade}, which converts a
 * missing hash into a `TuvrenLineageError` with code `missing_message`.
 */
export function materializeRuntimeCoreContextMessages(
  hashes: HashString[],
  helpers: ContextEngineeringHelpers
): TuvrenMessage[] {
  return materializeContextMessagesFacade(hashes, helpers);
}

/**
 * Materializes a registered {@link RuntimeRunner} by id; a runtime-core-named
 * adapter over {@link materializeRunnerFacade}, which throws
 * `unknown_runner` for unregistered ids.
 */
export function materializeRuntimeCoreRunner(
  runnerRegistry: Parameters<typeof materializeRunnerFacade>[0],
  runnerId: string
): RuntimeRunner {
  return materializeRunnerFacade(runnerRegistry, runnerId);
}

/**
 * Resolves the {@link AgentConfig} to attribute a failure to; a
 * runtime-core-named adapter over {@link resolveFailureActiveConfigFacade}.
 */
export function resolveRuntimeCoreFailureActiveConfig(
  requestConfig: AgentConfig,
  activeAgentName: string,
  resolveAgentConfig: FacadeOpsDependencies["resolveAgentConfig"]
): AgentConfig {
  return resolveFailureActiveConfigFacade(
    requestConfig,
    activeAgentName,
    resolveAgentConfig
  );
}
