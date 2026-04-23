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

// biome-ignore-all lint/performance/noBarrelFile: This package entrypoint is the intentional public contract surface.
// This package is intentionally a focused import home over the shared runtime
// contract family. It now tracks the matching runtime-api subpath instead of
// the broad root facade so the dependency shape stays as narrow as the surface.
export type {
  ApprovalRequestedEvent,
  ApprovalResolvedEvent,
  CustomEvent,
  DriverAttributedEventSource,
  ErrorEvent,
  EventSource,
  FileDoneEvent,
  IterationEndEvent,
  IterationStartEvent,
  MessageDoneEvent,
  MessageStartEvent,
  ReasoningDeltaEvent,
  ReasoningDoneEvent,
  StateCheckpointEvent,
  StateSnapshotEvent,
  SteeringIncorporatedEvent,
  StructuredDeltaEvent,
  StructuredDoneEvent,
  TextDeltaEvent,
  TextDoneEvent,
  ToolCallArgsDeltaEvent,
  ToolCallDoneEvent,
  ToolCallStartEvent,
  ToolResultEvent,
  ToolStartEvent,
  TurnEndEvent,
  TurnStartEvent,
  TuvrenErrorProjection,
  TuvrenStreamEvent,
} from "@tuvren/runtime-api/events";
export {
  assertTuvrenStreamEvent,
  isTuvrenStreamEvent,
} from "@tuvren/runtime-api/events";
