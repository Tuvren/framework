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

// This module is a thin delegate to the shared kernel-backend invariant
// core (KRT-BK001): the §9.4 reachability reclamation algorithm it exposes
// is identical to the memory and PostgreSQL backends' copies (this file's
// own pre-extraction JSDoc already said as much). See @tuvren/backend-shared
// for the actual implementation. The decode/resolve helpers below stay
// backend-owned (they are not part of this extraction) and are injected into
// the shared algorithm.
import { reclaimBackendState as reclaimSharedBackendState } from "@tuvren/backend-shared";
import type { EpochMs } from "@tuvren/core";
import type { ReclamationSummary } from "@tuvren/kernel-protocol";
import { type BackendState, decodeHashStringArray } from "./sqlite-records.js";
import {
  decodeRunCreatedTurnNodeHashes,
  decodeTurnNodeConsumedStagedResultObjectHashes,
} from "./sqlite-run-invariants.js";
import { resolveStoredTurnTreePathValue } from "./sqlite-state-validation.js";

/**
 * Runs the shared §9.4 reachability reclamation sweep over a loaded state
 * projection, mutating it in place, with the SQLite backend's own CBOR
 * lineage decoders injected. `nowMs` only affects whether an expired
 * leaseless running run stops pinning the grace horizon; reachability is
 * clock-independent. The caller diffs the swept projection against the
 * pre-sweep keys to mirror the deletions into the database.
 *
 * @returns Counts of released and retained records.
 * @see `reclaimBackendState` in `@tuvren/backend-shared` for the algorithm.
 */
export function reclaimBackendState(
  state: BackendState,
  nowMs: EpochMs
): ReclamationSummary {
  return reclaimSharedBackendState(
    state,
    {
      decodeHashStringArray,
      decodeRunCreatedTurnNodeHashes,
      decodeTurnNodeConsumedStagedResultObjectHashes,
      resolveStoredTurnTreePathValue,
    },
    nowMs
  );
}
