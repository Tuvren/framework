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

import type { EpochMs, HashString } from "@tuvren/core-types";
import type {
  ContextManifest,
  RuntimeResolution,
  TuvrenMessage,
  TuvrenStreamEvent,
} from "@tuvren/runtime-api";
import { assertTuvrenStreamEvent } from "@tuvren/runtime-api";
import {
  assertDriverRuntimeEvent,
  isAssistantContentStreamEvent,
  serializeAssistantDeltaValue,
} from "./runtime-core-assistant-validation.js";
import type { LoopState } from "./runtime-core-loop.js";
import {
  inferFinishReason,
  shouldSuppressBufferedDriverEvents,
} from "./runtime-core-recovery.js";
import { cloneValue, projectError } from "./runtime-core-shared.js";
import type { RuntimeExecutionHandle } from "./runtime-execution-handle.js";

export interface RuntimeCoreEventsHost {
  createId(): string;
  enableStateObservability(): boolean;
  now(): EpochMs;
}

export function publishCustomEvent(
  host: RuntimeCoreEventsHost,
  handle: RuntimeExecutionHandle,
  event: { data: unknown; name: string },
  loopState: LoopState
): void {
  publishEvent(
    host,
    handle,
    {
      data: event.data,
      name: event.name,
      timestamp: host.now(),
      type: "custom",
    },
    loopState
  );
}

export function publishEvent(
  host: RuntimeCoreEventsHost,
  handle: RuntimeExecutionHandle,
  event: TuvrenStreamEvent,
  loopState: LoopState
): void {
  handle.publish(createPublishedEvent(host, handle, event, loopState));
}

export function createPublishedEvent(
  _host: RuntimeCoreEventsHost,
  handle: RuntimeExecutionHandle,
  event: TuvrenStreamEvent,
  loopState: LoopState
): TuvrenStreamEvent {
  const publishedEvent = {
    ...event,
    source: event.source ?? {
      agent: loopState.activeConfig.name,
      driver: loopState.activeDriverId,
      threadId: handle.request.threadId,
    },
  };
  assertTuvrenStreamEvent(publishedEvent, "stream event");
  return publishedEvent;
}

export function createDriverPublishedEvent(
  host: RuntimeCoreEventsHost,
  handle: RuntimeExecutionHandle,
  event: TuvrenStreamEvent,
  loopState: LoopState
): TuvrenStreamEvent {
  assertDriverRuntimeEvent(event);
  return createPublishedEvent(
    host,
    handle,
    {
      ...event,
      source: {
        agent: loopState.activeConfig.name,
        driver: loopState.activeDriverId,
        threadId: handle.request.threadId,
      },
    },
    loopState
  );
}

export function flushBufferedDriverEvents(
  handle: RuntimeExecutionHandle,
  events: TuvrenStreamEvent[]
): void {
  for (const event of events) {
    handle.publish(event);
  }
}

export function flushBufferedDriverEventsIfNeeded(
  handle: RuntimeExecutionHandle,
  resolution: RuntimeResolution,
  events: TuvrenStreamEvent[]
): TuvrenStreamEvent[] {
  if (shouldSuppressBufferedDriverEvents(resolution)) {
    return [];
  }

  flushBufferedDriverEvents(handle, events);
  return events;
}

export function ensureDriverAssistantEvents(
  host: RuntimeCoreEventsHost,
  handle: RuntimeExecutionHandle,
  messages: TuvrenMessage[],
  emittedEvents: TuvrenStreamEvent[],
  loopState: LoopState
): TuvrenStreamEvent[] {
  const assistantMessage = messages.find(
    (message): message is Extract<TuvrenMessage, { role: "assistant" }> =>
      message.role === "assistant"
  );

  if (
    assistantMessage === undefined ||
    emittedEvents.some((event) => isAssistantContentStreamEvent(event.type))
  ) {
    return [];
  }

  return synthesizeAssistantMessageEvents(host, assistantMessage).map((event) =>
    createPublishedEvent(host, handle, event, loopState)
  );
}

export function publishProjectedError(
  host: RuntimeCoreEventsHost,
  handle: RuntimeExecutionHandle,
  error: Error,
  fatal: boolean,
  loopState: LoopState
): void {
  const projection = projectError(error);
  handle.rememberError(projection);
  publishEvent(
    host,
    handle,
    {
      error: projection,
      fatal,
      timestamp: host.now(),
      type: "error",
    },
    loopState
  );
}

export function emitStateObservability(
  host: RuntimeCoreEventsHost,
  handle: RuntimeExecutionHandle,
  loopState: LoopState,
  turnNodeHash: HashString,
  iterationCount: number,
  manifest?: ContextManifest
): void {
  if (!host.enableStateObservability()) {
    return;
  }

  publishEvent(
    host,
    handle,
    {
      iterationCount,
      timestamp: host.now(),
      turnNodeHash,
      type: "state.checkpoint",
    },
    loopState
  );

  if (manifest !== undefined) {
    publishEvent(
      host,
      handle,
      {
        manifest,
        timestamp: host.now(),
        type: "state.snapshot",
      },
      loopState
    );
  }
}

function synthesizeAssistantMessageEvents(
  host: RuntimeCoreEventsHost,
  message: Extract<TuvrenMessage, { role: "assistant" }>
): TuvrenStreamEvent[] {
  const messageId = host.createId();
  const events: TuvrenStreamEvent[] = [
    {
      messageId,
      role: "assistant",
      timestamp: host.now(),
      type: "message.start",
    },
  ];

  for (const part of message.parts) {
    switch (part.type) {
      case "file":
        events.push({
          data:
            typeof part.data === "string"
              ? part.data
              : new Uint8Array(part.data),
          filename: part.filename,
          mediaType: part.mediaType,
          messageId,
          timestamp: host.now(),
          type: "file.done",
        });
        break;
      case "reasoning":
        if (!part.redacted) {
          events.push({
            delta: part.text,
            messageId,
            timestamp: host.now(),
            type: "reasoning.delta",
          });
        }

        events.push({
          messageId,
          timestamp: host.now(),
          type: "reasoning.done",
        });
        break;
      case "structured":
        events.push({
          delta: serializeAssistantDeltaValue(part.data),
          messageId,
          timestamp: host.now(),
          type: "structured.delta",
        });
        events.push({
          data: cloneValue(part.data),
          messageId,
          name: part.name,
          timestamp: host.now(),
          type: "structured.done",
        });
        break;
      case "text":
        events.push({
          delta: part.text,
          messageId,
          timestamp: host.now(),
          type: "text.delta",
        });
        events.push({
          messageId,
          text: part.text,
          timestamp: host.now(),
          type: "text.done",
        });
        break;
      case "tool_call":
        events.push({
          callId: part.callId,
          messageId,
          name: part.name,
          timestamp: host.now(),
          type: "tool_call.start",
        });
        events.push({
          callId: part.callId,
          delta: serializeAssistantDeltaValue(part.input),
          timestamp: host.now(),
          type: "tool_call.args_delta",
        });
        events.push({
          callId: part.callId,
          input: cloneValue(part.input),
          name: part.name,
          providerMetadata: cloneValue(part.providerMetadata),
          timestamp: host.now(),
          type: "tool_call.done",
        });
        break;
      default:
        break;
    }
  }

  events.push({
    finishReason: inferFinishReason(message),
    messageId,
    timestamp: host.now(),
    type: "message.done",
  });
  return events;
}
