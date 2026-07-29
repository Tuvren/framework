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

import {
  createBackendInvariantRecordUtils,
  createBackendInvariantRunLogic,
  createBackendInvariantRunSpan,
} from "@tuvren/backend-shared";
import type { StoredRun } from "@tuvren/kernel-protocol";
import { cloneEncodedBytes, decodeHashStringArray } from "./sqlite-records.js";

export type { TurnNodeRelationship } from "@tuvren/backend-shared";

// This module is a thin delegate to the shared kernel-backend invariant core
// (KRT-BK001) for: the run-transition-legality and immutability-primitive
// surface (`assertRunUpdateIsLegal` and its private sub-assertions,
// `assertImmutableField`/`assertImmutableOptionalField`/`assertImmutableBytes`),
// and the run-turn-span invariant surface (`assertRunStartTurnNodeWithinTurnSpan`,
// `assertRunCreatedTurnNodeWithinTurnSpan`, `assertRunCreatedTurnNodesAreCanonical`,
// `assertActiveRunHeadAlignment`, `classifyTurnNodeRelationship`,
// `decodeTurnNodeConsumedStagedResultObjectHashes`). All of these are
// identical to the memory and PostgreSQL backends' copies modulo the
// `sqlite_backend_*` error-code prefix. See @tuvren/backend-shared for the
// actual implementations. `decodeRunCreatedTurnNodeHashes` stays backend-owned
// (it is not part of this extraction, and this same module still needs it
// below for sqlite-specific lineage checks) and is injected into both
// shared factories. `function` hoisting makes the later declaration in this
// module available here at call time.
const runLogic = createBackendInvariantRunLogic({
  decodeRunCreatedTurnNodeHashes,
  errorPrefix: "sqlite",
});
const recordUtils = createBackendInvariantRecordUtils({
  cloneEncodedBytes,
  errorPrefix: "sqlite",
});
const runSpan = createBackendInvariantRunSpan({
  decodeRunCreatedTurnNodeHashes,
  errorPrefix: "sqlite",
});

export const { assertMonotonicUpdatedAtMs, assertRunUpdateIsLegal } = runLogic;
export const {
  assertImmutableBytes,
  assertImmutableField,
  assertImmutableOptionalField,
  validateHashString,
} = recordUtils;
export const {
  assertActiveRunHeadAlignment,
  assertRunCreatedTurnNodesAreCanonical,
  assertRunCreatedTurnNodeWithinTurnSpan,
  assertRunStartTurnNodeWithinTurnSpan,
  classifyTurnNodeRelationship,
  decodeTurnNodeConsumedStagedResultObjectHashes,
} = runSpan;

/**
 * Decodes a run's `createdTurnNodesCbor` into its ordered, append-only list
 * of created turn node hashes.
 */
export function decodeRunCreatedTurnNodeHashes(run: StoredRun): string[] {
  return decodeHashStringArray(
    run.createdTurnNodesCbor,
    "run.createdTurnNodesCbor"
  );
}

/**
 * A run's active turn node: the most recently created node in its
 * `createdTurnNodesCbor` lineage, or its start turn node when the run has
 * not created any nodes yet.
 */
export function getRunActiveTurnNodeHash(run: StoredRun): string {
  const createdTurnNodeHashes = decodeRunCreatedTurnNodeHashes(run);
  return createdTurnNodeHashes.at(-1) ?? run.startTurnNodeHash;
}
