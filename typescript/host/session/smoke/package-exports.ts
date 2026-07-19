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
import {
  createDuplexSessionBinding,
  SESSION_REJECTION_CODE_CAPABILITY_RESULT_STALE,
  SESSION_REJECTION_CODE_SESSION_FRAME_INVALID,
  SESSION_REJECTION_CODE_SESSION_FRAME_WRONG_STATE,
} from "@tuvren/host-session";

describe("host-session package exports", () => {
  test("expose the binding factory and rejection code constants", () => {
    const handle = {
      awaitResult: () => Promise.reject(new Error("not used")),
      cancel: () => undefined,
      events: () => ({
        [Symbol.asyncIterator]: () => ({
          next: () =>
            Promise.resolve({ done: true as const, value: undefined }),
        }),
      }),
      resolveApproval: () => {
        throw new Error("not used");
      },
      status: () => ({ iterationCount: 0, phase: "running" as const }),
      steer: () => undefined,
    } as unknown as ExecutionHandle;

    const binding = createDuplexSessionBinding(handle, {
      sessionId: "smoke-session",
    });

    expect(binding.sessionId).toBe("smoke-session");
    expect(typeof binding.dispatchInbound).toBe("function");
    expect(binding.clientEndpoint.endpointId).toBe(
      "host-session:smoke-session"
    );
    expect(SESSION_REJECTION_CODE_SESSION_FRAME_INVALID).toBe(
      "session_frame_invalid"
    );
    expect(SESSION_REJECTION_CODE_SESSION_FRAME_WRONG_STATE).toBe(
      "session_frame_wrong_state"
    );
    expect(SESSION_REJECTION_CODE_CAPABILITY_RESULT_STALE).toBe(
      "capability_result_stale"
    );
  });
});
