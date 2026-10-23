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

import { PINNED_CERTIFICATION_EVIDENCE } from "../conformance/certification-schema-examples.ts";
import {
  assertConformanceEvidence,
  createAssertionResult,
  createCheckResult,
} from "./conformance-contract.ts";

const SCHEMA_VIOLATION = /certification-evidence\.schema\.json/u;
const CERTIFICATE_COMPLETE_VIOLATION = /certificate\/complete/u;

const runnerEvidence = () => ({
  adapterId: "sample",
  boundary: "kernel",
  capabilities: ["kernel.store"],
  checkResults: [
    createCheckResult("sample.check", [
      createAssertionResult("sample.check.1.resultField", true),
    ]),
  ],
  implementationId: "sample",
  language: "typescript",
  nonApplicableCheckIds: [],
  status: "pass",
  suiteId: "tuvren.sample",
  suiteVersion: "0.1.0",
  summary: {
    applicableChecks: 1,
    failedChecks: 0,
    nonApplicableChecks: 0,
    passedChecks: 1,
    totalChecks: 1,
  },
});

describe("conformance evidence contract", () => {
  test("accepts runner evidence built by the contract helpers", () => {
    expect(() => {
      assertConformanceEvidence(runnerEvidence(), "runner evidence");
    }).not.toThrow();
  });

  test("accepts the pinned certification bundle", () => {
    expect(() => {
      assertConformanceEvidence(PINNED_CERTIFICATION_EVIDENCE, "bundle");
    }).not.toThrow();
  });

  test("rejects fields outside certification-evidence.schema.json", () => {
    expect(() => {
      assertConformanceEvidence(
        { ...runnerEvidence(), verdict: "pass" },
        "runner evidence"
      );
    }).toThrow(SCHEMA_VIOLATION);
    expect(() => {
      assertConformanceEvidence(
        {
          ...PINNED_CERTIFICATION_EVIDENCE,
          certificate: {
            complete: "yes",
            profile: "kernel.memory",
            status: "certified",
          },
        },
        "bundle"
      );
    }).toThrow(CERTIFICATE_COMPLETE_VIOLATION);
  });

  test("rejects a certified bundle without its certification fields", () => {
    const {
      digests: _digests,
      negativeControlRunId: _negativeControlRunId,
      ...withoutDigests
    } = PINNED_CERTIFICATION_EVIDENCE;

    expect(() => {
      assertConformanceEvidence(withoutDigests, "bundle");
    }).toThrow(SCHEMA_VIOLATION);
  });

  test("rejects a failure artifact on a passing check", () => {
    const evidence = runnerEvidence();
    const [checkResult] = evidence.checkResults;

    expect(() => {
      assertConformanceEvidence(
        {
          ...evidence,
          checkResults: [
            {
              ...checkResult,
              failure: { classification: "implementation", replay: "bun run" },
            },
          ],
        },
        "runner evidence"
      );
    }).toThrow(SCHEMA_VIOLATION);
  });
});
