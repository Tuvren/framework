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

/**
 * Stable `TuvrenRuntimeError` code emitted when no admissible binding exists
 * for a capability (e.g. the target execution-class endpoint is not yet
 * attached or all candidate bindings are unavailable). Surfaced as a
 * `tool.result` with `isError: true` per §4.21. Shared across the runtime,
 * policy engine, and attribution surfaces.
 */
export const CAPABILITY_BINDING_UNAVAILABLE =
  "capability_binding_unavailable" as const;
