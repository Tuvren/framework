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
// `postgres_backend_*` error-code prefix and this backend's own accurate
// FK/storage-shape docblock below. See @tuvren/backend-shared for the actual
// implementation. The decode/resolve helpers stay backend-owned (they are
// not part of this extraction) and are injected into the shared factory.
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
 * Issue #108 M6 — replaces `reclaim()`'s former second full
 * `loadValidatedState` pass (a fresh `loadState` from disk plus the entire
 * per-record identity re-hash / lineage-root-index / committed-state
 * validation suite). This function instead runs a *targeted* check directly
 * over the in-memory, already-swept `state` projection: the same object
 * `loadValidatedState`'s first call fully validated before
 * `reclaimBackendState` mutated it in place, so there is nothing left to
 * re-validate about record shape/identity (the sweep never edits a
 * surviving record's fields, only deletes whole entries) — only whether a
 * surviving record now references something the sweep deleted.
 *
 * Enumeration of what reclamation's deletion can actually break, and how
 * each is covered:
 *
 * 1. **Surviving turn nodes' `previousTurnNodeHash` ancestor chain,
 *    branches' `headTurnNodeHash`, threads' `rootTurnNodeHash`, turns'
 *    thread/branch references, and runs' turn/branch/start-turn-node
 *    references** are all backed by real, scope-qualified SQL `FOREIGN KEY`
 *    constraints (`migrations/0001_relational_schema.sql`) declared
 *    `DEFERRABLE INITIALLY DEFERRED`, which PostgreSQL itself enforces at
 *    `COMMIT` rather than per-statement — the exact mechanism `reclaim()`
 *    already relies on to let its batched deletes run in any table order. A
 *    defective sweep that broke one of these would fail the real `COMMIT`,
 *    not silently persist. This function re-checks the same references
 *    anyway, in memory, before `COMMIT` ever runs: it is redundant with the
 *    deferred FK in the sense that both would catch the same defect, but it
 *    produces a friendly `postgres_backend_*` error instead of a raw
 *    PostgreSQL constraint-failure message, and it fails fast without a round
 *    trip through the database engine's own commit path.
 * 2. **Turn nodes' `consumedStagedResultsCbor` and runs'
 *    `createdTurnNodesCbor`** are opaque CBOR-encoded hash arrays stored
 *    inside a `BYTEA` column, not columns a `FOREIGN KEY` can target — a
 *    real foreign-key constraint can only bind a whole column to a whole
 *    referenced column, not individual hashes packed inside one row's bytes.
 *    This is the genuine gap the schema's real foreign keys cannot close by
 *    themselves; this function decodes both and checks every referenced hash
 *    still exists among the survivors.
 * 3. **Turn-tree paths' resolved object/chunk references** (`single_hash`,
 *    `ordered_inline_cbor`, `ordered_chunk_list_cbor`) are the same kind of
 *    opaque, non-FK-backed reference. This function resolves every
 *    surviving path with the same `resolveStoredTurnTreePathValue` the
 *    sweep's own keep-closure computation (`keepPathObjects` in
 *    `backend-invariant-reclamation.ts`) uses to decide what to retain, and
 *    checks the resolved hash(es) still exist among the survivors.
 * 4. **Staged results' `objectHash`/`runId`, and turn-tree paths'
 *    `turnTreeHash`** are FK-backed columns, but both are additionally
 *    guaranteed by the sweep's own bookkeeping: a staged result can only
 *    ever survive alongside its owning run (`sweepRuns` deletes
 *    `state.stagedResults.get(runId)` in the same iteration it deletes
 *    `state.runs.get(runId)`), and a path collection can only ever survive
 *    alongside its owning turn tree (`sweepTurnTrees` deletes
 *    `state.turnTreePaths` in the same iteration it deletes
 *    `state.turnTrees`) — so both cross-references going stale is
 *    structurally impossible. This function still checks them, at
 *    negligible cost, as direct defense against a defect in that same sweep
 *    logic.
 * 5. **The derived `turn_node_lineage_roots` index table** is deleted using
 *    the exact same key list (`deletedTurnNodeHashes`, computed once in
 *    `postgres-backend.ts`'s `applyReclamationDeletions` — same shape as the
 *    SQLite path's `applyReclamationDeletions`) as the `turn_nodes`
 *    rows themselves, so its surviving row set is provably identical to
 *    `turn_nodes`' surviving row set by construction. Nothing to re-check
 *    against the database for this table.
 * 6. **The cached `(rootTurnNodeHash, depth)` value inside each surviving
 *    `turn_node_lineage_roots` row** is left untouched by deletion (which
 *    only removes rows, never edits a surviving row's columns), and the
 *    sweep's keep-closure walk (`closeTurnNodeReachability` in
 *    `backend-invariant-reclamation.ts`) retains a kept turn node's *entire*
 *    ancestor chain back to genesis, never a partial prefix — so a
 *    surviving node's ancestor chain is exactly the same set of nodes it
 *    was before the sweep, and the cached value `loadValidatedState`'s first
 *    call already validated cannot have gone stale. This function's own
 *    lineage-chain walk (item 1 above) independently re-derives the same
 *    ancestor chain and would surface a broken link if that structural
 *    guarantee were ever violated by a defective sweep, so this is covered
 *    transitively rather than by a second read of the table.
 *
 * Beyond the specific references enumerated above, this is why a purely
 * referential check suffices for every semantic committed-state invariant
 * `validateCommittedState` enforces, not only the ones covered by name here:
 * a deletion-only sweep never edits a surviving record's fields, so the only
 * way it can break a semantic invariant is by leaving a surviving record
 * pointing at something the sweep removed. Every existence-dependent
 * invariant therefore fails exclusively through a dangling reference, which
 * the referential checks above plus PostgreSQL's deferred foreign keys catch.
 * Invariants quantified over the whole surviving set (e.g.
 * at-most-one-active-run-per-branch, branch-head/turn-node alignment) can
 * only shrink their domain under deletion — they cannot acquire a new
 * violation — and were already proven for every surviving record by
 * `loadValidatedState`'s full, pre-sweep validation.
 *
 * @throws TuvrenPersistenceError with a `postgres_backend_*` code on the first
 *   invariant a defective sweep violated.
 */
export function assertReclamationSurvivorInvariants(state: BackendState): void {
  reclamationValidation.assertReclamationSurvivorInvariants(state);
}
