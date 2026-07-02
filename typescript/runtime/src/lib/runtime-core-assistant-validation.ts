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
import type { DriverAssistantEventReconciliation } from "@tuvren/core/driver";
import type { TuvrenStreamEvent } from "@tuvren/core/events";
import type { RuntimeResolution } from "@tuvren/core/execution";
import type { TuvrenExtension } from "@tuvren/core/extensions";
import type { ContentPart, TuvrenMessage } from "@tuvren/core/messages";
import type { TuvrenModelResponse } from "@tuvren/core/provider";
import {
  assistantSequenceRequestsTools,
  assistantValidationEventsMatch,
  createAssistantDeltaValidationError,
  doesFinishReasonMatchAssistantContent,
  splitAssistantEventSequences,
  synthesizeAssistantValidationEvents,
  validateFailedDriverAssistantEvents,
  validateStandaloneAssistantSequence,
} from "./runtime-core-assistant-validation-sequences.js";
import { inferFinishReason } from "./runtime-core-recovery.js";

interface AssistantDeltaValidationState {
  completed: boolean;
  currentMessageId: string | undefined;
  deltaBuffer: string;
  partIndex: number;
  sawDelta: boolean;
  started: boolean;
  toolCallStarted: boolean;
}

interface AssistantBoundaryValidation {
  error?: TuvrenRuntimeError;
  handled: boolean;
}

export function isAssistantContentStreamEvent(
  type: TuvrenStreamEvent["type"]
): boolean {
  switch (type) {
    case "message.start":
    case "text.delta":
    case "text.done":
    case "reasoning.delta":
    case "reasoning.done":
    case "file.done":
    case "structured.delta":
    case "structured.done":
    case "tool_call.start":
    case "tool_call.args_delta":
    case "tool_call.done":
    case "message.done":
      return true;
    default:
      return false;
  }
}

export function isAssistantValidationEvent(
  type: TuvrenStreamEvent["type"]
): boolean {
  switch (type) {
    case "message.start":
    case "text.done":
    case "reasoning.done":
    case "file.done":
    case "structured.done":
    case "tool_call.start":
    case "tool_call.done":
    case "message.done":
      return true;
    default:
      return false;
  }
}

export function assertDriverRuntimeEvent(event: TuvrenStreamEvent): void {
  switch (event.type) {
    case "custom":
    case "message.start":
    case "text.delta":
    case "text.done":
    case "reasoning.delta":
    case "reasoning.done":
    case "file.done":
    case "structured.delta":
    case "structured.done":
    case "tool_call.start":
    case "tool_call.args_delta":
    case "tool_call.done":
    case "message.done":
      return;
    default:
      throw new TuvrenRuntimeError(
        `drivers must not emit shared-core event type "${event.type}" directly`,
        {
          code: "invalid_stream_event",
          details: {
            eventType: event.type,
          },
        }
      );
  }
}

export function serializeAssistantDeltaValue(value: unknown): string {
  return JSON.stringify(value) ?? "null";
}

function validateMissingAssistantMessage(
  assistantEvents: TuvrenStreamEvent[],
  messages: TuvrenMessage[],
  resolution: RuntimeResolution
): TuvrenRuntimeError | undefined {
  if (resolution.type === "fail" && resolution.fatality === "hard") {
    return validateFailedDriverAssistantEvents(assistantEvents);
  }
  // A pure provider-native/mediated stream emits message.start + message.done
  // (the stream protocol requires both) but produces no model text — only
  // pre-staged provider tool messages (AY003). Allow this: the assistant
  // events are envelope-only with no content, and the durable record is the
  // pre-staged tool message, not an assistant message.
  if (
    isProviderOnlyResponseEventSet(assistantEvents) &&
    messages.some(isPrestagedProviderToolMessage)
  ) {
    return undefined;
  }
  return new TuvrenRuntimeError(
    "drivers must not emit assistant content events without returning a durable assistant message",
    {
      code: "invalid_stream_event",
    }
  );
}

export function validateDriverAssistantEvents(
  messages: TuvrenMessage[],
  emittedEvents: TuvrenStreamEvent[],
  resolution: RuntimeResolution,
  assistantEventReconciliation: DriverAssistantEventReconciliation | undefined,
  activeExtensions: TuvrenExtension[]
): TuvrenRuntimeError | undefined {
  const assistantEvents = emittedEvents.filter((event) =>
    isAssistantContentStreamEvent(event.type)
  );

  if (assistantEvents.length === 0) {
    if (assistantEventReconciliation !== undefined) {
      return new TuvrenRuntimeError(
        "assistantEventReconciliation requires emitted assistant content events",
        {
          code: "invalid_stream_event",
        }
      );
    }

    return undefined;
  }

  const assistantMessage = messages.find(
    (message): message is Extract<TuvrenMessage, { role: "assistant" }> =>
      message.role === "assistant"
  );

  if (assistantMessage === undefined) {
    return validateMissingAssistantMessage(
      assistantEvents,
      messages,
      resolution
    );
  }

  const assistantSequencesOrError =
    splitAssistantEventSequences(assistantEvents);

  if (assistantSequencesOrError instanceof TuvrenRuntimeError) {
    return assistantSequencesOrError;
  }

  const finalAssistantSequence = assistantSequencesOrError.at(-1);

  if (finalAssistantSequence === undefined) {
    return createAssistantDeltaValidationError();
  }

  for (const sequence of assistantSequencesOrError.slice(0, -1)) {
    const sequenceValidationError =
      validateStandaloneAssistantSequence(sequence);

    if (sequenceValidationError !== undefined) {
      return sequenceValidationError;
    }
  }

  const finalSequenceMatchError = validateAssistantSequenceAgainstMessage(
    assistantMessage,
    finalAssistantSequence
  );

  if (assistantEventReconciliation === "allow_final_sequence_divergence") {
    if (
      !activeExtensions.some((extension) => extension.aroundModel !== undefined)
    ) {
      return new TuvrenRuntimeError(
        'assistantEventReconciliation "allow_final_sequence_divergence" requires an active aroundModel extension',
        {
          code: "invalid_stream_event",
        }
      );
    }

    if (finalSequenceMatchError === undefined) {
      return new TuvrenRuntimeError(
        'assistantEventReconciliation "allow_final_sequence_divergence" is only valid when the final emitted assistant sequence differs from the durable assistant message',
        {
          code: "invalid_stream_event",
        }
      );
    }

    if (
      assistantMessage.parts.some((part) => part.type === "tool_call") ||
      assistantSequenceRequestsTools(finalAssistantSequence)
    ) {
      return new TuvrenRuntimeError(
        'assistantEventReconciliation "allow_final_sequence_divergence" is not valid for tool-call assistant output',
        {
          code: "invalid_stream_event",
        }
      );
    }

    return validateStandaloneAssistantSequence(finalAssistantSequence);
  }

  return finalSequenceMatchError;
}

function validateAssistantSequenceAgainstMessage(
  assistantMessage: Extract<TuvrenMessage, { role: "assistant" }>,
  finalAssistantSequence: TuvrenStreamEvent[]
): TuvrenRuntimeError | undefined {
  const actualEvents = finalAssistantSequence.filter((event) =>
    isAssistantValidationEvent(event.type)
  );
  const messageId =
    actualEvents[0]?.type === "message.start"
      ? actualEvents[0].messageId
      : "assistant-validation";
  const expectedEvents = synthesizeAssistantValidationEvents(
    assistantMessage,
    messageId
  );

  if (actualEvents.length !== expectedEvents.length) {
    return new TuvrenRuntimeError(
      "driver-emitted assistant event sequences must be complete and match the durable assistant message",
      {
        code: "invalid_stream_event",
      }
    );
  }

  for (const [index, actualEvent] of actualEvents.entries()) {
    const expectedEvent = expectedEvents[index];

    if (
      expectedEvent === undefined ||
      !assistantValidationEventsMatch(actualEvent, expectedEvent)
    ) {
      return new TuvrenRuntimeError(
        "driver-emitted assistant events must match the durable assistant message",
        {
          code: "invalid_stream_event",
        }
      );
    }
  }

  const deltaValidationError = validateDriverAssistantDeltas(
    assistantMessage,
    finalAssistantSequence
  );

  if (deltaValidationError !== undefined) {
    return deltaValidationError;
  }

  return undefined;
}

function validateDriverAssistantDeltas(
  message: Extract<TuvrenMessage, { role: "assistant" }>,
  assistantEvents: TuvrenStreamEvent[]
): TuvrenRuntimeError | undefined {
  const state: AssistantDeltaValidationState = {
    completed: false,
    currentMessageId: undefined,
    deltaBuffer: "",
    partIndex: 0,
    sawDelta: false,
    started: false,
    toolCallStarted: false,
  };
  const expectedFinishReason = inferFinishReason(message);

  for (const event of assistantEvents) {
    const boundaryValidation = validateAssistantMessageBoundary(
      event,
      expectedFinishReason,
      state
    );

    if (boundaryValidation.handled) {
      continue;
    }

    if (boundaryValidation.error !== undefined) {
      return boundaryValidation.error;
    }

    const validationError = validateDriverAssistantDeltaEvent(
      message.parts,
      event,
      state
    );

    if (validationError !== undefined) {
      return validationError;
    }
  }

  if (
    !(state.started && state.completed) ||
    state.deltaBuffer !== "" ||
    state.sawDelta ||
    state.toolCallStarted
  ) {
    return createAssistantDeltaValidationError();
  }

  return undefined;
}

function validateAssistantMessageBoundary(
  event: TuvrenStreamEvent,
  expectedFinishReason: TuvrenModelResponse["finishReason"],
  state: AssistantDeltaValidationState
): AssistantBoundaryValidation {
  if (!state.started) {
    if (event.type !== "message.start") {
      return {
        error: createAssistantDeltaValidationError(),
        handled: false,
      };
    }

    state.currentMessageId = event.messageId;
    state.started = true;
    return {
      handled: true,
    };
  }

  if (state.completed) {
    return {
      error: createAssistantDeltaValidationError(),
      handled: false,
    };
  }

  if (!assistantEventBelongsToCurrentMessage(event, state.currentMessageId)) {
    return {
      error: createAssistantDeltaValidationError(),
      handled: false,
    };
  }

  if (event.type === "message.start") {
    return {
      error: createAssistantDeltaValidationError(),
      handled: false,
    };
  }

  if (event.type !== "message.done") {
    return {
      handled: false,
    };
  }

  if (
    !doesFinishReasonMatchAssistantContent(
      event.finishReason,
      expectedFinishReason
    )
  ) {
    return {
      error: createAssistantDeltaValidationError(),
      handled: false,
    };
  }

  state.completed = true;
  return {
    handled: true,
  };
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

function validateDriverAssistantDeltaEvent(
  parts: Extract<TuvrenMessage, { role: "assistant" }>["parts"],
  event: TuvrenStreamEvent,
  state: AssistantDeltaValidationState
): TuvrenRuntimeError | undefined {
  const currentPart = parts[state.partIndex];

  if (currentPart === undefined) {
    return createAssistantDeltaValidationError();
  }

  switch (currentPart.type) {
    case "file":
      return validateFileAssistantDeltaEvent(event, state);
    case "reasoning":
      return validateReasoningAssistantDeltaEvent(currentPart, event, state);
    case "structured":
      return validateStructuredAssistantDeltaEvent(currentPart, event, state);
    case "text":
      return validateTextAssistantDeltaEvent(currentPart, event, state);
    case "tool_call":
      return validateToolCallAssistantDeltaEvent(currentPart, event, state);
    default:
      return createAssistantDeltaValidationError();
  }
}

function validateFileAssistantDeltaEvent(
  event: TuvrenStreamEvent,
  state: AssistantDeltaValidationState
): TuvrenRuntimeError | undefined {
  if (event.type !== "file.done") {
    return createAssistantDeltaValidationError();
  }

  state.partIndex += 1;
  return undefined;
}

function validateReasoningAssistantDeltaEvent(
  part: Extract<ContentPart, { type: "reasoning" }>,
  event: TuvrenStreamEvent,
  state: AssistantDeltaValidationState
): TuvrenRuntimeError | undefined {
  if (event.type === "reasoning.delta") {
    state.deltaBuffer += event.delta;
    state.sawDelta = true;
    return undefined;
  }

  if (event.type !== "reasoning.done") {
    return createAssistantDeltaValidationError();
  }

  if (!part.redacted && part.text !== "" && state.deltaBuffer === "") {
    return createAssistantDeltaValidationError();
  }

  if (
    state.deltaBuffer !== "" &&
    (part.redacted || state.deltaBuffer !== part.text)
  ) {
    return createAssistantDeltaValidationError();
  }

  state.deltaBuffer = "";
  state.sawDelta = false;
  state.partIndex += 1;
  return undefined;
}

function validateStructuredAssistantDeltaEvent(
  part: Extract<ContentPart, { type: "structured" }>,
  event: TuvrenStreamEvent,
  state: AssistantDeltaValidationState
): TuvrenRuntimeError | undefined {
  if (event.type === "structured.delta") {
    state.deltaBuffer += event.delta;
    state.sawDelta = true;
    return undefined;
  }

  if (event.type !== "structured.done") {
    return createAssistantDeltaValidationError();
  }

  if (
    !(
      state.sawDelta &&
      doesSerializedDeltaMatchValue(state.deltaBuffer, part.data)
    )
  ) {
    return createAssistantDeltaValidationError();
  }

  state.deltaBuffer = "";
  state.sawDelta = false;
  state.partIndex += 1;
  return undefined;
}

function validateTextAssistantDeltaEvent(
  part: Extract<ContentPart, { type: "text" }>,
  event: TuvrenStreamEvent,
  state: AssistantDeltaValidationState
): TuvrenRuntimeError | undefined {
  if (event.type === "text.delta") {
    state.deltaBuffer += event.delta;
    state.sawDelta = true;
    return undefined;
  }

  if (event.type !== "text.done") {
    return createAssistantDeltaValidationError();
  }

  if (!state.sawDelta || state.deltaBuffer !== part.text) {
    return createAssistantDeltaValidationError();
  }

  state.deltaBuffer = "";
  state.sawDelta = false;
  state.partIndex += 1;
  return undefined;
}

function validateToolCallAssistantDeltaEvent(
  part: Extract<ContentPart, { type: "tool_call" }>,
  event: TuvrenStreamEvent,
  state: AssistantDeltaValidationState
): TuvrenRuntimeError | undefined {
  if (!state.toolCallStarted) {
    if (event.type !== "tool_call.start") {
      return createAssistantDeltaValidationError();
    }

    if (event.callId !== part.callId || event.name !== part.name) {
      return createAssistantDeltaValidationError();
    }

    state.toolCallStarted = true;
    return undefined;
  }

  if (event.type === "tool_call.args_delta") {
    if (event.callId !== part.callId) {
      return createAssistantDeltaValidationError();
    }

    state.deltaBuffer += event.delta;
    state.sawDelta = true;
    return undefined;
  }

  if (event.type !== "tool_call.done") {
    return createAssistantDeltaValidationError();
  }

  if (
    event.callId !== part.callId ||
    event.name !== part.name ||
    !isDeepStrictEqual(event.providerMetadata, part.providerMetadata) ||
    !state.sawDelta ||
    !doesSerializedDeltaMatchValue(state.deltaBuffer, part.input)
  ) {
    return createAssistantDeltaValidationError();
  }

  state.deltaBuffer = "";
  state.sawDelta = false;
  state.partIndex += 1;
  state.toolCallStarted = false;
  return undefined;
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

/**
 * Returns true when the emitted assistant events are envelope-only (just
 * message.start + message.done, no content). This is the streaming pattern
 * for a pure provider-native/mediated response (AY003): the stream protocol
 * requires start/done but the model produced no text.
 */
function isProviderOnlyResponseEventSet(
  assistantEvents: TuvrenStreamEvent[]
): boolean {
  return (
    assistantEvents.length === 2 &&
    assistantEvents[0]?.type === "message.start" &&
    assistantEvents[1]?.type === "message.done"
  );
}

function isPrestagedProviderToolMessage(message: TuvrenMessage): boolean {
  if (message.role !== "tool") {
    return false;
  }
  return message.parts.every((part) => {
    if (part.type !== "tool_result") {
      return false;
    }
    const meta = part.providerMetadata;
    return (
      typeof meta === "object" &&
      meta !== null &&
      (meta as Record<string, unknown>).owner === "provider"
    );
  });
}
