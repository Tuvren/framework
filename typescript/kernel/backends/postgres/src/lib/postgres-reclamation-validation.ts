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

// This module is a thin delegate to the shared kernel-backend invariant core
// (KRT-BK001) for the reclamation-survivor-invariant surface
// (`assertReclamationSurvivorInvariants` and its private per-family
// sub-checks): identical to the SQLite backend's copy modulo the
// `postgres_backend_*` error-code prefix and this backend's own short
// storage-shape footnote below. See @tuvren/backend-shared's
// `createBackendInvariantReclamationValidation` for the full rationale
// (issue #108 M6) and the actual implementation. The decode/resolve helpers
// stay backend-owned (they are not part of this extraction) and are
// injected into the shared factory.
import { createBackendInvariantReclamationValidation } from "@tuvren/backend-shared";
import {
  type BackendState,
  decodeHashStringArray,
} from "./postgres-records.js";
import {
  decodeRunCreatedTurnNodeHashes,
  decodeTurnNodeConsumedStagedResultObjectHashes,
} from "./postgres-run-invariants.js";
import { resolveStoredTurnTreePathValue } from "./postgres-state-validation.js";

const reclamationValidation = createBackendInvariantReclamationValidation({
  decodeHashStringArray,
  decodeRunCreatedTurnNodeHashes,
  decodeTurnNodeConsumedStagedResultObjectHashes,
  errorPrefix: "postgres",
  resolveStoredTurnTreePathValue,
});

/**
 * See {@link createBackendInvariantReclamationValidation} for the full
 * reclamation-survivor-invariant rationale (issue #108 M6), including the
 * six-point enumeration of what a reclamation sweep's deletion can actually
 * break and how each case is covered.
 *
 * This backend's storage-shape footnote: the FK constraints item 1 of that
 * enumeration refers to are declared `DEFERRABLE INITIALLY DEFERRED` in
 * `migrations/0001_relational_schema.sql`, which PostgreSQL enforces at
 * `COMMIT` rather than per-statement — the same mechanism `reclaim()`
 * already relies on to let its batched deletes run in any table order.
 * `deletedTurnNodeHashes` (item 5) is computed once in
 * `postgres-backend.ts`'s `applyReclamationDeletions`.
 *
 * @throws TuvrenPersistenceError with a `postgres_backend_*` code on the first
 *   invariant a defective sweep violated.
 */
export function assertReclamationSurvivorInvariants(state: BackendState): void {
  reclamationValidation.assertReclamationSurvivorInvariants(state);
}
