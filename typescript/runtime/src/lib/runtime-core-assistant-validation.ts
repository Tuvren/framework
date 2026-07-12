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
import type { RuntimeResolution } from "@tuvren/core/execution";
import type { TuvrenExtension } from "@tuvren/core/extensions";
import type { ContentPart, TuvrenMessage } from "@tuvren/core/messages";
import type { TuvrenModelResponse } from "@tuvren/core/provider";
import type { RunnerAssistantEventReconciliation } from "@tuvren/core/runner";
import {
  assistantSequenceRequestsTools,
  assistantValidationEventsMatch,
  createAssistantDeltaValidationError,
  doesFinishReasonMatchAssistantContent,
  splitAssistantEventSequences,
  synthesizeAssistantValidationEvents,
  validateFailedRunnerAssistantEvents,
  validateStandaloneAssistantSequence,
} from "./runtime-core-assistant-validation-sequences.js";
import { inferFinishReason } from "./runtime-core-recovery.js";

/**
 * Mutable cursor state used while replaying a runner-emitted assistant event
 * sequence against the parts of the durable assistant message. `partIndex`
 * points at the durable part currently being matched; `deltaBuffer` and
 * `sawDelta` accumulate delta payloads until the part's done event closes it.
 */
interface AssistantDeltaValidationState {
  completed: boolean;
  currentMessageId: string | undefined;
  deltaBuffer: string;
  partIndex: number;
  sawDelta: boolean;
  started: boolean;
  toolCallStarted: boolean;
}

/**
 * Result of checking one event against message.start/message.done boundary
 * rules: `handled` means the event was consumed by boundary processing and
 * needs no part-level validation; `error` carries a boundary violation.
 */
interface AssistantBoundaryValidation {
  error?: TuvrenRuntimeError;
  handled: boolean;
}

/**
 * Returns whether a stream event type belongs to the assistant content
 * envelope: message.start/message.done plus the text, reasoning, file,
 * structured, and tool_call content events emitted between them.
 *
 * Used to select the runner-emitted events that participate in assistant
 * event validation and synthesis; `custom` and runtime lifecycle events are
 * excluded.
 */
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

/**
 * Returns whether a stream event type participates in structural (non-delta)
 * assistant validation.
 *
 * This is the {@link isAssistantContentStreamEvent} subset without the
 * `*.delta` and `tool_call.args_delta` types; delta events are validated
 * separately by accumulating their payloads against the durable message
 * parts.
 */
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

/**
 * Asserts that a runner-emitted stream event uses only the event types
 * runners may emit directly: `custom` plus the assistant content envelope.
 *
 * Shared-core lifecycle events (run, turn, tool, error projections, and so
 * on) are owned by the runtime and must never be emitted by runners.
 *
 * @throws TuvrenRuntimeError with code `invalid_stream_event` when the event
 * type is not runner-emittable.
 */
export function assertRunnerRuntimeEvent(event: TuvrenStreamEvent): void {
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
        `runners must not emit shared-core event type "${event.type}" directly`,
        {
          code: "invalid_stream_event",
          details: {
            eventType: event.type,
          },
        }
      );
  }
}

/**
 * Serializes a structured-output or tool-call input value into the canonical
 * delta string used when synthesizing assistant delta events.
 *
 * @returns `JSON.stringify(value)`, or the string `"null"` when the value is
 * not JSON-serializable (for example `undefined`).
 */
export function serializeAssistantDeltaValue(value: unknown): string {
  return JSON.stringify(value) ?? "null";
}

/**
 * Validates assistant content events that were emitted without a durable
 * assistant message being returned.
 *
 * This is only acceptable for hard-failed runs (where the stream may be
 * truncated) and for envelope-only provider-native/mediated responses backed
 * by pre-staged provider tool messages (AY003); any other combination is an
 * invalid stream.
 */
function validateMissingAssistantMessage(
  assistantEvents: TuvrenStreamEvent[],
  messages: TuvrenMessage[],
  resolution: RuntimeResolution
): TuvrenRuntimeError | undefined {
  if (resolution.type === "fail" && resolution.fatality === "hard") {
    return validateFailedRunnerAssistantEvents(assistantEvents);
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
    "runners must not emit assistant content events without returning a durable assistant message",
    {
      code: "invalid_stream_event",
    }
  );
}

/**
 * Validates that runner-emitted assistant content events are consistent with
 * the durable assistant message the runner returned.
 *
 * Emitted events are filtered to assistant content events and split into
 * message.start → message.done sequences. Every non-final sequence must be a
 * well-formed standalone sequence; the final sequence must additionally match
 * the durable assistant message part-for-part, including reassembled delta
 * buffers and a finish reason consistent with the message's tool-call
 * content. Emitting assistant events without a durable assistant message is
 * only allowed for hard failures and envelope-only provider tool responses
 * (AY003).
 *
 * When `assistantEventReconciliation` is `"allow_final_sequence_divergence"`,
 * the final sequence may diverge from the durable message, provided an
 * `aroundModel` extension is active, the divergence actually exists, and
 * neither the message nor the final sequence involves tool calls; the final
 * sequence must still be internally well formed.
 *
 * @param messages - Durable messages returned by the runner.
 * @param emittedEvents - Every event the runner emitted during execution.
 * @param resolution - Effective resolution for the iteration; a hard "fail"
 * relaxes the durable-message requirement for truncated streams.
 * @param assistantEventReconciliation - Optional runner opt-out of final
 * sequence matching; invalid when no assistant events were emitted.
 * @param activeExtensions - Extensions active in the current agent config,
 * used to authorize reconciliation.
 * @returns A `TuvrenRuntimeError` describing the first violation, or
 * `undefined` when the emitted events are valid.
 */
export function validateRunnerAssistantEvents(
  messages: TuvrenMessage[],
  emittedEvents: TuvrenStreamEvent[],
  resolution: RuntimeResolution,
  assistantEventReconciliation: RunnerAssistantEventReconciliation | undefined,
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

/**
 * Validates the final assistant event sequence against the durable assistant
 * message: the non-delta events must match the synthesized expected sequence
 * one-for-one, and the delta events must reassemble each message part
 * exactly.
 */
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
      "runner-emitted assistant event sequences must be complete and match the durable assistant message",
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
        "runner-emitted assistant events must match the durable assistant message",
        {
          code: "invalid_stream_event",
        }
      );
    }
  }

  const deltaValidationError = validateRunnerAssistantDeltas(
    assistantMessage,
    finalAssistantSequence
  );

  if (deltaValidationError !== undefined) {
    return deltaValidationError;
  }

  return undefined;
}

/**
 * Replays the full assistant event sequence (deltas included) against the
 * durable message parts, requiring exactly one message.start/message.done
 * bracket, per-part delta buffers that reassemble each part's content, and
 * no dangling buffers or open tool calls at the end.
 */
function validateRunnerAssistantDeltas(
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

    const validationError = validateRunnerAssistantDeltaEvent(
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

/**
 * Handles message.start/message.done bracketing for the delta replay: the
 * first event must be message.start, all subsequent events must carry the
 * same messageId, no event may follow message.done, and the message.done
 * finish reason must agree with the durable message's tool-call content.
 */
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

/**
 * Dispatches one content event to the validator for the durable message part
 * the replay cursor currently points at; events past the last part fail.
 */
function validateRunnerAssistantDeltaEvent(
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

/**
 * Returns whether an accumulated delta buffer reassembles the expected
 * durable value, either as a raw string match or by parsing the buffer as
 * JSON and comparing deeply.
 */
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

/**
 * Returns true for a tool-role message whose parts are all provider-owned
 * tool results (`providerMetadata.owner === "provider"`), i.e. results the
 * provider executed itself and pre-staged instead of routing through the
 * Tool Execution Gateway (AY003).
 */
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
