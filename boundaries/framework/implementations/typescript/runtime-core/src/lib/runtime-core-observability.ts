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

import type { HashString, KernelRecord } from "@tuvren/core-types";
import type {
  ContextManifest,
  TuvrenMessage,
  TuvrenStreamEvent,
} from "@tuvren/runtime-api";
import {
  createDriverPublishedEvent as createRuntimeDriverPublishedEvent,
  createPublishedEvent as createRuntimePublishedEvent,
  emitStateObservability as emitRuntimeStateObservability,
  ensureDriverAssistantEvents as ensureRuntimeDriverAssistantEvents,
  flushBufferedDriverEvents as flushRuntimeBufferedDriverEvents,
  flushBufferedDriverEventsIfNeeded as flushRuntimeBufferedDriverEventsIfNeeded,
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

export async function stageRuntimeMessageRecord(
  host: RuntimeCorePersistenceHost,
  runId: string,
  message: TuvrenMessage,
  taskId: string
): Promise<HashString> {
  return await stageRuntimeMessage(host, runId, message, taskId);
}

export async function stageRuntimeTurnLineageRecord(
  host: RuntimeCorePersistenceHost,
  runId: string,
  turnId: string,
  taskId: string
): Promise<HashString> {
  return await stageRuntimeTurnLineage(host, runId, turnId, taskId);
}

export async function stageRuntimeStatusRecordValue(
  host: RuntimeCorePersistenceHost,
  runId: string,
  status: DurableRuntimeStatus,
  taskId: string
): Promise<HashString> {
  return await stageRuntimeStatusRecord(host, runId, status, taskId);
}

export async function storeRuntimeKernelRecordValue(
  host: RuntimeCorePersistenceHost,
  value: unknown,
  label: string
): Promise<HashString> {
  return await storeRuntimeKernelRecord(host, value, label);
}

export async function storeRuntimeEventKernelRecord(
  host: RuntimeCorePersistenceHost,
  event: KernelRecord
): Promise<HashString> {
  return await storeRuntimeEventRecord(host, event);
}

export function publishRuntimeCustomNamedEvent(
  host: RuntimeCoreEventsHost,
  handle: RuntimeExecutionHandle,
  event: { data: unknown; name: string },
  loopState: LoopState
): void {
  publishRuntimeCustomEvent(host, handle, event, loopState);
}

export function publishRuntimeStreamEvent(
  host: RuntimeCoreEventsHost,
  handle: RuntimeExecutionHandle,
  event: TuvrenStreamEvent,
  loopState: LoopState
): void {
  publishRuntimeEvent(host, handle, event, loopState);
}

export function createRuntimePublishedStreamEvent(
  host: RuntimeCoreEventsHost,
  handle: RuntimeExecutionHandle,
  event: TuvrenStreamEvent,
  loopState: LoopState
): TuvrenStreamEvent {
  return createRuntimePublishedEvent(host, handle, event, loopState);
}

export function createRuntimeDriverStreamEvent(
  host: RuntimeCoreEventsHost,
  handle: RuntimeExecutionHandle,
  event: TuvrenStreamEvent,
  loopState: LoopState
): TuvrenStreamEvent {
  return createRuntimeDriverPublishedEvent(host, handle, event, loopState);
}

export function flushRuntimeBufferedEvents(
  handle: RuntimeExecutionHandle,
  events: TuvrenStreamEvent[]
): void {
  flushRuntimeBufferedDriverEvents(handle, events);
}

export function flushRuntimeBufferedEventsIfResolutionAllows(
  handle: RuntimeExecutionHandle,
  resolution: import("@tuvren/runtime-api").RuntimeResolution,
  events: TuvrenStreamEvent[]
): TuvrenStreamEvent[] {
  return flushRuntimeBufferedDriverEventsIfNeeded(handle, resolution, events);
}

export function ensureRuntimeAssistantEvents(
  host: RuntimeCoreEventsHost,
  handle: RuntimeExecutionHandle,
  messages: TuvrenMessage[],
  emittedEvents: TuvrenStreamEvent[],
  loopState: LoopState
): TuvrenStreamEvent[] {
  return ensureRuntimeDriverAssistantEvents(
    host,
    handle,
    messages,
    emittedEvents,
    loopState
  );
}

export function publishRuntimeProjectedErrorEvent(
  host: RuntimeCoreEventsHost,
  handle: RuntimeExecutionHandle,
  error: Error,
  fatal: boolean,
  loopState: LoopState
): void {
  publishRuntimeProjectedError(host, handle, error, fatal, loopState);
}

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
