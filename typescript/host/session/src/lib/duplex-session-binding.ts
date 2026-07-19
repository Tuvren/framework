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

import { TuvrenRuntimeError } from "@tuvren/core";
import type {
  AttachedClientEndpoint,
  ClientEndpointCapabilityAdvertisement,
  ClientInvocationEnvelope,
  ClientReportedResult,
} from "@tuvren/core/capabilities";
import type { ExecutionHandle, InputSignal } from "@tuvren/core/execution";
import type { ApprovalResponse } from "@tuvren/core/tools";
import type {
  SessionInboundFrame,
  SessionOutboundFrame,
  SessionRejectionCode,
  SessionRejectionFrame,
} from "./session-frame-shapes.js";

/**
 * Options accepted by {@link createDuplexSessionBinding}.
 *
 * @experimental
 */
export interface DuplexSessionBindingOptions {
  /** Capabilities the binding's {@link AttachedClientEndpoint} advertises. Defaults to `[]`. */
  advertisedCapabilities?: ClientEndpointCapabilityAdvertisement[];
  /** Stable non-secret client endpoint identifier. Defaults to `"host-session:" + sessionId`. */
  endpointId?: string;
  /** Fixed session identifier. Defaults to `crypto.randomUUID()`. */
  sessionId?: string;
}

/**
 * TypeScript binding surface for the `tuvren.framework.host-session`
 * authority packet (issue #99): bridges a single {@link ExecutionHandle}
 * (and any successor handle installed by `resolveApproval`) onto the duplex
 * session frame vocabulary declared in
 * `spec/host/session/typespec/main.tsp`.
 *
 * @experimental
 */
export interface DuplexSessionBinding {
  /** The client endpoint this binding wires into `AgentConfig.clientEndpoints`. */
  readonly clientEndpoint: AttachedClientEndpoint;
  /** The execution handle currently backing this binding (observability for tests/hosts). */
  currentHandle(): ExecutionHandle;
  /**
   * Routes an inbound frame. Fire-and-forget: accepts `unknown` so callers
   * can hand it raw decoded wire payloads directly. Structural or state
   * rejections surface as `session_rejection` frames on {@link outbound}
   * rather than throwing; only an unexpected non-`TuvrenRuntimeError` failure
   * from the underlying handle propagates to the caller.
   */
  dispatchInbound(frame: unknown): void;
  /**
   * The single-consumer outbound frame stream (mirrors
   * `ExecutionHandle.events()`). Throws if called more than once.
   */
  outbound(): AsyncIterable<SessionOutboundFrame>;
  /** The session identifier carried on every frame this binding produces or accepts. */
  readonly sessionId: string;
}

/** A pending `next()` call on the outbound queue, settled once a value, close, or failure arrives. */
interface OutboundQueueWaiter {
  reject(error: unknown): void;
  resolve(result: IteratorResult<SessionOutboundFrame>): void;
}

/**
 * Minimal single-consumer async queue backing {@link DuplexSessionBinding.outbound}.
 * Unlike the tee-fanout `AsyncBroadcastQueue` in `@tuvren/stream-core`
 * (which enforces a one-slot-per-branch capacity limit for fanout), this
 * queue only has one producer side and one consumer, so it buffers freely
 * and only needs push/close/fail plus a single async iterator.
 */
class DuplexSessionOutboundQueue
  implements AsyncIterable<SessionOutboundFrame>
{
  private closed = false;
  private failure: { error: unknown } | undefined;
  private readonly items: SessionOutboundFrame[] = [];
  private readonly waiters: OutboundQueueWaiter[] = [];

  push(value: SessionOutboundFrame): void {
    if (this.closed || this.failure !== undefined) {
      return;
    }

    const waiter = this.waiters.shift();
    if (waiter !== undefined) {
      waiter.resolve({ done: false, value });
      return;
    }

    this.items.push(value);
  }

  close(): void {
    if (this.closed || this.failure !== undefined) {
      return;
    }

    this.closed = true;
    this.onTerminal?.();
    while (this.waiters.length > 0) {
      this.waiters.shift()?.resolve({ done: true, value: undefined });
    }
  }

  /**
   * Invoked exactly once when the queue reaches any terminal state (close,
   * failure, or consumer-side early return).
   */
  onTerminal: (() => void) | undefined;

  fail(error: unknown): void {
    if (this.closed || this.failure !== undefined) {
      return;
    }

    this.failure = { error };
    this.onTerminal?.();
    while (this.waiters.length > 0) {
      this.waiters.shift()?.reject(error);
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<SessionOutboundFrame> {
    return {
      next: (): Promise<IteratorResult<SessionOutboundFrame>> => {
        const value = this.items.shift();
        if (value !== undefined) {
          return Promise.resolve({ done: false, value });
        }

        if (this.failure !== undefined) {
          return Promise.reject(this.failure.error);
        }

        if (this.closed) {
          return Promise.resolve({ done: true, value: undefined });
        }

        return new Promise<IteratorResult<SessionOutboundFrame>>(
          (resolve, reject) => {
            this.waiters.push({ reject, resolve });
          }
        );
      },
      return: (): Promise<IteratorResult<SessionOutboundFrame>> => {
        this.close();
        return Promise.resolve({ done: true, value: undefined });
      },
    };
  }
}

interface PendingClientCall {
  reject(error: unknown): void;
  resolve(result: ClientReportedResult): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function extractCorrelationId(raw: unknown): string {
  if (isRecord(raw) && isNonEmptyString(raw.correlationId)) {
    return raw.correlationId;
  }
  return "unknown";
}

type InboundValidationResult =
  | { ok: true; frame: SessionInboundFrame }
  | { ok: false; correlationId: string; message: string };

/**
 * Cheap TS-level structural validation for inbound frames: object shape,
 * `protocolVersion`, `sessionId`, `correlationId`, and kind-specific payload
 * presence with correct primitive structure. This is deliberately not a full
 * JSON-Schema validation — that runs in the conformance lane against the
 * generated schema artifacts, not here.
 */
function validateInboundFrame(
  raw: unknown,
  sessionId: string
): InboundValidationResult {
  const correlationId = extractCorrelationId(raw);

  if (!isRecord(raw)) {
    return {
      correlationId,
      message: "inbound frame must be an object",
      ok: false,
    };
  }

  if (raw.protocolVersion !== "1") {
    return {
      correlationId,
      message: 'inbound frame protocolVersion must be "1"',
      ok: false,
    };
  }

  if (raw.sessionId !== sessionId) {
    return {
      correlationId,
      message: "inbound frame sessionId does not match this session",
      ok: false,
    };
  }

  if (!isNonEmptyString(raw.correlationId)) {
    return {
      correlationId,
      message: "inbound frame correlationId must be a non-empty string",
      ok: false,
    };
  }

  switch (raw.kind) {
    case "client_result": {
      const result = raw.result;
      if (
        !(
          isRecord(result) &&
          isNonEmptyString(result.callId) &&
          isNonEmptyString(result.leaseToken) &&
          "content" in result
        )
      ) {
        return {
          correlationId,
          message:
            "client_result frame requires a result payload with callId, leaseToken, and content",
          ok: false,
        };
      }

      return {
        frame: {
          correlationId: raw.correlationId,
          kind: "client_result",
          protocolVersion: "1",
          result: result as unknown as ClientReportedResult,
          sessionId,
        },
        ok: true,
      };
    }
    case "approval_response": {
      const response = raw.response;
      if (
        !(isRecord(response) && Array.isArray(response.decisions)) ||
        response.decisions.length === 0
      ) {
        return {
          correlationId,
          message:
            "approval_response frame requires a response payload with a non-empty decisions array",
          ok: false,
        };
      }

      return {
        frame: {
          correlationId: raw.correlationId,
          kind: "approval_response",
          protocolVersion: "1",
          response: response as unknown as ApprovalResponse,
          sessionId,
        },
        ok: true,
      };
    }
    case "steer": {
      const signal = raw.signal;
      if (
        !(isRecord(signal) && Array.isArray(signal.parts)) ||
        signal.parts.length === 0
      ) {
        return {
          correlationId,
          message:
            "steer frame requires a signal payload with a non-empty parts array",
          ok: false,
        };
      }

      return {
        frame: {
          correlationId: raw.correlationId,
          kind: "steer",
          protocolVersion: "1",
          signal: signal as unknown as InputSignal,
          sessionId,
        },
        ok: true,
      };
    }
    case "cancel": {
      return {
        frame: {
          correlationId: raw.correlationId,
          kind: "cancel",
          protocolVersion: "1",
          sessionId,
        },
        ok: true,
      };
    }
    default: {
      return {
        correlationId,
        message: `inbound frame kind "${String(raw.kind)}" is not recognized`,
        ok: false,
      };
    }
  }
}

/**
 * Builds a duplex session binding over `handle` (KrakenFrameworkSpecification
 * §7, issue #99): merges `handle.events()` — and every successor handle
 * installed via `resolveApproval()` — into a single outbound frame stream,
 * and routes inbound frames to `steer`/`cancel`/`resolveApproval` or the
 * attached client endpoint's pending-call table.
 *
 * @experimental
 */
export function createDuplexSessionBinding(
  handle: ExecutionHandle,
  options: DuplexSessionBindingOptions = {}
): DuplexSessionBinding {
  const sessionId = options.sessionId ?? crypto.randomUUID();
  const advertisedCapabilities = options.advertisedCapabilities ?? [];
  const endpointId = options.endpointId ?? `host-session:${sessionId}`;

  const queue = new DuplexSessionOutboundQueue();
  const pendingClientCalls = new Map<string, PendingClientCall>();

  // A terminal close (including a cooperative cancel) settles every
  // outstanding client dispatch: the session can never deliver a
  // client_result once the outbound stream is gone, so leaving the promise
  // pending would leak it forever. The runtime's Client Endpoint Boundary
  // converts the rejection into an isError tool result.
  queue.onTerminal = () => {
    for (const [callId, pending] of pendingClientCalls) {
      pending.reject(
        new TuvrenRuntimeError(
          `duplex session closed with client dispatch "${callId}" still pending`,
          { code: "duplex_session_closed" }
        )
      );
    }
    pendingClientCalls.clear();
  };

  let current = handle;
  let outboundClaimed = false;

  function rejectionFrame(
    correlationId: string,
    code: SessionRejectionCode,
    message: string,
    details?: Record<string, unknown>
  ): SessionRejectionFrame {
    return {
      kind: "session_rejection",
      protocolVersion: "1",
      rejection:
        details === undefined
          ? { code, correlationId, message }
          : { code, correlationId, details, message },
      sessionId,
    };
  }

  function pushRuntimeErrorRejection(
    correlationId: string,
    error: unknown
  ): void {
    if (error instanceof TuvrenRuntimeError) {
      queue.push(
        rejectionFrame(
          correlationId,
          "session_frame_wrong_state",
          error.message,
          {
            runtimeErrorCode: error.code,
          }
        )
      );
      return;
    }

    throw error;
  }

  function bridgeCurrentHandle(bridgedHandle: ExecutionHandle): void {
    const drain = (async () => {
      try {
        for await (const event of bridgedHandle.events()) {
          queue.push({
            event,
            kind: "event",
            protocolVersion: "1",
            sessionId,
          });
        }
      } catch (error) {
        queue.fail(error);
        return;
      }

      // If `current` has already moved past this handle (a replacement was
      // installed by a concurrent approval_response while this handle's
      // stream was still draining), the replacement's own bridge owns queue
      // lifecycle now, so there is nothing left to do here.
      if (bridgedHandle !== current) {
        return;
      }

      // A handle's stream ending while still paused means a replacement may
      // still arrive via a future approval_response — leave the queue open
      // rather than closing it out from under that pending resolution.
      if (bridgedHandle.status().phase === "paused") {
        return;
      }

      queue.close();
    })();

    // Fire-and-forget: this task's only observable effects are the queue
    // pushes/close/fail above, so a caller never needs to await it directly.
    drain.catch(() => undefined);
  }

  bridgeCurrentHandle(current);

  const clientEndpoint: AttachedClientEndpoint = {
    advertisedCapabilities,
    dispatch(
      envelope: ClientInvocationEnvelope
    ): Promise<ClientReportedResult> {
      // callId uniqueness is a runtime invariant (each dispatch mints a fresh
      // call); guard defensively so a violation surfaces instead of silently
      // orphaning the first dispatch's promise.
      if (pendingClientCalls.has(envelope.callId)) {
        return Promise.reject(
          new TuvrenRuntimeError(
            `client dispatch for callId "${envelope.callId}" is already pending`,
            { code: "duplex_session_duplicate_call" }
          )
        );
      }

      queue.push({
        invocation: envelope,
        kind: "client_invocation",
        protocolVersion: "1",
        sessionId,
      });

      return new Promise<ClientReportedResult>((resolve, reject) => {
        pendingClientCalls.set(envelope.callId, { reject, resolve });
      });
    },
    endpointId,
  };

  function routeClientResult(
    frame: Extract<SessionInboundFrame, { kind: "client_result" }>
  ): void {
    const pending = pendingClientCalls.get(frame.result.callId);
    if (pending === undefined) {
      queue.push(
        rejectionFrame(
          frame.correlationId,
          "capability_result_stale",
          `no pending client dispatch for callId "${frame.result.callId}"`
        )
      );
      return;
    }

    pendingClientCalls.delete(frame.result.callId);
    pending.resolve(frame.result);
  }

  function routeApprovalResponse(
    frame: Extract<SessionInboundFrame, { kind: "approval_response" }>
  ): void {
    try {
      // The superseded handle's events() iterable is already exhausted when
      // resolveApproval succeeds (KrakenFrameworkSpecification §7.1: the old
      // handle's stream ends at the paused turn.end; the replacement produces
      // a fresh sequence), so re-bridging without .return() on the old
      // iterator cannot leak or duplicate events.
      const replacement = current.resolveApproval(frame.response);
      current = replacement;
      bridgeCurrentHandle(replacement);
    } catch (error) {
      pushRuntimeErrorRejection(frame.correlationId, error);
    }
  }

  function routeSteer(
    frame: Extract<SessionInboundFrame, { kind: "steer" }>
  ): void {
    try {
      current.steer(frame.signal);
    } catch (error) {
      pushRuntimeErrorRejection(frame.correlationId, error);
    }
  }

  function routeCancel(
    frame: Extract<SessionInboundFrame, { kind: "cancel" }>
  ): void {
    try {
      current.cancel();
    } catch (error) {
      pushRuntimeErrorRejection(frame.correlationId, error);
    }
  }

  function dispatchInbound(raw: unknown): void {
    const validated = validateInboundFrame(raw, sessionId);
    if (!validated.ok) {
      queue.push(
        rejectionFrame(
          validated.correlationId,
          "session_frame_invalid",
          validated.message
        )
      );
      return;
    }

    switch (validated.frame.kind) {
      case "client_result": {
        routeClientResult(validated.frame);
        return;
      }
      case "approval_response": {
        routeApprovalResponse(validated.frame);
        return;
      }
      case "steer": {
        routeSteer(validated.frame);
        return;
      }
      case "cancel": {
        routeCancel(validated.frame);
        return;
      }
      default: {
        return;
      }
    }
  }

  return {
    clientEndpoint,
    currentHandle(): ExecutionHandle {
      return current;
    },
    dispatchInbound,
    outbound(): AsyncIterable<SessionOutboundFrame> {
      if (outboundClaimed) {
        throw new TuvrenRuntimeError(
          "outbound() may only be called once per DuplexSessionBinding",
          { code: "duplex_session_outbound_already_claimed" }
        );
      }

      outboundClaimed = true;
      return queue;
    },
    sessionId,
  };
}
