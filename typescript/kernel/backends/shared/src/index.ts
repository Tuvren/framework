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

import type { ReclamationSummary } from "@tuvren/kernel-protocol";
import {
  type BackendInvariantReclamationDeps,
  reclaimBackendState,
} from "./lib/backend-invariant-reclamation.js";
import {
  type BackendInvariantRecordUtils,
  type BackendInvariantRecordUtilsConfig,
  createBackendInvariantRecordUtils,
} from "./lib/backend-invariant-record-utils.js";
import {
  type BackendInvariantRunLogic,
  type BackendInvariantRunLogicConfig,
  createBackendInvariantRunLogic,
} from "./lib/backend-invariant-run-logic.js";
import type { BackendState } from "./lib/backend-invariant-state.js";

// Individual sub-factories/functions are exposed alongside the composed
// `createKernelBackendInvariantCore` so a backend shim that only needs one
// invariant surface (e.g. reclamation alone) is not forced to also supply
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

export interface KernelBackendInvariantCoreConfig
  extends BackendInvariantRecordUtilsConfig,
    BackendInvariantRunLogicConfig,
    BackendInvariantReclamationDeps {}

/**
 * The composed invariant surface `createKernelBackendInvariantCore` builds.
 * Declared explicitly (rather than inferred) for the same declaration-emit
 * portability reason as `BackendInvariantRecordUtils`.
 */
export interface KernelBackendInvariantCore
  extends BackendInvariantRecordUtils,
    BackendInvariantRunLogic {
  reclaimBackendState(state: BackendState): ReclamationSummary;
}

/**
 * Builds the shared kernel-backend invariant core: the reclamation,
 * record-utils, and run-transition-legality logic that used to be
 * hand-copied (byte-for-byte, modulo error-code prefix) across the memory,
 * SQLite, and PostgreSQL backends.
 *
 * `config.errorPrefix` (e.g. `"memory"`, `"sqlite"`, `"postgres"`)
 * parameterizes every `${errorPrefix}_backend_<reason>` error code this core
 * raises, reproducing each backend's pre-extraction hardcoded literal
 * byte-for-byte when given that backend's own prefix. The remaining config
 * fields inject backend-owned hash/lineage decode helpers that stay local to
 * each backend (they are not part of this extraction) but that the
 * reclamation and run-logic algorithms depend on.
 */
export function createKernelBackendInvariantCore(
  config: KernelBackendInvariantCoreConfig
): KernelBackendInvariantCore {
  const recordUtils = createBackendInvariantRecordUtils(config);
  const runLogic = createBackendInvariantRunLogic(config);

  return {
    ...recordUtils,
    ...runLogic,
    reclaimBackendState: (state: BackendState) =>
      reclaimBackendState(state, config),
  };
}
