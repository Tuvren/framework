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

import type { EpochMs, HashString } from "@tuvren/core";
import type { TuvrenStreamEvent } from "@tuvren/core/events";
import { assertTuvrenStreamEvent } from "@tuvren/core/events";
import type {
  ContextManifest,
  RuntimeResolution,
} from "@tuvren/core/execution";
import type { TuvrenMessage } from "@tuvren/core/messages";
import {
  assertRunnerRuntimeEvent,
  isAssistantContentStreamEvent,
  serializeAssistantDeltaValue,
} from "./runtime-core-assistant-validation.js";
import type { LoopState } from "./runtime-core-loop.js";
import {
  inferFinishReason,
  shouldSuppressBufferedRunnerEvents,
} from "./runtime-core-recovery.js";
import { cloneValue, projectError } from "./runtime-core-shared.js";
import type { RuntimeExecutionHandle } from "./runtime-execution-handle.js";

/**
 * Capability surface the event-publication helpers require from the runtime
 * core.
 */
export interface RuntimeCoreEventsHost {
  /** Generate a unique id (used for synthesized message ids). */
  createId(): string;
  /**
   * Whether `state.checkpoint`/`state.snapshot` observability events should
   * be emitted at all.
   */
  enableStateObservability(): boolean;
  /** Current time used to stamp event timestamps. */
  now(): EpochMs;
}

/**
 * Publish a named `custom` stream event (as emitted by extensions and
 * handoffs), stamped with the current time and the active source identity.
 */
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

/**
 * Publish a stream event on the handle after decorating and validating it via
 * {@link createPublishedEvent}.
 */
export function publishEvent(
  host: RuntimeCoreEventsHost,
  handle: RuntimeExecutionHandle,
  event: TuvrenStreamEvent,
  loopState: LoopState
): void {
  handle.publish(createPublishedEvent(host, handle, event, loopState));
}

/**
 * Decorates a stream event with default `source` attribution (active agent,
 * runner, and thread) when it carries none, then shape-validates it.
 *
 * @returns The publishable event.
 * @throws When the decorated event fails `assertTuvrenStreamEvent`.
 */
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
      runner: loopState.activeRunnerId,
      threadId: handle.request.threadId,
    },
  };
  assertTuvrenStreamEvent(publishedEvent, "stream event");
  return publishedEvent;
}

/**
 * Prepares a runner-emitted event for publication: validates that the event
 * type is one a runner may emit (`assertRunnerRuntimeEvent`), then *replaces*
 * its `source` with the runtime-owned attribution — unlike
 * {@link createPublishedEvent}, a runner cannot supply its own source
 * identity.
 */
export function createRunnerPublishedEvent(
  host: RuntimeCoreEventsHost,
  handle: RuntimeExecutionHandle,
  event: TuvrenStreamEvent,
  loopState: LoopState
): TuvrenStreamEvent {
  assertRunnerRuntimeEvent(event);
  return createPublishedEvent(
    host,
    handle,
    {
      ...event,
      source: {
        agent: loopState.activeConfig.name,
        runner: loopState.activeRunnerId,
        threadId: handle.request.threadId,
      },
    },
    loopState
  );
}

/** Publishes already-validated buffered runner events on the handle, in
 * order. */
export function flushBufferedRunnerEvents(
  handle: RuntimeExecutionHandle,
  events: TuvrenStreamEvent[]
): void {
  for (const event of events) {
    handle.publish(event);
  }
}

/**
 * Flushes buffered runner events unless the iteration's resolution suppresses
 * them (see `shouldSuppressBufferedRunnerEvents`).
 *
 * @returns The events that were published, or `[]` when suppressed.
 */
export function flushBufferedRunnerEventsIfNeeded(
  handle: RuntimeExecutionHandle,
  resolution: RuntimeResolution,
  events: TuvrenStreamEvent[]
): TuvrenStreamEvent[] {
  if (shouldSuppressBufferedRunnerEvents(resolution)) {
    return [];
  }

  flushBufferedRunnerEvents(handle, events);
  return events;
}

/**
 * Guarantees the event stream reflects the assistant message: when the runner
 * produced an assistant message but emitted no assistant-content events,
 * synthesizes the canonical event sequence (`message.start`, per-part deltas
 * and dones, `message.done`) from the message parts.
 *
 * @returns The synthesized publishable events, or `[]` when the runner
 *   already streamed assistant content (or produced no assistant message).
 */
export function ensureRunnerAssistantEvents(
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

/**
 * Projects an error to its stream shape, remembers the projection on the
 * handle (for result reporting), and publishes it as an `error` event with
 * the given fatality.
 */
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

/**
 * Publishes the `state.checkpoint` event for an advanced turn node (plus a
 * `state.snapshot` carrying the manifest when one is provided). A no-op when
 * the host disables state observability.
 */
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

/**
 * Expands an assistant message into the canonical event sequence a streaming
 * runner would have emitted: `message.start`, then per part its delta/done
 * pair (text, reasoning — deltas skipped when redacted, structured, file,
 * tool_call), and a closing `message.done` with an inferred finish reason.
 */
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
