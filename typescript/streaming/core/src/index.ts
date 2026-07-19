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
 * `@tuvren/stream-core` provides the shared building blocks that protocol
 * adapters and hosts build on for `TuvrenStreamEvent` consumption
 * (KrakenFrameworkSpecification §6 "Streaming"): the {@link StreamProtocolAdapter}
 * shape adapters implement, {@link teeTuvrenStreamEvents} for host-owned
 * multi-consumer fanout of a single-consumer `ExecutionHandle.events()`
 * stream, event cloning/serialization helpers, and canonical fixtures for
 * adapter conformance and tests.
 *
 * `teeTuvrenStreamEvents` enforces a claim-before-first-pull rule: every
 * branch must subscribe (call `[Symbol.asyncIterator]()`) before the source
 * stream is first pulled, or it fails with `event_stream_subscription_too_late`;
 * a branch that is iterated twice fails with `event_stream_already_consumed`.
 */
// biome-ignore-all lint/performance/noBarrelFile: This package entrypoint is the intentional public implementation surface.
export type {
  StreamAdapterOptions,
  StreamAdapterWarning,
  StreamProtocolAdapter,
} from "./lib/stream-core.js";
export {
  cloneTuvrenStreamEvent,
  createFixtureStream,
  createStreamAdapterWarningReporter,
  serializeTuvrenStreamEvent,
  streamAdapterFixtures,
  teeTuvrenStreamEvents,
} from "./lib/stream-core.js";
export type {
  ReplayBuffer,
  ReplayResult,
  ResumeCursorPayload,
  SequencedTuvrenStreamEvent,
} from "./lib/stream-resume.js";
export {
  createReplayBuffer,
  createSequencedTuvrenStreamEvents,
  decodeResumeCursor,
  encodeResumeCursor,
} from "./lib/stream-resume.js";
