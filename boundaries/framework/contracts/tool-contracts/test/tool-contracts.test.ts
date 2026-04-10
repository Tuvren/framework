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
import { frameworkContractFixtures } from "../../../../../tests/fixtures/framework-contract-fixtures.js";
import {
  assertApprovalRequest,
  assertApprovalResponse,
  assertApprovalResponseForRequest,
  assertKrakenToolDefinition,
  isApprovalRequest,
  isApprovalResponse,
  isApprovalResponseForRequest,
  isKrakenToolDefinition,
} from "../src/index.ts";

describe("tool-contracts", () => {
  test("re-exports tool and approval contracts from the shared runtime anchor", () => {
    expect(isApprovalRequest(frameworkContractFixtures.approvalRequest)).toBe(
      true
    );
    expect(
      isApprovalResponse({ decisions: [{ callId: "call-1", type: "approve" }] })
    ).toBe(true);
    expect(
      isKrakenToolDefinition(frameworkContractFixtures.toolDefinition)
    ).toBe(true);
    expect(() =>
      assertApprovalRequest(frameworkContractFixtures.approvalRequest)
    ).not.toThrow();
    expect(() =>
      assertApprovalResponse({
        decisions: [{ callId: "call-1", type: "approve" }],
      })
    ).not.toThrow();
    expect(
      isApprovalResponseForRequest(
        { decisions: [{ callId: "call_2", type: "approve" }] },
        frameworkContractFixtures.approvalRequest
      )
    ).toBe(true);
    expect(() =>
      assertApprovalResponseForRequest(
        { decisions: [{ callId: "call_2", type: "approve" }] },
        frameworkContractFixtures.approvalRequest
      )
    ).not.toThrow();
    expect(() =>
      assertKrakenToolDefinition(frameworkContractFixtures.toolDefinition)
    ).not.toThrow();
  });
});
