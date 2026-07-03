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

// Ported from the retired @tuvren/runtime-api shim's `runtime-api.test.ts`
// (epic 87, M9.2). Only the tests that exercise real @tuvren/core guard
// behavior are ported; two classes of test were deliberately NOT ported
// (recorded in MIGRATION_INVENTORY.md, not authored here as new coverage):
//   - "exposes narrow runtime-api subpaths without changing contract
//     behavior" and "accepts file.done stream events through the focused
//     events surface" (subpath variant) asserted that the shim's OWN
//     `./events`, `./execution`, `./orchestration`, `./provider`, `./tools`
//     subpath barrels behaved identically to its root barrel — that is
//     shim-internal structural coverage that dies with the shim, not
//     coverage of @tuvren/core. The file.done assertion itself (a real
//     assertTuvrenStreamEvent behavior) is preserved below as a plain test.
//   - "exposes the orchestration contract surface through canonical
//     fixtures" and "exposes a host-facing type surface that composes with
//     the shared fixtures" exercised the local hand-written mock
//     (`frameworkContractFixtures.orchestrationRuntime` / `.runtime`), which
//     implements TuvrenRuntime/OrchestrationRuntime by hand for the test
//     harness — the assertions verify the mock does what its own code says,
//     not any real @tuvren/core logic, so they carry no product coverage.

import { describe, expect, test } from "bun:test";
import {
  assertTuvrenStreamEvent,
  isTuvrenStreamEvent,
} from "@tuvren/core/events";
import {
  assertContextManifest,
  assertExecutionStatus,
  isExecutionStatus,
} from "@tuvren/core/execution";
import { assertTuvrenMessage, isTuvrenMessage } from "@tuvren/core/messages";
import {
  assertProviderStreamChunk,
  assertTuvrenModelResponse,
  isProviderStreamChunk,
} from "@tuvren/core/provider";
import {
  assertApprovalRequest,
  assertTuvrenToolDefinition,
  isApprovalRequest,
  isTuvrenToolDefinition,
} from "@tuvren/core/tools";
import {
  frameworkContractFixtures,
  invalidFrameworkContractFixtures,
} from "./runtime-contract-guards-fixtures.js";

describe("runtime-contract-guards contracts", () => {
  test("accepts the canonical framework fixtures", () => {
    expect(isTuvrenMessage(frameworkContractFixtures.assistantMessage)).toBe(
      true
    );
    expect(isApprovalRequest(frameworkContractFixtures.approvalRequest)).toBe(
      true
    );
    expect(
      isProviderStreamChunk(frameworkContractFixtures.providerStreamChunk)
    ).toBe(true);
    expect(isTuvrenStreamEvent(frameworkContractFixtures.streamEvent)).toBe(
      true
    );
    expect(
      isTuvrenToolDefinition(frameworkContractFixtures.toolDefinition)
    ).toBe(true);
    expect(isExecutionStatus(frameworkContractFixtures.executionStatus)).toBe(
      true
    );
    expect(() =>
      assertContextManifest(frameworkContractFixtures.contextManifest)
    ).not.toThrow();

    expect(() =>
      assertTuvrenMessage(frameworkContractFixtures.assistantMessage)
    ).not.toThrow();
    expect(() =>
      assertApprovalRequest(frameworkContractFixtures.approvalRequest)
    ).not.toThrow();
    expect(() =>
      assertProviderStreamChunk(frameworkContractFixtures.providerStreamChunk)
    ).not.toThrow();
    expect(() =>
      assertTuvrenStreamEvent(frameworkContractFixtures.streamEvent)
    ).not.toThrow();
    expect(() =>
      assertTuvrenToolDefinition(frameworkContractFixtures.toolDefinition)
    ).not.toThrow();
    expect(() =>
      assertExecutionStatus(frameworkContractFixtures.executionStatus)
    ).not.toThrow();
    expect(() =>
      assertTuvrenModelResponse({
        finishReason: "length",
        parts: [{ text: "partial", type: "text" }],
        providerMetadata: { stop: "max_tokens" },
        usage: {
          inputTokens: 10,
          outputTokens: 5,
        },
      })
    ).not.toThrow();
  });

  test("accepts file.done stream events", () => {
    const streamEvent = {
      data: new Uint8Array([1, 2, 3]),
      filename: "report.csv",
      mediaType: "text/csv",
      messageId: "message-1",
      timestamp: 1,
      type: "file.done",
    } as const;

    expect(() => assertTuvrenStreamEvent(streamEvent)).not.toThrow();
  });

  test("rejects malformed contract values", () => {
    expect(
      isTuvrenMessage(invalidFrameworkContractFixtures.malformedMessage)
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
      isTuvrenStreamEvent(invalidFrameworkContractFixtures.malformedStreamEvent)
    ).toBe(false);
    expect(
      isTuvrenToolDefinition(
        invalidFrameworkContractFixtures.malformedToolDefinition
      )
    ).toBe(false);
    expect(
      isExecutionStatus(
        invalidFrameworkContractFixtures.malformedExecutionStatus
      )
    ).toBe(false);
    expect(() =>
      assertContextManifest(
        invalidFrameworkContractFixtures.malformedContextManifest
      )
    ).toThrow("must be a valid ContextManifest");
  });

  test("rejects provider chunks that omit required fields", () => {
    expect(isProviderStreamChunk({ type: "tool_call_start" })).toBe(false);
  });

  test("rejects provider chunks with empty provider tool identifiers", () => {
    expect(
      isProviderStreamChunk({
        name: "search",
        providerCallId: "",
        type: "tool_call_start",
      })
    ).toBe(false);

    expect(
      isProviderStreamChunk({
        input: {},
        name: "",
        providerCallId: "provider-call-1",
        type: "tool_call_done",
      })
    ).toBe(false);
  });
});
