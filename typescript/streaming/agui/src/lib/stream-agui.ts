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

import { type AGUIEvent, EventSchemas, EventType } from "@ag-ui/core";
import { TuvrenRuntimeError } from "@tuvren/core";
import type { TuvrenStreamEvent } from "@tuvren/core/events";
import {
  cloneTuvrenStreamEvent,
  createStreamAdapterWarningReporter,
  type StreamAdapterOptions,
} from "@tuvren/stream-core";

/** Tracks one reasoning block's AG-UI `REASONING_*` lifecycle across canonical `reasoning.*` events. */
interface PendingReasoningState {
  messageId: string;
  /** True once `REASONING_MESSAGE_START` has been emitted (only when a non-empty delta arrived). */
  messageStarted: boolean;
  /** True once `REASONING_START` has been emitted. */
  started: boolean;
}

/** Tracks one assistant message's AG-UI `TEXT_MESSAGE_*` lifecycle across canonical `text.*` events. */
interface PendingTextState {
  /** True once `TEXT_MESSAGE_END` has been emitted. */
  ended: boolean;
  messageId: string;
  /** True once at least one non-empty `TEXT_MESSAGE_CONTENT` has been emitted. */
  sawContent: boolean;
  /** True once `TEXT_MESSAGE_START` has been emitted. */
  started: boolean;
}

/** Tracks one tool call's AG-UI `TOOL_CALL_*` lifecycle across canonical `tool_call.*` events. */
interface PendingToolCallState {
  /** True once `TOOL_CALL_ARGS` has been emitted at least once. */
  argsEmitted: boolean;
  callId: string;
  name?: string;
  parentMessageId?: string;
  /** True once `TOOL_CALL_START` has been emitted. */
  started: boolean;
}

/**
 * Stable warning codes reported through `options.onWarning` when a canonical
 * event has no first-class AG-UI mapping and falls back to a `CUSTOM` event
 * (see {@link createCustomFallbackEvent}).
 */
const CUSTOM_FALLBACK_WARNING_CODES = {
  approval: "agui_approval_custom_fallback",
  file: "agui_file_output_custom_fallback",
  messageDone: "agui_message_done_custom_fallback",
  nonFatalError: "agui_nonfatal_error_custom_fallback",
  pausedTurn: "agui_paused_turn_coerced_to_run_finished",
  stateCheckpoint: "agui_state_checkpoint_custom_fallback",
  steering: "agui_steering_custom_fallback",
  structured: "agui_structured_output_custom_fallback",
  toolExecution: "agui_tool_execution_custom_fallback",
} as const;

/**
 * Maps a `TuvrenStreamEvent` stream onto `@ag-ui/core` events.
 *
 * Every emitted event is validated against `EventSchemas` before yielding
 * (see {@link validateAgUiEvent}), so a mapping defect surfaces as a thrown
 * `invalid_agui_event` error rather than propagating a malformed AG-UI
 * payload. Substream lifecycles (text messages, reasoning blocks, tool
 * calls) are tracked in per-id state maps across canonical events; if the
 * enclosing turn ends before a substream's own terminal event arrived, its
 * AG-UI closing events are synthesized so no AG-UI substream is left open
 * (see {@link flushPendingAgUiSubstreams}).
 *
 * Canonical events without a first-class AG-UI counterpart (tool execution
 * events, approvals, file output, non-fatal errors, state checkpoints,
 * steering, structured output) become `CUSTOM` events named
 * `tuvren.runtime.<event.type>`, each reported once through
 * `options.onWarning` with a fixed code from
 * {@link CUSTOM_FALLBACK_WARNING_CODES}.
 *
 * The source iterator is claimed synchronously (before any `await`), so this
 * adapter satisfies a `teeTuvrenStreamEvents` branch's claim-before-first-pull
 * rule immediately upon being called, regardless of when the returned
 * iterable is actually iterated.
 */
export function toAgUiEvents(
  events: AsyncIterable<TuvrenStreamEvent>,
  options?: StreamAdapterOptions
): AsyncIterable<AGUIEvent> {
  // Claim tee-backed sources immediately so sibling adapter branches can still
  // subscribe before any one consumer starts pulling the shared source stream.
  return toAgUiEventsSubscribed(
    createIteratorIterable(events[Symbol.asyncIterator]()),
    options
  );
}

/**
 * The canonical-to-AG-UI mapping table, one `case` per `TuvrenStreamEvent`
 * type. Notable non-mechanical mappings:
 *
 * - `turn.start`/`turn.end` bracket `RUN_STARTED`/`RUN_ERROR`|`RUN_FINISHED`;
 *   `event.resumedFrom` becomes AG-UI's own `parentRunId` lineage field
 *   rather than being folded into a synthetic run id.
 * - A `"paused"` turn additionally emits a `CUSTOM` pause marker before
 *   `RUN_FINISHED`, since AG-UI has no first-class paused-run event.
 * - `text.done`/`reasoning.done` retroactively emit the `*_START` event (and
 *   a synthesized content delta for `text.done`) if no prior delta already
 *   started the substream, so a non-streaming or short-circuited response
 *   still produces a complete AG-UI substream.
 * - `tool_call.done` synthesizes `TOOL_CALL_START`/`TOOL_CALL_ARGS` first when
 *   no prior `tool_call.start`/`args_delta` arrived, from the durable final
 *   input.
 *
 * @throws TuvrenRuntimeError with code `invalid_stream_adapter_state` when a
 *   `turn.end` arrives with no matching `turn.start` (see
 *   {@link requireActiveRunState}), or when an event type outside the
 *   canonical union is encountered (defensive exhaustiveness check).
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Protocol projection intentionally keeps the canonical-to-AG-UI mapping table in one switch.
async function* toAgUiEventsSubscribed(
  events: AsyncIterable<TuvrenStreamEvent>,
  options?: StreamAdapterOptions
): AsyncIterable<AGUIEvent> {
  const reportWarning = createStreamAdapterWarningReporter(options);
  const reasoningStates = new Map<string, PendingReasoningState>();
  const textStates = new Map<string, PendingTextState>();
  const toolCallStates = new Map<string, PendingToolCallState>();
  let activeRunId: string | undefined;
  let activeThreadId: string | undefined;
  let latestFatalError:
    | Extract<TuvrenStreamEvent, { type: "error" }>
    | undefined;

  for await (const event of events) {
    switch (event.type) {
      case "turn.start": {
        // AG-UI already models resumed lineage with parentRunId, so resumed
        // turns keep the canonical turn id as runId instead of encoding lineage
        // into a synthetic identifier that hosts would have to parse back out.
        activeRunId = event.turnId;
        activeThreadId = event.threadId;
        latestFatalError = undefined;

        yield validateAgUiEvent({
          parentRunId: event.resumedFrom,
          rawEvent: cloneTuvrenStreamEvent(event),
          runId: activeRunId,
          threadId: activeThreadId,
          timestamp: event.timestamp,
          type: EventType.RUN_STARTED,
        });
        break;
      }
      case "turn.end": {
        for (const pendingEvent of flushPendingAgUiSubstreams(
          reasoningStates,
          textStates,
          toolCallStates,
          event
        )) {
          yield pendingEvent;
        }

        // All terminal paths must still prove that the canonical run lifecycle
        // started correctly before the adapter projects a terminal AG-UI event.
        const activeRunState = requireActiveRunState(
          activeRunId,
          activeThreadId,
          event
        );

        if (event.status === "failed") {
          yield validateAgUiEvent({
            code: latestFatalError?.error.code,
            message:
              latestFatalError?.error.message ??
              `Turn "${event.turnId}" failed without a fatal error event.`,
            rawEvent: cloneTuvrenStreamEvent(latestFatalError ?? event),
            timestamp: event.timestamp,
            type: EventType.RUN_ERROR,
          });
        } else {
          if (event.status === "paused") {
            reportWarning({
              code: CUSTOM_FALLBACK_WARNING_CODES.pausedTurn,
              message:
                "AG-UI has no first-class paused run event, so paused turns are emitted as CUSTOM plus RUN_FINISHED.",
            });

            // The custom pause event preserves the exact Tuvren semantics. The
            // following RUN_FINISHED keeps AG-UI lifecycle consumers well-formed.
            yield createCustomAgUiEvent(
              "tuvren.runtime.turn.paused",
              event,
              event.timestamp,
              event
            );
          }

          yield validateAgUiEvent({
            rawEvent: cloneTuvrenStreamEvent(event),
            result: {
              status: event.status,
            },
            runId: activeRunState.runId,
            threadId: activeRunState.threadId,
            timestamp: event.timestamp,
            type: EventType.RUN_FINISHED,
          });
        }

        activeRunId = undefined;
        activeThreadId = undefined;
        latestFatalError = undefined;
        break;
      }
      case "iteration.start":
        yield validateAgUiEvent({
          rawEvent: cloneTuvrenStreamEvent(event),
          stepName: `iteration-${event.iterationCount}`,
          timestamp: event.timestamp,
          type: EventType.STEP_STARTED,
        });
        break;
      case "iteration.end":
        yield validateAgUiEvent({
          rawEvent: cloneTuvrenStreamEvent(event),
          stepName: `iteration-${event.iterationCount}`,
          timestamp: event.timestamp,
          type: EventType.STEP_FINISHED,
        });
        break;
      case "message.start":
        if (!textStates.has(event.messageId)) {
          textStates.set(event.messageId, {
            ended: false,
            messageId: event.messageId,
            sawContent: false,
            started: false,
          });
        }
        break;
      case "text.delta": {
        const textState = ensureTextState(textStates, event.messageId);

        if (!textState.started) {
          textState.started = true;
          yield validateAgUiEvent({
            messageId: event.messageId,
            rawEvent: cloneTuvrenStreamEvent(event),
            role: "assistant",
            timestamp: event.timestamp,
            type: EventType.TEXT_MESSAGE_START,
          });
        }

        if (event.delta.length > 0) {
          textState.sawContent = true;
          yield validateAgUiEvent({
            delta: event.delta,
            messageId: event.messageId,
            rawEvent: cloneTuvrenStreamEvent(event),
            timestamp: event.timestamp,
            type: EventType.TEXT_MESSAGE_CONTENT,
          });
        }
        break;
      }
      case "text.done": {
        const textState = ensureTextState(textStates, event.messageId);

        if (!textState.started) {
          textState.started = true;
          yield validateAgUiEvent({
            messageId: event.messageId,
            rawEvent: cloneTuvrenStreamEvent(event),
            role: "assistant",
            timestamp: event.timestamp,
            type: EventType.TEXT_MESSAGE_START,
          });
        }

        if (!textState.sawContent && event.text.length > 0) {
          textState.sawContent = true;
          yield validateAgUiEvent({
            delta: event.text,
            messageId: event.messageId,
            rawEvent: cloneTuvrenStreamEvent(event),
            timestamp: event.timestamp,
            type: EventType.TEXT_MESSAGE_CONTENT,
          });
        }

        if (!textState.ended) {
          textState.ended = true;
          yield validateAgUiEvent({
            messageId: event.messageId,
            rawEvent: cloneTuvrenStreamEvent(event),
            timestamp: event.timestamp,
            type: EventType.TEXT_MESSAGE_END,
          });
        }

        textStates.delete(event.messageId);
        break;
      }
      case "reasoning.delta": {
        const reasoningId = toReasoningMessageId(event.messageId);
        const reasoningState = ensureReasoningState(
          reasoningStates,
          reasoningId
        );

        if (!reasoningState.started) {
          reasoningState.started = true;
          yield validateAgUiEvent({
            messageId: reasoningId,
            rawEvent: cloneTuvrenStreamEvent(event),
            timestamp: event.timestamp,
            type: EventType.REASONING_START,
          });
        }

        if (!reasoningState.messageStarted) {
          reasoningState.messageStarted = true;
          yield validateAgUiEvent({
            messageId: reasoningId,
            rawEvent: cloneTuvrenStreamEvent(event),
            role: "reasoning",
            timestamp: event.timestamp,
            type: EventType.REASONING_MESSAGE_START,
          });
        }

        if (event.delta.length > 0) {
          yield validateAgUiEvent({
            delta: event.delta,
            messageId: reasoningId,
            rawEvent: cloneTuvrenStreamEvent(event),
            timestamp: event.timestamp,
            type: EventType.REASONING_MESSAGE_CONTENT,
          });
        }
        break;
      }
      case "reasoning.done": {
        const reasoningId = toReasoningMessageId(event.messageId);
        const reasoningState = ensureReasoningState(
          reasoningStates,
          reasoningId
        );

        if (!reasoningState.started) {
          reasoningState.started = true;
          yield validateAgUiEvent({
            messageId: reasoningId,
            rawEvent: cloneTuvrenStreamEvent(event),
            timestamp: event.timestamp,
            type: EventType.REASONING_START,
          });
        }

        if (reasoningState.messageStarted) {
          yield validateAgUiEvent({
            messageId: reasoningId,
            rawEvent: cloneTuvrenStreamEvent(event),
            timestamp: event.timestamp,
            type: EventType.REASONING_MESSAGE_END,
          });
        }

        yield validateAgUiEvent({
          messageId: reasoningId,
          rawEvent: cloneTuvrenStreamEvent(event),
          timestamp: event.timestamp,
          type: EventType.REASONING_END,
        });
        reasoningStates.delete(reasoningId);
        break;
      }
      case "tool_call.start": {
        const toolCallState = toolCallStates.get(event.callId);

        toolCallStates.set(event.callId, {
          argsEmitted: toolCallState?.argsEmitted ?? false,
          callId: event.callId,
          name: event.name,
          parentMessageId: event.messageId,
          started: true,
        });
        yield validateAgUiEvent({
          parentMessageId: event.messageId,
          rawEvent: cloneTuvrenStreamEvent(event),
          timestamp: event.timestamp,
          toolCallId: event.callId,
          toolCallName: event.name,
          type: EventType.TOOL_CALL_START,
        });
        break;
      }
      case "tool_call.args_delta": {
        const toolCallState = toolCallStates.get(event.callId);

        if (toolCallState === undefined || !toolCallState.started) {
          yield createCustomFallbackEvent(
            "tuvren.runtime.tool_call.args_delta",
            event,
            reportWarning,
            "toolExecution"
          );
          break;
        }

        if (event.delta.length === 0) {
          break;
        }

        toolCallState.argsEmitted = true;
        yield validateAgUiEvent({
          delta: event.delta,
          rawEvent: cloneTuvrenStreamEvent(event),
          timestamp: event.timestamp,
          toolCallId: event.callId,
          type: EventType.TOOL_CALL_ARGS,
        });
        break;
      }
      case "tool_call.done": {
        const toolCallState = toolCallStates.get(event.callId) ?? {
          argsEmitted: false,
          callId: event.callId,
          name: event.name,
          parentMessageId: undefined,
          started: false,
        };

        if (!toolCallState.started) {
          // Canonical streams may legitimately materialize only the finalized
          // tool_call.done payload. In that case we synthesize the AG-UI start
          // and args events from the durable final input instead of dropping the
          // tool call.
          toolCallState.started = true;
          toolCallState.name = event.name;
          toolCallStates.set(event.callId, toolCallState);
          yield validateAgUiEvent({
            rawEvent: cloneTuvrenStreamEvent(event),
            timestamp: event.timestamp,
            toolCallId: event.callId,
            toolCallName: event.name,
            type: EventType.TOOL_CALL_START,
          });
        }

        if (!toolCallState.argsEmitted) {
          toolCallState.argsEmitted = true;
          yield validateAgUiEvent({
            delta: serializeAgUiTextValue(event.input),
            rawEvent: cloneTuvrenStreamEvent(event),
            timestamp: event.timestamp,
            toolCallId: event.callId,
            type: EventType.TOOL_CALL_ARGS,
          });
        }

        yield validateAgUiEvent({
          rawEvent: cloneTuvrenStreamEvent(event),
          timestamp: event.timestamp,
          toolCallId: event.callId,
          type: EventType.TOOL_CALL_END,
        });
        toolCallStates.delete(event.callId);
        break;
      }
      case "tool.result":
        yield validateAgUiEvent({
          content: serializeAgUiTextValue(event.output),
          messageId: `tool-result:${event.callId}`,
          rawEvent: cloneTuvrenStreamEvent(event),
          role: "tool",
          timestamp: event.timestamp,
          toolCallId: event.callId,
          type: EventType.TOOL_CALL_RESULT,
        });
        break;
      case "state.snapshot":
        yield validateAgUiEvent({
          rawEvent: cloneTuvrenStreamEvent(event),
          snapshot: {
            contextManifest: event.manifest,
          },
          timestamp: event.timestamp,
          type: EventType.STATE_SNAPSHOT,
        });
        break;
      case "custom":
        yield createCustomAgUiEvent(
          event.name,
          event.data,
          event.timestamp,
          event
        );
        break;
      case "error":
        if (event.fatal) {
          latestFatalError = event;
          break;
        }

        yield createCustomFallbackEvent(
          "tuvren.runtime.error",
          event,
          reportWarning,
          "nonFatalError"
        );
        break;
      case "approval.requested":
        yield createCustomFallbackEvent(
          "tuvren.runtime.approval.requested",
          event,
          reportWarning,
          "approval"
        );
        break;
      case "approval.resolved":
        yield createCustomFallbackEvent(
          "tuvren.runtime.approval.resolved",
          event,
          reportWarning,
          "approval"
        );
        break;
      case "file.done":
        yield createCustomFallbackEvent(
          "tuvren.runtime.file.done",
          event,
          reportWarning,
          "file"
        );
        break;
      case "message.done":
        yield createCustomFallbackEvent(
          "tuvren.runtime.message.done",
          event,
          reportWarning,
          "messageDone"
        );
        break;
      case "state.checkpoint":
        yield createCustomFallbackEvent(
          "tuvren.runtime.state.checkpoint",
          event,
          reportWarning,
          "stateCheckpoint"
        );
        break;
      case "steering.incorporated":
        yield createCustomFallbackEvent(
          "tuvren.runtime.steering.incorporated",
          event,
          reportWarning,
          "steering"
        );
        break;
      case "structured.delta":
        yield createCustomFallbackEvent(
          "tuvren.runtime.structured.delta",
          event,
          reportWarning,
          "structured"
        );
        break;
      case "structured.done":
        yield createCustomFallbackEvent(
          "tuvren.runtime.structured.done",
          event,
          reportWarning,
          "structured"
        );
        break;
      case "tool.start":
        yield createCustomFallbackEvent(
          "tuvren.runtime.tool.start",
          event,
          reportWarning,
          "toolExecution"
        );
        break;
      case "tool.audit":
        yield createCustomFallbackEvent(
          "tuvren.runtime.tool.audit",
          event,
          reportWarning,
          "toolExecution"
        );
        break;
      default:
        throwUnreachableEvent(event);
    }
  }
}

/** Builds a validated AG-UI `CUSTOM` event, optionally attaching the originating canonical event as `rawEvent`. */
function createCustomAgUiEvent(
  name: string,
  value: unknown,
  timestamp: number,
  rawEvent?: TuvrenStreamEvent
): AGUIEvent {
  return validateAgUiEvent({
    name,
    rawEvent:
      rawEvent === undefined ? undefined : cloneTuvrenStreamEvent(rawEvent),
    timestamp,
    type: EventType.CUSTOM,
    value,
  });
}

/**
 * Reports the fixed warning code for `warningCode` and wraps `event` as a
 * `CUSTOM` AG-UI event — the shared path behind every canonical event type
 * with no first-class AG-UI mapping.
 */
function createCustomFallbackEvent(
  name: string,
  event: TuvrenStreamEvent,
  reportWarning: (warning: { code: string; message: string }) => void,
  warningCode: keyof typeof CUSTOM_FALLBACK_WARNING_CODES
): AGUIEvent {
  reportWarning({
    code: CUSTOM_FALLBACK_WARNING_CODES[warningCode],
    message: `AG-UI requires a CUSTOM fallback for "${event.type}".`,
  });

  return createCustomAgUiEvent(name, event, event.timestamp, event);
}

/**
 * @throws TuvrenRuntimeError with code `invalid_stream_adapter_state` when
 *   `activeRunId`/`activeThreadId` are unset — a `turn.end` arrived without a
 *   preceding `turn.start` in this stream.
 */
function requireActiveRunState(
  activeRunId: string | undefined,
  activeThreadId: string | undefined,
  event: Extract<TuvrenStreamEvent, { type: "turn.end" }>
): { runId: string; threadId: string } {
  if (activeRunId !== undefined && activeThreadId !== undefined) {
    return {
      runId: activeRunId,
      threadId: activeThreadId,
    };
  }

  throw new TuvrenRuntimeError(
    `turn "${event.turnId}" ended without a preceding turn.start`,
    {
      code: "invalid_stream_adapter_state",
    }
  );
}

/** Gets or lazily creates the {@link PendingReasoningState} for `reasoningId`. */
function ensureReasoningState(
  states: Map<string, PendingReasoningState>,
  reasoningId: string
): PendingReasoningState {
  const existingState = states.get(reasoningId);

  if (existingState !== undefined) {
    return existingState;
  }

  const nextState: PendingReasoningState = {
    messageStarted: false,
    messageId: reasoningId,
    started: false,
  };
  states.set(reasoningId, nextState);
  return nextState;
}

/** Gets or lazily creates the {@link PendingTextState} for `messageId`. */
function ensureTextState(
  states: Map<string, PendingTextState>,
  messageId: string
): PendingTextState {
  const existingState = states.get(messageId);

  if (existingState !== undefined) {
    return existingState;
  }

  const nextState: PendingTextState = {
    ended: false,
    messageId,
    sawContent: false,
    started: false,
  };
  states.set(messageId, nextState);
  return nextState;
}

/**
 * Synthesizes closing AG-UI events for every substream still open when the
 * enclosing turn ends (`TEXT_MESSAGE_END`, `REASONING_MESSAGE_END`/`REASONING_END`,
 * `TOOL_CALL_END`), clearing all three state maps afterward.
 *
 * AG-UI child streams should never remain open after the enclosing turn
 * ends, even on failure paths where the canonical stream terminates before
 * an explicit `*.done` event arrives. The synthesized closes are anchored to
 * `terminalEvent` (cloned per event via `rawEvent`) so host debuggers can
 * distinguish adapter cleanup from genuine canonical events.
 */
function flushPendingAgUiSubstreams(
  reasoningStates: Map<string, PendingReasoningState>,
  textStates: Map<string, PendingTextState>,
  toolCallStates: Map<string, PendingToolCallState>,
  terminalEvent: Extract<TuvrenStreamEvent, { type: "turn.end" }>
): readonly AGUIEvent[] {
  const flushedEvents: AGUIEvent[] = [];
  const createTerminalRawEvent = (): TuvrenStreamEvent =>
    cloneTuvrenStreamEvent(terminalEvent);

  // AG-UI child streams should never remain open after the enclosing turn ends,
  // even on failure paths where the canonical stream terminates before an
  // explicit *.done event arrives. We anchor the synthesized closes to turn.end
  // so host debuggers can distinguish adapter cleanup from canonical events.
  for (const textState of textStates.values()) {
    if (!textState.started || textState.ended) {
      continue;
    }

    flushedEvents.push(
      validateAgUiEvent({
        messageId: textState.messageId,
        rawEvent: createTerminalRawEvent(),
        timestamp: terminalEvent.timestamp,
        type: EventType.TEXT_MESSAGE_END,
      })
    );
  }
  textStates.clear();

  for (const reasoningState of reasoningStates.values()) {
    if (!reasoningState.started) {
      continue;
    }

    if (reasoningState.messageStarted) {
      flushedEvents.push(
        validateAgUiEvent({
          messageId: reasoningState.messageId,
          rawEvent: createTerminalRawEvent(),
          timestamp: terminalEvent.timestamp,
          type: EventType.REASONING_MESSAGE_END,
        })
      );
    }

    flushedEvents.push(
      validateAgUiEvent({
        messageId: reasoningState.messageId,
        rawEvent: createTerminalRawEvent(),
        timestamp: terminalEvent.timestamp,
        type: EventType.REASONING_END,
      })
    );
  }
  reasoningStates.clear();

  for (const toolCallState of toolCallStates.values()) {
    if (!toolCallState.started) {
      continue;
    }

    flushedEvents.push(
      validateAgUiEvent({
        rawEvent: createTerminalRawEvent(),
        timestamp: terminalEvent.timestamp,
        toolCallId: toolCallState.callId,
        type: EventType.TOOL_CALL_END,
      })
    );
  }
  toolCallStates.clear();

  return flushedEvents;
}

/**
 * Coerces a value into the plain string AG-UI text fields expect: a string
 * passes through unchanged; anything else is JSON-serialized, falling back
 * to the literal `"null"` for values `JSON.stringify` returns `undefined`
 * for.
 */
function serializeAgUiTextValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  const serialized = JSON.stringify(value);
  return serialized ?? "null";
}

/**
 * Derives a distinct AG-UI message id for a reasoning substream from the
 * canonical assistant `messageId`, so reasoning and text substreams sharing
 * one canonical message never collide in AG-UI's flat message-id space.
 */
function toReasoningMessageId(messageId: string): string {
  return `${messageId}:reasoning`;
}

/**
 * @throws TuvrenRuntimeError with code `invalid_agui_event` when `event`
 *   fails `EventSchemas` validation — a defensive check that a mapping bug in
 *   this adapter never reaches consumers as a structurally invalid AG-UI
 *   event.
 */
function validateAgUiEvent(event: AGUIEvent): AGUIEvent {
  try {
    return EventSchemas.parse(event);
  } catch (error: unknown) {
    throw new TuvrenRuntimeError("stream-agui emitted an invalid AG-UI event", {
      cause: error,
      code: "invalid_agui_event",
      details: event,
    });
  }
}

/**
 * Defensive exhaustiveness guard for the mapping switch: the `never`
 * parameter type means TypeScript already flags any unhandled
 * `TuvrenStreamEvent` variant at compile time; this throws if one somehow
 * reaches here at runtime (e.g. an event union widened at a version skew).
 *
 * @throws TuvrenRuntimeError with code `invalid_stream_adapter_state`, always.
 */
function throwUnreachableEvent(event: never): never {
  throw new TuvrenRuntimeError(
    "stream-agui received an unhandled stream event",
    {
      code: "invalid_stream_adapter_state",
      details: event,
    }
  );
}

/** Wraps an already-obtained iterator as a single-use `AsyncIterable` that always returns the same iterator. */
function createIteratorIterable<T>(
  iterator: AsyncIterator<T>
): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<T> {
      return iterator;
    },
  };
}
