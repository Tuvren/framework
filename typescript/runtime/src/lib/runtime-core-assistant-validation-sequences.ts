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

/**
 * Delta accumulation state for an open reasoning, structured, or text part
 * inside a standalone assistant sequence.
 */
interface StandaloneAssistantActivePartState {
  deltaBuffer: string;
  kind: "reasoning" | "structured" | "text";
  sawDelta: boolean;
}

/**
 * Delta accumulation state for an open tool_call part inside a standalone
 * assistant sequence; `callId` and `name` pin subsequent args_delta/done
 * events to the started call.
 */
interface StandaloneAssistantToolCallState {
  callId: string;
  deltaBuffer: string;
  kind: "tool_call";
  name: string;
  sawDelta: boolean;
}

/**
 * Part-level cursor for standalone sequence validation: either no part is
 * open ("idle") or a delta-bearing part is being accumulated.
 */
type StandaloneAssistantPartState =
  | { kind: "idle" }
  | StandaloneAssistantActivePartState
  | StandaloneAssistantToolCallState;

/**
 * Mutable state threaded through standalone assistant sequence validation:
 * the messageId every event must belong to, the currently open part, and
 * whether any tool_call part has been seen (used to check the finish
 * reason).
 */
interface StandaloneAssistantValidationState {
  currentMessageId: string;
  partState: StandaloneAssistantPartState;
  sawToolCallPart: boolean;
}

/**
 * Creates the shared `invalid_stream_event` error returned for every
 * assistant event/delta validation failure.
 */
export const createAssistantDeltaValidationError = (): TuvrenRuntimeError =>
  new TuvrenRuntimeError(
    "runner-emitted assistant deltas must match the durable assistant message",
    {
      code: "invalid_stream_event",
    }
  );

/**
 * Splits runner-emitted assistant content events into message.start →
 * message.done sequences.
 *
 * Sequences must be strictly bracketed: a message.start inside an open
 * sequence, an event outside any open sequence, an unterminated trailing
 * sequence, or an empty event list all produce a validation error.
 *
 * @returns The ordered list of complete sequences, or a `TuvrenRuntimeError`
 * when bracketing is violated.
 */
export const splitAssistantEventSequences = (
  assistantEvents: TuvrenStreamEvent[]
): TuvrenRuntimeError | TuvrenStreamEvent[][] => {
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
};

const getAssistantEventMessageId = (
  event: TuvrenStreamEvent
): string | undefined =>
  "messageId" in event && event.type !== "steering.incorporated"
    ? event.messageId
    : undefined;

const assistantEventBelongsToCurrentMessage = (
  event: TuvrenStreamEvent,
  currentMessageId: string | undefined
): boolean => {
  const eventMessageId = getAssistantEventMessageId(event);

  return eventMessageId === undefined || eventMessageId === currentMessageId;
};

const validateStandaloneIdleAssistantEvent = (
  event: TuvrenStreamEvent,
  state: StandaloneAssistantValidationState
): TuvrenRuntimeError | undefined => {
  if (event.type === "file.done" || event.type === "reasoning.done") {
    return undefined;
  }

  if (event.type === "reasoning.delta") {
    state.partState = {
      deltaBuffer: event.delta,
      kind: "reasoning",
      sawDelta: true,
    };
    return undefined;
  }

  if (event.type === "structured.delta") {
    state.partState = {
      deltaBuffer: event.delta,
      kind: "structured",
      sawDelta: true,
    };
    return undefined;
  }

  if (event.type === "text.delta") {
    state.partState = {
      deltaBuffer: event.delta,
      kind: "text",
      sawDelta: true,
    };
    return undefined;
  }

  if (event.type === "tool_call.start") {
    state.partState = {
      callId: event.callId,
      deltaBuffer: "",
      kind: "tool_call",
      name: event.name,
      sawDelta: false,
    };
    state.sawToolCallPart = true;
    return undefined;
  }

  return createAssistantDeltaValidationError();
};

const validateStandaloneReasoningAssistantEvent = (
  event: TuvrenStreamEvent,
  state: StandaloneAssistantValidationState
): TuvrenRuntimeError | undefined => {
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
};

/**
 * Returns whether an accumulated delta buffer reassembles the expected done
 * payload, either as a raw string match or by parsing the buffer as JSON
 * and comparing deeply.
 */
const doesSerializedDeltaMatchValue = (
  serializedDelta: string,
  expectedValue: unknown
): boolean => {
  if (typeof expectedValue === "string" && serializedDelta === expectedValue) {
    return true;
  }

  try {
    return isDeepStrictEqual(JSON.parse(serializedDelta), expectedValue);
  } catch {
    return false;
  }
};

const validateStandaloneStructuredAssistantEvent = (
  event: TuvrenStreamEvent,
  state: StandaloneAssistantValidationState
): TuvrenRuntimeError | undefined => {
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
};

const validateStandaloneTextAssistantEvent = (
  event: TuvrenStreamEvent,
  state: StandaloneAssistantValidationState
): TuvrenRuntimeError | undefined => {
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
};

const validateStandaloneToolCallAssistantEvent = (
  event: TuvrenStreamEvent,
  state: StandaloneAssistantValidationState
): TuvrenRuntimeError | undefined => {
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
};

/**
 * Dispatches one in-sequence content event to the validator for the
 * currently open part state; message.start/message.done inside the body are
 * always invalid.
 */
const validateStandaloneAssistantPartEvent = (
  event: TuvrenStreamEvent,
  state: StandaloneAssistantValidationState
): TuvrenRuntimeError | undefined => {
  if (event.type === "message.start" || event.type === "message.done") {
    return createAssistantDeltaValidationError();
  }

  switch (state.partState.kind) {
    case "idle": {
      return validateStandaloneIdleAssistantEvent(event, state);
    }
    case "reasoning": {
      return validateStandaloneReasoningAssistantEvent(event, state);
    }
    case "structured": {
      return validateStandaloneStructuredAssistantEvent(event, state);
    }
    case "text": {
      return validateStandaloneTextAssistantEvent(event, state);
    }
    case "tool_call": {
      return validateStandaloneToolCallAssistantEvent(event, state);
    }
    default: {
      return createAssistantDeltaValidationError();
    }
  }
};

/**
 * Requires finishReason "tool_call" exactly when the sequence contained a
 * tool_call part, and any non-tool_call reason otherwise.
 */
const doesFinishReasonMatchToolCallPresence = (
  finishReason: TuvrenModelResponse["finishReason"],
  hasToolCallPart: boolean
): boolean => {
  if (hasToolCallPart) {
    return finishReason === "tool_call";
  }

  return finishReason !== "tool_call";
};

/**
 * Validates a single assistant event sequence for internal consistency
 * without comparing it to a durable message.
 *
 * The sequence must open with message.start and close with message.done,
 * every event must belong to the same messageId, every opened part must be
 * closed (no dangling delta buffers), structured/text/tool_call done
 * payloads must match their accumulated deltas, and the finish reason must
 * agree with whether the sequence contains tool-call parts.
 *
 * Used for non-final sequences and for final sequences whose divergence
 * from the durable message was explicitly allowed via
 * assistantEventReconciliation.
 */
export const validateStandaloneAssistantSequence = (
  assistantEvents: TuvrenStreamEvent[]
): TuvrenRuntimeError | undefined => {
  const [firstEvent] = assistantEvents;
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
};

/**
 * Validates assistant events emitted by a hard-failed run, where the last
 * sequence may legitimately be truncated.
 *
 * Complete sequences are held to the same rules as
 * {@link validateStandaloneAssistantSequence}; a trailing sequence without a
 * message.done is tolerated because the failure interrupted the stream
 * mid-message.
 */
export const validateFailedRunnerAssistantEvents = (
  assistantEvents: TuvrenStreamEvent[]
): TuvrenRuntimeError | undefined => {
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
};

/**
 * Synthesizes the expected non-delta assistant event sequence for a durable
 * assistant message.
 *
 * Produces a message.start, one done-style event per message part (with
 * tool_call parts expanding to tool_call.start + tool_call.done), and a
 * message.done whose finish reason is inferred from the message content.
 * Timestamps are fixed to 0; {@link assistantValidationEventsMatch} never
 * compares them.
 */
export const synthesizeAssistantValidationEvents = (
  message: Extract<TuvrenMessage, { role: "assistant" }>,
  messageId: string
): TuvrenStreamEvent[] => {
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
      case "file": {
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
      }
      case "reasoning": {
        events.push({
          messageId,
          timestamp: 0,
          type: "reasoning.done",
        });
        break;
      }
      case "structured": {
        events.push({
          data: cloneValue(part.data),
          messageId,
          name: part.name,
          timestamp: 0,
          type: "structured.done",
        });
        break;
      }
      case "text": {
        events.push({
          messageId,
          text: part.text,
          timestamp: 0,
          type: "text.done",
        });
        break;
      }
      case "tool_call": {
        events.push(
          {
            callId: part.callId,
            messageId,
            name: part.name,
            timestamp: 0,
            type: "tool_call.start",
          },
          {
            callId: part.callId,
            input: cloneValue(part.input),
            name: part.name,
            providerMetadata: cloneValue(part.providerMetadata),
            timestamp: 0,
            type: "tool_call.done",
          }
        );
        break;
      }
      case "tool_result": {
        break;
      }
      default: {
        break;
      }
    }
  }

  events.push({
    finishReason: inferFinishReason(message),
    messageId,
    timestamp: 0,
    type: "message.done",
  });

  return events;
};

/**
 * Deep equality with byte-wise handling for Uint8Array file payloads, which
 * isDeepStrictEqual alone would already compare but is special-cased here to
 * short-circuit on length.
 */
const areStreamEventValuesEqual = (left: unknown, right: unknown): boolean => {
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
};

type StreamEventOfType<TType extends TuvrenStreamEvent["type"]> = Extract<
  TuvrenStreamEvent,
  { type: TType }
>;

const messageStartEventsMatch = (
  actualEvent: StreamEventOfType<"message.start">,
  expectedEvent: StreamEventOfType<"message.start">
): boolean => actualEvent.messageId === expectedEvent.messageId;

const textDoneEventsMatch = (
  actualEvent: StreamEventOfType<"text.done">,
  expectedEvent: StreamEventOfType<"text.done">
): boolean =>
  actualEvent.messageId === expectedEvent.messageId &&
  actualEvent.text === expectedEvent.text;

const reasoningDoneEventsMatch = (
  actualEvent: StreamEventOfType<"reasoning.done">,
  expectedEvent: StreamEventOfType<"reasoning.done">
): boolean => actualEvent.messageId === expectedEvent.messageId;

const fileDoneEventsMatch = (
  actualEvent: StreamEventOfType<"file.done">,
  expectedEvent: StreamEventOfType<"file.done">
): boolean =>
  actualEvent.messageId === expectedEvent.messageId &&
  actualEvent.filename === expectedEvent.filename &&
  actualEvent.mediaType === expectedEvent.mediaType &&
  areStreamEventValuesEqual(actualEvent.data, expectedEvent.data);

const structuredDoneEventsMatch = (
  actualEvent: StreamEventOfType<"structured.done">,
  expectedEvent: StreamEventOfType<"structured.done">
): boolean =>
  actualEvent.messageId === expectedEvent.messageId &&
  actualEvent.name === expectedEvent.name &&
  isDeepStrictEqual(actualEvent.data, expectedEvent.data);

const toolCallStartEventsMatch = (
  actualEvent: StreamEventOfType<"tool_call.start">,
  expectedEvent: StreamEventOfType<"tool_call.start">
): boolean =>
  actualEvent.messageId === expectedEvent.messageId &&
  actualEvent.callId === expectedEvent.callId &&
  actualEvent.name === expectedEvent.name;

const toolCallDoneEventsMatch = (
  actualEvent: StreamEventOfType<"tool_call.done">,
  expectedEvent: StreamEventOfType<"tool_call.done">
): boolean =>
  actualEvent.callId === expectedEvent.callId &&
  actualEvent.name === expectedEvent.name &&
  isDeepStrictEqual(
    actualEvent.providerMetadata,
    expectedEvent.providerMetadata
  ) &&
  isDeepStrictEqual(actualEvent.input, expectedEvent.input);

/**
 * Compares finish reasons at the granularity assistant validation cares
 * about: "tool_call" must match exactly, while all non-tool_call reasons
 * (stop, length, and so on) are treated as interchangeable.
 */
export const doesFinishReasonMatchAssistantContent = (
  actualFinishReason: TuvrenModelResponse["finishReason"],
  expectedFinishReason: TuvrenModelResponse["finishReason"]
): boolean => {
  if (expectedFinishReason === "tool_call") {
    return actualFinishReason === "tool_call";
  }

  return actualFinishReason !== "tool_call";
};

const messageDoneEventsMatch = (
  actualEvent: StreamEventOfType<"message.done">,
  expectedEvent: StreamEventOfType<"message.done">
): boolean =>
  actualEvent.messageId === expectedEvent.messageId &&
  doesFinishReasonMatchAssistantContent(
    actualEvent.finishReason,
    expectedEvent.finishReason
  );

/**
 * Compares an actual runner-emitted validation event against a synthesized
 * expected event, checking only semantically significant fields.
 *
 * Timestamps are ignored. Structured data, tool inputs, and provider
 * metadata use deep equality; file data uses byte-wise comparison; finish
 * reasons only distinguish "tool_call" from every non-tool_call reason.
 */
export const assistantValidationEventsMatch = (
  actualEvent: TuvrenStreamEvent,
  expectedEvent: TuvrenStreamEvent
): boolean => {
  if (actualEvent.type !== expectedEvent.type) {
    return false;
  }

  if (
    actualEvent.type === "message.start" &&
    expectedEvent.type === "message.start"
  ) {
    return messageStartEventsMatch(actualEvent, expectedEvent);
  }

  if (actualEvent.type === "text.done" && expectedEvent.type === "text.done") {
    return textDoneEventsMatch(actualEvent, expectedEvent);
  }

  if (
    actualEvent.type === "reasoning.done" &&
    expectedEvent.type === "reasoning.done"
  ) {
    return reasoningDoneEventsMatch(actualEvent, expectedEvent);
  }

  if (actualEvent.type === "file.done" && expectedEvent.type === "file.done") {
    return fileDoneEventsMatch(actualEvent, expectedEvent);
  }

  if (
    actualEvent.type === "structured.done" &&
    expectedEvent.type === "structured.done"
  ) {
    return structuredDoneEventsMatch(actualEvent, expectedEvent);
  }

  if (
    actualEvent.type === "tool_call.start" &&
    expectedEvent.type === "tool_call.start"
  ) {
    return toolCallStartEventsMatch(actualEvent, expectedEvent);
  }

  if (
    actualEvent.type === "tool_call.done" &&
    expectedEvent.type === "tool_call.done"
  ) {
    return toolCallDoneEventsMatch(actualEvent, expectedEvent);
  }

  if (
    actualEvent.type === "message.done" &&
    expectedEvent.type === "message.done"
  ) {
    return messageDoneEventsMatch(actualEvent, expectedEvent);
  }

  return false;
};

/**
 * Returns whether an assistant event sequence contains any tool-call
 * activity: tool_call.start/args_delta/done events or a message.done with
 * finishReason "tool_call".
 */
export const assistantSequenceRequestsTools = (
  events: TuvrenStreamEvent[]
): boolean =>
  events.some(
    (event) =>
      event.type === "tool_call.start" ||
      event.type === "tool_call.args_delta" ||
      event.type === "tool_call.done" ||
      (event.type === "message.done" && event.finishReason === "tool_call")
  );
