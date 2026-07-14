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

import type {
  StoredBranch,
  StoredObject,
  StoredObserveAnnotation,
  StoredOrderedPathChunk,
  StoredRun,
  StoredSchema,
  StoredStagedResult,
  StoredThread,
  StoredTurn,
  StoredTurnNode,
  StoredTurnTree,
  StoredTurnTreePath,
} from "@tuvren/kernel-protocol";

/**
 * The complete durable state of one Scope partition in the memory backend.
 *
 * Maps are keyed by each record family's identity: hash-addressed content
 * (objects, turn nodes, turn trees, ordered path chunks) by content hash, and
 * identity records (threads, branches, turns, runs, schemas) by their ID.
 * `stagedResults` nests by run ID then task ID; `turnTreePaths` nests by turn
 * tree hash then path; `observeAnnotations` keeps an append-only list per run.
 *
 * Structurally identical to `@tuvren/backend-shared`'s `BackendState` — keep
 * the two (and the SQLite/PostgreSQL equivalents) in lockstep.
 */
export interface BackendState {
  branches: Map<string, StoredBranch>;
  objects: Map<string, StoredObject>;
  observeAnnotations: Map<string, StoredObserveAnnotation[]>;
  orderedPathChunks: Map<string, StoredOrderedPathChunk>;
  runs: Map<string, StoredRun>;
  schemas: Map<string, StoredSchema>;
  stagedResults: Map<string, Map<string, StoredStagedResult>>;
  threads: Map<string, StoredThread>;
  turnNodes: Map<string, StoredTurnNode>;
  turns: Map<string, StoredTurn>;
  turnTreePaths: Map<string, Map<string, StoredTurnTreePath>>;
  turnTrees: Map<string, StoredTurnTree>;
}
