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

import { describe, expect, test } from "bun:test";
import type { ExecutionHandle } from "@tuvren/core/execution";
import type { SessionOutboundFrame } from "@tuvren/host-session";
import { createDuplexSessionBinding } from "@tuvren/host-session";
import { createRemoteClientSession } from "@tuvren/remote-session";

describe("remote-session package exports", () => {
  test("expose the session factory over a real duplex session binding", () => {
    const handle = {
      awaitResult: () => new Promise(() => undefined),
      cancel: () => undefined,
      events: () => ({
        [Symbol.asyncIterator]: () => ({
          next: () => new Promise<IteratorResult<unknown>>(() => undefined),
        }),
      }),
      resolveApproval: () => {
        throw new Error("not used");
      },
      status: () => ({ iterationCount: 0, phase: "running" as const }),
      steer: () => undefined,
    } as unknown as ExecutionHandle;

    const binding = createDuplexSessionBinding(handle, {
      sessionId: "smoke-remote-session",
    });

    const session = createRemoteClientSession({
      binding,
      disconnectGraceMs: 1000,
      dispatchTimeoutMs: 1000,
      replayBufferCapacity: 32,
    });

    expect(session.sessionId).toBe("smoke-remote-session");
    expect(session.isEnded()).toBe(false);
    expect(typeof session.attach).toBe("function");
    expect(typeof session.detach).toBe("function");
    expect(typeof session.close).toBe("function");
    expect(typeof session.dispatchInbound).toBe("function");

    const sent: SessionOutboundFrame[] = [];
    const { resumeStatus } = session.attach({
      send(frame: SessionOutboundFrame): void {
        sent.push(frame);
      },
    });

    expect(resumeStatus).toBe("none");

    session.close();
    expect(session.isEnded()).toBe(true);
  });
});
