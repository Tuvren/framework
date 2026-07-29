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

import { createBackendInvariantStateValidation } from "@tuvren/backend-shared";
import {
  decodeHashStringArray,
  decodeTurnTreeSchema,
} from "./sqlite-records.js";

// This module is a thin delegate to the shared kernel-backend invariant core
// (KRT-BK001) for the committed-state validation surface:
// `validateLoadedState`, `validateCommittedState`,
// `validateTurnTreePathInvariants`, and `resolveStoredTurnTreePathValue` are
// identical to the PostgreSQL backend's copies modulo the `sqlite_backend_*`
// error-code prefix. See @tuvren/backend-shared for the actual
// implementation. `decodeHashStringArray`/`decodeTurnTreeSchema` stay
// backend-owned (each backend has its own records module) and are injected
// into the shared factory.
const stateValidation = createBackendInvariantStateValidation({
  decodeHashStringArray,
  decodeTurnTreeSchema,
  errorPrefix: "sqlite",
});

export const {
  resolveStoredTurnTreePathValue,
  validateCommittedState,
  validateLoadedState,
  validateTurnTreePathInvariants,
} = stateValidation;
