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
// biome-ignore-all lint/performance/noBarrelFile: This package entrypoint is the intentional proving-host surface.

export { createProofExtension } from "./lib/proof-extension.js";
export {
  AIMOCK_REPL_PROVIDER_MODES,
  DEFAULT_GEMINI_REPL_MODEL_ID,
  DEFAULT_GEMINI_REPL_SCENARIOS,
  DEFAULT_REPL_SCENARIOS,
  isAimockProviderMode,
  loadReplConfig,
  readReplEnv,
  resolveGoogleApiKey,
} from "./lib/repl-config.js";
export { createReplHost } from "./lib/repl-host.js";
export {
  haveAllChecksPassed,
  runReplScenarioMatrix,
} from "./lib/repl-scenario-matrix.js";
export { runReplScenario } from "./lib/repl-scenarios.js";
export {
  createReplShell,
  REPL_HELP_TEXT,
  runReplCommand,
  runReplInput,
} from "./lib/repl-shell.js";
export type {
  ReplTranscriptBackendConfig,
  ReplTranscriptHeader,
} from "./lib/repl-transcript.js";
export {
  createReplTranscriptWriter,
  redactReplTranscriptBackendConfig,
  redactReplTranscriptBackendOptions,
  redactReplTranscriptHeader,
  serializeReplTranscriptRecord,
} from "./lib/repl-transcript.js";
export type {
  ReplBackendMode,
  ReplConfig,
  ReplHost,
  ReplKernelMode,
  ReplProviderMode,
  ReplScenarioMatrixReport,
  ReplScenarioName,
  ReplScenarioReport,
} from "./lib/repl-types.js";
