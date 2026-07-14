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
 * `@tuvren/stream-sse` is the Server-Sent Events protocol adapter for
 * `TuvrenStreamEvent` streams (KrakenFrameworkSpecification §6.1): it
 * encodes a canonical event stream into SSE frames/`Response` bodies
 * ({@link toSseFrames}, {@link toSseResponse}) and independently decodes raw
 * SSE wire bytes per the WHATWG `text/event-stream` interpretation algorithm
 * ({@link decodeSseStream}), with {@link reportSseWireCompliance} exercising
 * both halves against live observations for conformance reporting.
 */
// biome-ignore-all lint/performance/noBarrelFile: This package entrypoint is the intentional public implementation surface.
export type {
  TuvrenDecodedSseEvent,
  TuvrenDecodedSseStream,
  TuvrenSseWireCompliance,
} from "./lib/sse-decoder.js";
export { decodeSseStream, reportSseWireCompliance } from "./lib/sse-decoder.js";
export type { TuvrenSseFrame } from "./lib/stream-sse.js";
export { toSseFrames, toSseResponse } from "./lib/stream-sse.js";
