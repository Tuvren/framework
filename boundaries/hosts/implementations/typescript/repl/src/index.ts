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

// biome-ignore lint/performance/noBarrelFile: This package entrypoint is the intentional proving-host surface.
export {
  AIMOCK_PLAYGROUND_PROVIDER_MODES as AIMOCK_REPL_PROVIDER_MODES,
  DEFAULT_GEMINI_PLAYGROUND_MODEL_ID,
  DEFAULT_GEMINI_PLAYGROUND_SCENARIOS as DEFAULT_GEMINI_REPL_SCENARIOS,
  DEFAULT_PLAYGROUND_SCENARIOS as DEFAULT_REPL_SCENARIOS,
  isAimockProviderMode,
  loadPlaygroundConfig as loadReplConfig,
  readReplEnv,
  resolveGoogleApiKey,
} from "./lib/playground-config.js";
export { createPlaygroundHost as createReplHost } from "./lib/playground-host.js";
export {
  haveAllChecksPassed,
  runPlaygroundScenarioMatrix as runReplScenarioMatrix,
} from "./lib/playground-matrix.js";
export { runPlaygroundScenario as runReplScenario } from "./lib/playground-scenarios.js";
export type {
  PlaygroundBackendMode as ReplBackendMode,
  PlaygroundConfig as ReplConfig,
  PlaygroundHost as ReplHost,
  PlaygroundKernelMode as ReplKernelMode,
  PlaygroundProviderMode as ReplProviderMode,
  PlaygroundScenarioMatrixReport as ReplScenarioMatrixReport,
  PlaygroundScenarioName as ReplScenarioName,
  PlaygroundScenarioReport as ReplScenarioReport,
} from "./lib/playground-types.js";
export { createProofExtension } from "./lib/proof-extension.js";
export {
  createReplShell,
  REPL_HELP_TEXT,
  runReplCommand,
  runReplInput,
} from "./lib/repl-shell.js";
