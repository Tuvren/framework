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

import type { HashString, KernelRecord } from "@tuvren/core";
import type { TuvrenStreamEvent } from "@tuvren/core/events";
import type { ContextManifest } from "@tuvren/core/execution";
import type { TuvrenMessage } from "@tuvren/core/messages";
import {
  createPublishedEvent as createRuntimePublishedEvent,
  createRunnerPublishedEvent as createRuntimeRunnerPublishedEvent,
  emitStateObservability as emitRuntimeStateObservability,
  ensureRunnerAssistantEvents as ensureRuntimeRunnerAssistantEvents,
  flushBufferedRunnerEvents as flushRuntimeBufferedRunnerEvents,
  flushBufferedRunnerEventsIfNeeded as flushRuntimeBufferedRunnerEventsIfNeeded,
  publishCustomEvent as publishRuntimeCustomEvent,
  publishEvent as publishRuntimeEvent,
  publishProjectedError as publishRuntimeProjectedError,
  type RuntimeCoreEventsHost,
} from "./runtime-core-events.js";
import type { LoopState } from "./runtime-core-loop.js";
import {
  type RuntimeCorePersistenceHost,
  stageManifest as stageRuntimeManifest,
  stageMessage as stageRuntimeMessage,
  stageRuntimeStatus as stageRuntimeStatusRecord,
  stageTurnLineage as stageRuntimeTurnLineage,
  storeEventRecord as storeRuntimeEventRecord,
  storeKernelRecord as storeRuntimeKernelRecord,
} from "./runtime-core-persistence.js";
import type { DurableRuntimeStatus } from "./runtime-core-recovery.js";
import type { RuntimeExecutionHandle } from "./runtime-execution-handle.js";

/**
 * Invoke an optional warning callback, swallowing any error it throws so a
 * faulty host warning handler can never disturb execution.
 */
export function emitRuntimeWarning<TWarning>(
  onWarning: ((warning: TWarning) => void) | undefined,
  warning: TWarning
): void {
  try {
    onWarning?.(warning);
  } catch {
    return;
  }
}

/**
 * Facade over the persistence module's `stageManifest`: stage a context
 * manifest for the run, emitting extension-state budget warnings when a
 * warning context is provided.
 */
export async function stageRuntimeManifestRecord(
  host: RuntimeCorePersistenceHost,
  runId: string,
  manifest: ContextManifest,
  warningContext?: {
    handle: RuntimeExecutionHandle;
    loopState: LoopState;
  }
): Promise<HashString> {
  return await stageRuntimeManifest(host, runId, manifest, warningContext);
}

/**
 * Facade over the persistence module's `stageMessage`: stage an encoded
 * (and codec-encrypted) message record for the run.
 */
export async function stageRuntimeMessageRecord(
  host: RuntimeCorePersistenceHost,
  runId: string,
  message: TuvrenMessage,
  taskId: string
): Promise<HashString> {
  return await stageRuntimeMessage(host, runId, message, taskId);
}

/**
 * Facade over the persistence module's `stageTurnLineage`: stage the
 * active-turn lineage record for the run.
 */
export async function stageRuntimeTurnLineageRecord(
  host: RuntimeCorePersistenceHost,
  runId: string,
  turnId: string,
  taskId: string
): Promise<HashString> {
  return await stageRuntimeTurnLineage(host, runId, turnId, taskId);
}

/**
 * Facade over the persistence module's `stageRuntimeStatus`: stage a
 * durable runtime-status record for the run.
 */
export async function stageRuntimeStatusRecordValue(
  host: RuntimeCorePersistenceHost,
  runId: string,
  status: DurableRuntimeStatus,
  taskId: string
): Promise<HashString> {
  return await stageRuntimeStatusRecord(host, runId, status, taskId);
}

/**
 * Facade over the persistence module's `storeKernelRecord`: encode and
 * store a value as a content-addressed kernel record.
 */
export async function storeRuntimeKernelRecordValue(
  host: RuntimeCorePersistenceHost,
  value: unknown,
  label: string
): Promise<HashString> {
  return await storeRuntimeKernelRecord(host, value, label);
}

/**
 * Facade over the persistence module's `storeEventRecord`: store an event
 * record content-addressed and return its hash.
 */
export async function storeRuntimeEventKernelRecord(
  host: RuntimeCorePersistenceHost,
  event: KernelRecord
): Promise<HashString> {
  return await storeRuntimeEventRecord(host, event);
}

/**
 * Facade over the events module's `publishCustomEvent`: wrap a named payload
 * as a timestamped `custom` stream event and publish it.
 */
export function publishRuntimeCustomNamedEvent(
  host: RuntimeCoreEventsHost,
  handle: RuntimeExecutionHandle,
  event: { data: unknown; name: string },
  loopState: LoopState
): void {
  publishRuntimeCustomEvent(host, handle, event, loopState);
}

/**
 * Facade over the events module's `publishEvent`: publish a stream event
 * through the full runtime event and telemetry path.
 */
export function publishRuntimeStreamEvent(
  host: RuntimeCoreEventsHost,
  handle: RuntimeExecutionHandle,
  event: TuvrenStreamEvent,
  loopState: LoopState
): void {
  publishRuntimeEvent(host, handle, event, loopState);
}

/**
 * Facade over the events module's `createPublishedEvent`: stamp a stream
 * event with its source attribution (agent, runner, thread) and validate it,
 * returning the publishable event without publishing it.
 */
export function createRuntimePublishedStreamEvent(
  host: RuntimeCoreEventsHost,
  handle: RuntimeExecutionHandle,
  event: TuvrenStreamEvent,
  loopState: LoopState
): TuvrenStreamEvent {
  return createRuntimePublishedEvent(host, handle, event, loopState);
}

/**
 * Facade over the events module's `createRunnerPublishedEvent`: validate a
 * runner-emitted event and stamp it with the active agent/runner/thread
 * source, returning the publishable event without publishing it.
 */
export function createRuntimeRunnerStreamEvent(
  host: RuntimeCoreEventsHost,
  handle: RuntimeExecutionHandle,
  event: TuvrenStreamEvent,
  loopState: LoopState
): TuvrenStreamEvent {
  return createRuntimeRunnerPublishedEvent(host, handle, event, loopState);
}

/**
 * Facade over the events module's `flushBufferedRunnerEvents`: flush
 * buffered runner events to the handle's stream unconditionally.
 */
export function flushRuntimeBufferedEvents(
  handle: RuntimeExecutionHandle,
  events: TuvrenStreamEvent[]
): void {
  flushRuntimeBufferedRunnerEvents(handle, events);
}

/**
 * Facade over the events module's `flushBufferedRunnerEventsIfNeeded`:
 * flush buffered runner events unless the resolution requires suppressing
 * them, returning the events that remain visible.
 */
export function flushRuntimeBufferedEventsIfResolutionAllows(
  handle: RuntimeExecutionHandle,
  resolution: import("@tuvren/core/execution").RuntimeResolution,
  events: TuvrenStreamEvent[]
): TuvrenStreamEvent[] {
  return flushRuntimeBufferedRunnerEventsIfNeeded(handle, resolution, events);
}

/**
 * Facade over the events module's `ensureRunnerAssistantEvents`: when the
 * runner produced an assistant message but emitted no assistant content
 * events, synthesize the corresponding message events (source-stamped,
 * unpublished); returns an empty array otherwise.
 */
export function ensureRuntimeAssistantEvents(
  host: RuntimeCoreEventsHost,
  handle: RuntimeExecutionHandle,
  messages: TuvrenMessage[],
  emittedEvents: TuvrenStreamEvent[],
  loopState: LoopState
): TuvrenStreamEvent[] {
  return ensureRuntimeRunnerAssistantEvents(
    host,
    handle,
    messages,
    emittedEvents,
    loopState
  );
}

/**
 * Facade over the events module's `publishProjectedError`: project an error,
 * remember it on the handle, and publish it as an `error` stream event
 * marked with its fatality.
 */
export function publishRuntimeProjectedErrorEvent(
  host: RuntimeCoreEventsHost,
  handle: RuntimeExecutionHandle,
  error: Error,
  fatal: boolean,
  loopState: LoopState
): void {
  publishRuntimeProjectedError(host, handle, error, fatal, loopState);
}

/**
 * Facade over the events module's `emitStateObservability`: when state
 * observability is enabled, publish a `state.checkpoint` event for the new
 * turn node and, if a manifest is provided, a `state.snapshot` event.
 */
export function emitRuntimeCheckpointEvents(
  host: RuntimeCoreEventsHost,
  handle: RuntimeExecutionHandle,
  loopState: LoopState,
  turnNodeHash: HashString,
  iterationCount: number,
  manifest?: ContextManifest
): void {
  emitRuntimeStateObservability(
    host,
    handle,
    loopState,
    turnNodeHash,
    iterationCount,
    manifest
  );
}
