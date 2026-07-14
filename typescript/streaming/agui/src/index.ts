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
 * @packageDocumentation
 *
 * `@tuvren/stream-agui` is the AG-UI protocol adapter for `TuvrenStreamEvent`
 * streams (KrakenFrameworkSpecification §6.1): {@link toAgUiEvents} maps the
 * canonical event stream onto the `@ag-ui/core` event model, using
 * `CUSTOM` events (with a fixed `tuvren.runtime.*` warning code) as the
 * fallback for canonical events that have no first-class AG-UI counterpart,
 * and coercing a paused turn into a `CUSTOM` pause marker followed by
 * `RUN_FINISHED` so AG-UI lifecycle consumers stay well-formed.
 */
// biome-ignore-all lint/performance/noBarrelFile: This package entrypoint is the intentional public implementation surface.
export { toAgUiEvents } from "./lib/stream-agui.js";
