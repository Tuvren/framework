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
import {
  frameworkContractFixtures,
  invalidFrameworkContractFixtures,
} from "../../../../../tests/fixtures/framework-contract-fixtures.js";
import {
  type AgentConfig,
  assertApprovalRequest,
  assertExecutionStatus,
  assertKrakenMessage,
  assertKrakenStreamEvent,
  assertKrakenToolDefinition,
  assertProviderStreamChunk,
  isApprovalRequest,
  isExecutionStatus,
  isKrakenMessage,
  isKrakenStreamEvent,
  isKrakenToolDefinition,
  isProviderStreamChunk,
  type KrakenRuntime,
} from "../src/index.ts";

describe("runtime-api contracts", () => {
  test("accepts the canonical framework fixtures", () => {
    expect(isKrakenMessage(frameworkContractFixtures.assistantMessage)).toBe(
      true
    );
    expect(isApprovalRequest(frameworkContractFixtures.approvalRequest)).toBe(
      true
    );
    expect(
      isProviderStreamChunk(frameworkContractFixtures.providerStreamChunk)
    ).toBe(true);
    expect(isKrakenStreamEvent(frameworkContractFixtures.streamEvent)).toBe(
      true
    );
    expect(
      isKrakenToolDefinition(frameworkContractFixtures.toolDefinition)
    ).toBe(true);
    expect(isExecutionStatus(frameworkContractFixtures.executionStatus)).toBe(
      true
    );

    expect(() =>
      assertKrakenMessage(frameworkContractFixtures.assistantMessage)
    ).not.toThrow();
    expect(() =>
      assertApprovalRequest(frameworkContractFixtures.approvalRequest)
    ).not.toThrow();
    expect(() =>
      assertProviderStreamChunk(frameworkContractFixtures.providerStreamChunk)
    ).not.toThrow();
    expect(() =>
      assertKrakenStreamEvent(frameworkContractFixtures.streamEvent)
    ).not.toThrow();
    expect(() =>
      assertKrakenToolDefinition(frameworkContractFixtures.toolDefinition)
    ).not.toThrow();
    expect(() =>
      assertExecutionStatus(frameworkContractFixtures.executionStatus)
    ).not.toThrow();
  });

  test("rejects malformed contract values", () => {
    expect(
      isKrakenMessage(invalidFrameworkContractFixtures.malformedMessage)
    ).toBe(false);
    expect(
      isApprovalRequest(
        invalidFrameworkContractFixtures.malformedApprovalRequest
      )
    ).toBe(false);
    expect(
      isProviderStreamChunk(
        invalidFrameworkContractFixtures.malformedProviderStreamChunk
      )
    ).toBe(false);
    expect(
      isKrakenStreamEvent(invalidFrameworkContractFixtures.malformedStreamEvent)
    ).toBe(false);
    expect(
      isKrakenToolDefinition(
        invalidFrameworkContractFixtures.malformedToolDefinition
      )
    ).toBe(false);
    expect(
      isExecutionStatus(
        invalidFrameworkContractFixtures.malformedExecutionStatus
      )
    ).toBe(false);
  });

  test("rejects event sources with a non-string workerId", () => {
    expect(
      isKrakenStreamEvent({
        source: { agent: "primary", workerId: 7 },
        timestamp: 1,
        type: "turn.end",
        turnId: "turn-1",
        status: "completed",
      })
    ).toBe(false);
  });

  test("exposes a host-facing type surface that composes with the shared fixtures", () => {
    const runtime = frameworkContractFixtures.runtime as KrakenRuntime;
    const config = frameworkContractFixtures.agentConfig satisfies AgentConfig;

    expect(typeof runtime.executeTurn).toBe("function");
    expect(config.name).toBe("primary");
    expect(config.tools?.[0]?.name).toBe("search");
  });
});
