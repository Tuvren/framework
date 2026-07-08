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

// Individual sub-factories/functions are exposed directly (rather than
// composed into a single umbrella factory) so a backend shim that only needs
// one invariant surface (e.g. reclamation alone) is not forced to also supply
// config fields it does not use, and so a shim never needs a reverse
// dependency on another backend-local module it does not otherwise need.
export type { BackendInvariantReclamationDeps } from "./lib/backend-invariant-reclamation.js";
// biome-ignore lint/performance/noBarrelFile: This package entrypoint is the intentional public contract surface.
export { reclaimBackendState } from "./lib/backend-invariant-reclamation.js";
export type {
  BackendInvariantRecordUtils,
  BackendInvariantRecordUtilsConfig,
} from "./lib/backend-invariant-record-utils.js";
export { createBackendInvariantRecordUtils } from "./lib/backend-invariant-record-utils.js";
export type {
  BackendInvariantRunLogic,
  BackendInvariantRunLogicConfig,
} from "./lib/backend-invariant-run-logic.js";
export { createBackendInvariantRunLogic } from "./lib/backend-invariant-run-logic.js";
export type { BackendState } from "./lib/backend-invariant-state.js";
