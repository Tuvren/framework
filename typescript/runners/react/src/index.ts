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
 * @packageDocumentation
 *
 * `@tuvren/runner-react` implements the ReAct (reason-then-act) shared runner:
 * a single-provider-call-per-iteration `RuntimeRunner` that drives the model,
 * accumulates its streamed response into a durable assistant message, and
 * resolves the next framework iteration decision from `AgentConfig.loopPolicy`
 * (KrakenFrameworkSpecification §5.6).
 *
 * The runner never mutates framework-owned state directly: it returns
 * explicit `RunnerExecutionResult` values (`resolution`, `messages`,
 * `stateUpdates`, `toolExecutionMode`) for the shared core to apply, and it
 * only emits assistant stream-content and custom events through
 * `context.runtime.emit` — never the framework-owned lifecycle events
 * (`turn.*`, `iteration.*`, `tool.*`, `approval.*`, `state.*`, `error`).
 * Errors are normalized into `fail` resolutions rather than thrown across the
 * runner boundary.
 *
 * The public surface is intentionally small: {@link createReActRunner}
 * builds a `RuntimeRunnerFactory`, and {@link REACT_RUNNER_ID} identifies the
 * runner instances it produces.
 */
// biome-ignore-all lint/performance/noBarrelFile: This package entrypoint is the intentional public implementation surface.
export type {
  ReActRunnerOptions,
  ReActRunnerProviderCallMode,
  ReActRunnerProviderCallModeResolver,
  ReActRunnerToolExecutionModeResolver,
} from "./lib/react-runner.js";
export { createReActRunner, REACT_RUNNER_ID } from "./lib/react-runner.js";
