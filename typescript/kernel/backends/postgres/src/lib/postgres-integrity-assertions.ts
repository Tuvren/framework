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

import { createBackendInvariantIntegrityAssertions } from "@tuvren/backend-shared";
import { getRunActiveTurnNodeHash } from "./postgres-run-invariants.js";

// This module is a thin delegate to the shared kernel-backend invariant core
// (KRT-BK001) for the integrity-assertion surface: `assertTurnParentLink`,
// `listTurnsByThread`, `assertBackwardBranchMoveIsArchived`,
// `assertChunkedTurnTreePathChunkLayout`, `ORDERED_PATH_CHUNK_SIZE`, and
// `ensureImmutableRecordMatch` are identical to the SQLite backend's copies
// modulo the `postgres_backend_*` error-code prefix. See
// @tuvren/backend-shared for the actual implementation.
// `getRunActiveTurnNodeHash` stays backend-owned (it is derived from this
// backend's own `createdTurnNodesCbor` lineage decoder) and is injected into
// the shared factory.
const integrityAssertions = createBackendInvariantIntegrityAssertions({
  errorPrefix: "postgres",
  getRunActiveTurnNodeHash,
});

export const {
  assertBackwardBranchMoveIsArchived,
  assertChunkedTurnTreePathChunkLayout,
  assertTurnParentLink,
  ensureImmutableRecordMatch,
  listTurnsByThread,
  ORDERED_PATH_CHUNK_SIZE,
} = integrityAssertions;
