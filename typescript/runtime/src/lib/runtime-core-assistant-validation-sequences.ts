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

import { isDeepStrictEqual } from "node:util";
import { TuvrenRuntimeError } from "@tuvren/core";
import type { TuvrenStreamEvent } from "@tuvren/core/events";
import type { TuvrenMessage } from "@tuvren/core/messages";
import type { TuvrenModelResponse } from "@tuvren/core/provider";
import { inferFinishReason } from "./runtime-core-recovery.js";
import { cloneValue } from "./runtime-core-shared.js";

interface StandaloneAssistantActivePartState {
  deltaBuffer: string;
  kind: "reasoning" | "structured" | "text";
  sawDelta: boolean;
}

interface StandaloneAssistantToolCallState {
  callId: string;
  deltaBuffer: string;
  kind: "tool_call";
  name: string;
  sawDelta: boolean;
}

type StandaloneAssistantPartState =
  | { kind: "idle" }
  | StandaloneAssistantActivePartState
  | StandaloneAssistantToolCallState;

interface StandaloneAssistantValidationState {
  currentMessageId: string;
  partState: StandaloneAssistantPartState;
  sawToolCallPart: boolean;
}

export function splitAssistantEventSequences(
  assistantEvents: TuvrenStreamEvent[]
): TuvrenRuntimeError | TuvrenStreamEvent[][] {
  const sequences: TuvrenStreamEvent[][] = [];
  let currentSequence: TuvrenStreamEvent[] | undefined;

  for (const event of assistantEvents) {
    if (event.type === "message.start") {
      if (currentSequence !== undefined) {
        return createAssistantDeltaValidationError();
      }

      currentSequence = [event];
      continue;
    }

    if (currentSequence === undefined) {
      return createAssistantDeltaValidationError();
    }

    currentSequence.push(event);

    if (event.type === "message.done") {
      sequences.push(currentSequence);
      currentSequence = undefined;
    }
  }

  if (currentSequence !== undefined || sequences.length === 0) {
    return createAssistantDeltaValidationError();
  }

  return sequences;
}

export function validateStandaloneAssistantSequence(
  assistantEvents: TuvrenStreamEvent[]
): TuvrenRuntimeError | undefined {
  const firstEvent = assistantEvents[0];
  const lastEvent = assistantEvents.at(-1);

  if (
    firstEvent?.type !== "message.start" ||
    lastEvent?.type !== "message.done"
  ) {
    return createAssistantDeltaValidationError();
  }

  const state: StandaloneAssistantValidationState = {
    currentMessageId: firstEvent.messageId,
    partState: { kind: "idle" },
    sawToolCallPart: false,
  };

  for (const event of assistantEvents.slice(1, -1)) {
    if (!assistantEventBelongsToCurrentMessage(event, state.currentMessageId)) {
      return createAssistantDeltaValidationError();
    }

    const validationError = validateStandaloneAssistantPartEvent(event, state);

    if (validationError !== undefined) {
      return validationError;
    }
  }

  if (state.partState.kind !== "idle") {
    return createAssistantDeltaValidationError();
  }

  if (
    !doesFinishReasonMatchToolCallPresence(
      lastEvent.finishReason,
      state.sawToolCallPart
    )
  ) {
    return createAssistantDeltaValidationError();
  }

  return undefined;
}

export function validateFailedDriverAssistantEvents(
  assistantEvents: TuvrenStreamEvent[]
): TuvrenRuntimeError | undefined {
  let state: StandaloneAssistantValidationState | undefined;

  for (const event of assistantEvents) {
    if (state === undefined) {
      if (event.type !== "message.start") {
        return createAssistantDeltaValidationError();
      }

      state = {
        currentMessageId: event.messageId,
        partState: { kind: "idle" },
        sawToolCallPart: false,
      };
      continue;
    }

    if (!assistantEventBelongsToCurrentMessage(event, state.currentMessageId)) {
      return createAssistantDeltaValidationError();
    }

    if (event.type === "message.start") {
      return createAssistantDeltaValidationError();
    }

    if (event.type === "message.done") {
      if (
        state.partState.kind !== "idle" ||
        !doesFinishReasonMatchToolCallPresence(
          event.finishReason,
          state.sawToolCallPart
        )
      ) {
        return createAssistantDeltaValidationError();
      }

      state = undefined;
      continue;
    }

    const validationError = validateStandaloneAssistantPartEvent(event, state);

    if (validationError !== undefined) {
      return validationError;
    }
  }

  return undefined;
}

export function synthesizeAssistantValidationEvents(
  message: Extract<TuvrenMessage, { role: "assistant" }>,
  messageId: string
): TuvrenStreamEvent[] {
  const events: TuvrenStreamEvent[] = [
    {
      messageId,
      role: "assistant",
      timestamp: 0,
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
          timestamp: 0,
          type: "file.done",
        });
        break;
      case "reasoning":
        events.push({
          messageId,
          timestamp: 0,
          type: "reasoning.done",
        });
        break;
      case "structured":
        events.push({
          data: cloneValue(part.data),
          messageId,
          name: part.name,
          timestamp: 0,
          type: "structured.done",
        });
        break;
      case "text":
        events.push({
          messageId,
          text: part.text,
          timestamp: 0,
          type: "text.done",
        });
        break;
      case "tool_call":
        events.push({
          callId: part.callId,
          messageId,
          name: part.name,
          timestamp: 0,
          type: "tool_call.start",
        });
        events.push({
          callId: part.callId,
          input: cloneValue(part.input),
          name: part.name,
          providerMetadata: cloneValue(part.providerMetadata),
          timestamp: 0,
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
    timestamp: 0,
    type: "message.done",
  });

  return events;
}

export function assistantValidationEventsMatch(
  actualEvent: TuvrenStreamEvent,
  expectedEvent: TuvrenStreamEvent
): boolean {
  if (actualEvent.type !== expectedEvent.type) {
    return false;
  }

  switch (actualEvent.type) {
    case "message.start":
      return (
        expectedEvent.type === "message.start" &&
        actualEvent.messageId === expectedEvent.messageId
      );
    case "text.done":
      return (
        expectedEvent.type === "text.done" &&
        actualEvent.messageId === expectedEvent.messageId &&
        actualEvent.text === expectedEvent.text
      );
    case "reasoning.done":
      return (
        expectedEvent.type === "reasoning.done" &&
        actualEvent.messageId === expectedEvent.messageId
      );
    case "file.done":
      return (
        expectedEvent.type === "file.done" &&
        actualEvent.messageId === expectedEvent.messageId &&
        actualEvent.filename === expectedEvent.filename &&
        actualEvent.mediaType === expectedEvent.mediaType &&
        areStreamEventValuesEqual(actualEvent.data, expectedEvent.data)
      );
    case "structured.done":
      return (
        expectedEvent.type === "structured.done" &&
        actualEvent.messageId === expectedEvent.messageId &&
        actualEvent.name === expectedEvent.name &&
        isDeepStrictEqual(actualEvent.data, expectedEvent.data)
      );
    case "tool_call.start":
      return (
        expectedEvent.type === "tool_call.start" &&
        actualEvent.messageId === expectedEvent.messageId &&
        actualEvent.callId === expectedEvent.callId &&
        actualEvent.name === expectedEvent.name
      );
    case "tool_call.done":
      return (
        expectedEvent.type === "tool_call.done" &&
        actualEvent.callId === expectedEvent.callId &&
        actualEvent.name === expectedEvent.name &&
        isDeepStrictEqual(
          actualEvent.providerMetadata,
          expectedEvent.providerMetadata
        ) &&
        isDeepStrictEqual(actualEvent.input, expectedEvent.input)
      );
    case "message.done":
      return (
        expectedEvent.type === "message.done" &&
        actualEvent.messageId === expectedEvent.messageId &&
        doesFinishReasonMatchAssistantContent(
          actualEvent.finishReason,
          expectedEvent.finishReason
        )
      );
    default:
      return false;
  }
}

export function assistantSequenceRequestsTools(
  events: TuvrenStreamEvent[]
): boolean {
  return events.some(
    (event) =>
      event.type === "tool_call.start" ||
      event.type === "tool_call.args_delta" ||
      event.type === "tool_call.done" ||
      (event.type === "message.done" && event.finishReason === "tool_call")
  );
}

export function doesFinishReasonMatchAssistantContent(
  actualFinishReason: TuvrenModelResponse["finishReason"],
  expectedFinishReason: TuvrenModelResponse["finishReason"]
): boolean {
  if (expectedFinishReason === "tool_call") {
    return actualFinishReason === "tool_call";
  }

  return actualFinishReason !== "tool_call";
}

export function createAssistantDeltaValidationError(): TuvrenRuntimeError {
  return new TuvrenRuntimeError(
    "driver-emitted assistant deltas must match the durable assistant message",
    {
      code: "invalid_stream_event",
    }
  );
}

function validateStandaloneAssistantPartEvent(
  event: TuvrenStreamEvent,
  state: StandaloneAssistantValidationState
): TuvrenRuntimeError | undefined {
  if (event.type === "message.start" || event.type === "message.done") {
    return createAssistantDeltaValidationError();
  }

  switch (state.partState.kind) {
    case "idle":
      return validateStandaloneIdleAssistantEvent(event, state);
    case "reasoning":
      return validateStandaloneReasoningAssistantEvent(event, state);
    case "structured":
      return validateStandaloneStructuredAssistantEvent(event, state);
    case "text":
      return validateStandaloneTextAssistantEvent(event, state);
    case "tool_call":
      return validateStandaloneToolCallAssistantEvent(event, state);
    default:
      return createAssistantDeltaValidationError();
  }
}

function validateStandaloneIdleAssistantEvent(
  event: TuvrenStreamEvent,
  state: StandaloneAssistantValidationState
): TuvrenRuntimeError | undefined {
  switch (event.type) {
    case "file.done":
      return undefined;
    case "reasoning.delta":
      state.partState = {
        deltaBuffer: event.delta,
        kind: "reasoning",
        sawDelta: true,
      };
      return undefined;
    case "reasoning.done":
      return undefined;
    case "structured.delta":
      state.partState = {
        deltaBuffer: event.delta,
        kind: "structured",
        sawDelta: true,
      };
      return undefined;
    case "text.delta":
      state.partState = {
        deltaBuffer: event.delta,
        kind: "text",
        sawDelta: true,
      };
      return undefined;
    case "tool_call.start":
      state.partState = {
        callId: event.callId,
        deltaBuffer: "",
        kind: "tool_call",
        name: event.name,
        sawDelta: false,
      };
      state.sawToolCallPart = true;
      return undefined;
    default:
      return createAssistantDeltaValidationError();
  }
}

function validateStandaloneReasoningAssistantEvent(
  event: TuvrenStreamEvent,
  state: StandaloneAssistantValidationState
): TuvrenRuntimeError | undefined {
  if (state.partState.kind !== "reasoning") {
    return createAssistantDeltaValidationError();
  }

  if (event.type === "reasoning.delta") {
    state.partState.deltaBuffer += event.delta;
    state.partState.sawDelta = true;
    return undefined;
  }

  if (event.type !== "reasoning.done") {
    return createAssistantDeltaValidationError();
  }

  state.partState = { kind: "idle" };
  return undefined;
}

function validateStandaloneStructuredAssistantEvent(
  event: TuvrenStreamEvent,
  state: StandaloneAssistantValidationState
): TuvrenRuntimeError | undefined {
  if (state.partState.kind !== "structured") {
    return createAssistantDeltaValidationError();
  }

  if (event.type === "structured.delta") {
    state.partState.deltaBuffer += event.delta;
    state.partState.sawDelta = true;
    return undefined;
  }

  if (
    event.type !== "structured.done" ||
    !state.partState.sawDelta ||
    !doesSerializedDeltaMatchValue(state.partState.deltaBuffer, event.data)
  ) {
    return createAssistantDeltaValidationError();
  }

  state.partState = { kind: "idle" };
  return undefined;
}

function validateStandaloneTextAssistantEvent(
  event: TuvrenStreamEvent,
  state: StandaloneAssistantValidationState
): TuvrenRuntimeError | undefined {
  if (state.partState.kind !== "text") {
    return createAssistantDeltaValidationError();
  }

  if (event.type === "text.delta") {
    state.partState.deltaBuffer += event.delta;
    state.partState.sawDelta = true;
    return undefined;
  }

  if (
    event.type !== "text.done" ||
    !state.partState.sawDelta ||
    state.partState.deltaBuffer !== event.text
  ) {
    return createAssistantDeltaValidationError();
  }

  state.partState = { kind: "idle" };
  return undefined;
}

function validateStandaloneToolCallAssistantEvent(
  event: TuvrenStreamEvent,
  state: StandaloneAssistantValidationState
): TuvrenRuntimeError | undefined {
  if (state.partState.kind !== "tool_call") {
    return createAssistantDeltaValidationError();
  }

  if (event.type === "tool_call.args_delta") {
    if (event.callId !== state.partState.callId) {
      return createAssistantDeltaValidationError();
    }

    state.partState.deltaBuffer += event.delta;
    state.partState.sawDelta = true;
    return undefined;
  }

  if (
    event.type !== "tool_call.done" ||
    event.callId !== state.partState.callId ||
    event.name !== state.partState.name ||
    !state.partState.sawDelta ||
    !doesSerializedDeltaMatchValue(state.partState.deltaBuffer, event.input)
  ) {
    return createAssistantDeltaValidationError();
  }

  state.partState = { kind: "idle" };
  return undefined;
}

function assistantEventBelongsToCurrentMessage(
  event: TuvrenStreamEvent,
  currentMessageId: string | undefined
): boolean {
  const eventMessageId = getAssistantEventMessageId(event);

  return eventMessageId === undefined || eventMessageId === currentMessageId;
}

function getAssistantEventMessageId(
  event: TuvrenStreamEvent
): string | undefined {
  switch (event.type) {
    case "file.done":
    case "message.done":
    case "message.start":
    case "reasoning.delta":
    case "reasoning.done":
    case "structured.delta":
    case "structured.done":
    case "text.delta":
    case "text.done":
    case "tool_call.start":
      return event.messageId;
    default:
      return undefined;
  }
}

function doesFinishReasonMatchToolCallPresence(
  finishReason: TuvrenModelResponse["finishReason"],
  hasToolCallPart: boolean
): boolean {
  if (hasToolCallPart) {
    return finishReason === "tool_call";
  }

  return finishReason !== "tool_call";
}

function areStreamEventValuesEqual(left: unknown, right: unknown): boolean {
  if (left instanceof Uint8Array && right instanceof Uint8Array) {
    if (left.length !== right.length) {
      return false;
    }

    for (let index = 0; index < left.length; index += 1) {
      if (left[index] !== right[index]) {
        return false;
      }
    }

    return true;
  }

  return isDeepStrictEqual(left, right);
}

function doesSerializedDeltaMatchValue(
  serializedDelta: string,
  expectedValue: unknown
): boolean {
  if (typeof expectedValue === "string" && serializedDelta === expectedValue) {
    return true;
  }

  try {
    return isDeepStrictEqual(JSON.parse(serializedDelta), expectedValue);
  } catch {
    return false;
  }
}
