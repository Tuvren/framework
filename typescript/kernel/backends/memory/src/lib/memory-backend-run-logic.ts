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
// core (KRT-BK001): the run-transition-legality behavior it exposes is
// identical to the PostgreSQL backend's copy modulo the `memory_backend_*`
// error-code prefix. See @tuvren/backend-shared for the actual
// implementation. `decodeRunCreatedTurnNodeHashes` stays backend-owned (it
// is not part of this extraction) and is injected into the shared core.
import { createBackendInvariantRunLogic } from "@tuvren/backend-shared";
import { decodeRunCreatedTurnNodeHashes } from "./memory-backend-lineage.js";

const runLogic = createBackendInvariantRunLogic({
  decodeRunCreatedTurnNodeHashes,
  errorPrefix: "memory",
});

export const { assertMonotonicUpdatedAtMs, assertRunUpdateIsLegal } = runLogic;
