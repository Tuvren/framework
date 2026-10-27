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
import { readFile } from "node:fs/promises";

import Ajv2020 from "ajv/dist/2020.js";

import {
  classifyConformanceReportStatus,
  readLivePlanChecks,
} from "../compatibility-report.ts";
import { PINNED_CERTIFICATION_EVIDENCE } from "../conformance/certification-schema-examples.ts";
import {
  assertConformanceEvidence,
  createAssertionResult,
  createCheckResult,
  createConformanceEvidenceSummary,
  deriveConformanceRunStatus,
  findCheckedInFailureViolations,
  toCheckedInCheckResult,
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

test("topology excludes handle checks for protocol 0.1 while retaining compatible checks", () => {
  const plan = JSON.stringify({
    applicability: { capabilities: ["kernel.barrier"] },
    checks: [
      { checkId: "plain", steps: [{ operation: "kernel.store.get" }] },
      { checkId: "handles", steps: [{ action: "start" }] },
      { checkId: "missing", capabilities: ["kernel.unavailable"] },
    ],
  });
  const capabilities = new Set(["kernel.barrier"]);
  expect(readLivePlanChecks(plan, capabilities, "0.1.0")).toEqual({
    allCheckIds: ["plain", "handles", "missing"],
    applicableCheckIds: ["plain"],
  });
  expect(
    readLivePlanChecks(plan, capabilities, "0.2.0").applicableCheckIds
  ).toEqual(["plain", "handles"]);
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

  test("checked-in check results keep only the failure classification and replay", () => {
    const failed = {
      ...createCheckResult("sample.check", [
        createAssertionResult("sample.check.1.resultField", false),
      ]),
      failure: {
        arguments: [{ input: { token: "sk-live-raw" }, operation: "open" }],
        classification: "implementation" as const,
        exit: { code: 1, signal: null },
        frameLog: [{ atMs: 0, direction: "receive", frame: "{}" }],
        observation: [{ outcome: { kind: "result", value: "sk-live-raw" } }],
        operands: [
          {
            actual: "sk-live-raw",
            expected: "redacted",
            expectedSource: "equals: plan literal",
            path: "$.result.token",
          },
        ],
        replay:
          "bun tools/conformance/harness/run.ts --adapter adapter.json --check sample.check",
        stderrTail: "sk-live-raw",
      },
    };
    const passed = createCheckResult("sample.pass", [
      createAssertionResult("sample.pass.1.resultField", true),
    ]);
    const evidence = {
      ...runnerEvidence(),
      checkResults: [failed, passed],
      status: "fail",
      summary: {
        applicableChecks: 2,
        failedChecks: 1,
        nonApplicableChecks: 0,
        passedChecks: 1,
        totalChecks: 2,
      },
    };

    expect(() => {
      assertConformanceEvidence(evidence, "runner evidence");
    }).not.toThrow();
    const checkedIn = {
      ...evidence,
      checkResults: evidence.checkResults.map(toCheckedInCheckResult),
    };
    expect(checkedIn.checkResults[0]?.failure).toEqual({
      classification: "implementation",
      replay: failed.failure.replay,
    });
    expect(checkedIn.checkResults[1]).toEqual(passed);
    expect(JSON.stringify(checkedIn)).not.toContain("sk-live-raw");
    expect(() => {
      assertConformanceEvidence(checkedIn, "checked-in evidence");
    }).not.toThrow();
    expect(findCheckedInFailureViolations(checkedIn.checkResults)).toEqual([]);
    expect(findCheckedInFailureViolations(evidence.checkResults)).toEqual([
      "checkResults[0].failure must keep only classification and replay; found arguments, exit, frameLog, observation, operands, stderrTail",
    ]);
  });

  test("checked-in failure checks accept evidence that predates failure artifacts", () => {
    expect(
      findCheckedInFailureViolations(runnerEvidence().checkResults)
    ).toEqual([]);
    expect(
      findCheckedInFailureViolations([
        {
          ...createCheckResult("sample.pass", [
            createAssertionResult("sample.pass.1.resultField", true),
          ]),
          failure: { classification: "specification_gap", replay: "" },
        },
      ])
    ).toEqual([
      "checkResults[0].failure.classification is not a known classification",
      "checkResults[0].failure.replay must be a non-empty string",
      "checkResults[0].failure is only allowed on a failed check",
    ]);
  });
});

test("compatibility summaries accept a catalogued unsupported check", async () => {
  const schema: unknown = JSON.parse(
    await readFile(
      new URL(
        "../../../reports/compatibility/compatibility-matrix.schema.json",
        import.meta.url
      ),
      "utf-8"
    )
  );
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
    throw new TypeError("invalid compatibility schema");
  }
  const ajv = new Ajv2020({ strict: false });
  ajv.addSchema(schema, "compatibility");
  for (const pointer of [
    "/properties/implementations/items/properties/results/items/properties/checkSummary",
    "/properties/interop/items/properties/checkSummary",
  ]) {
    const validate = ajv.compile({ $ref: `compatibility#${pointer}` });
    expect(
      validate({
        applicableChecks: 1,
        failedChecks: 0,
        nonApplicableChecks: 0,
        passedChecks: 0,
        totalChecks: 1,
        unsupportedChecks: 1,
      }),
      JSON.stringify(validate.errors)
    ).toBe(true);
  }
});

for (const [passedChecks, failedChecks, unsupportedChecks, expected] of [
  [1, 0, 1, "pass"],
  [0, 1, 1, "fail"],
  [0, 0, 1, "unsupported"],
] as const) {
  test(`run status ${expected} counts unsupported checks without demoting applicable checks`, () => {
    const checkResults = [
      ...Array.from({ length: passedChecks }, (_, index) =>
        createCheckResult(`pass-${index}`, [
          createAssertionResult("pass", true),
        ])
      ),
      ...Array.from({ length: failedChecks }, (_, index) =>
        createCheckResult(`fail-${index}`, [
          createAssertionResult("fail", false),
        ])
      ),
      ...Array.from({ length: unsupportedChecks }, (_, index) => ({
        assertionResults: [
          { assertionId: "unsupported", status: "unsupported" as const },
        ],
        checkId: `unsupported-${index}`,
        status: "unsupported" as const,
      })),
    ];
    const summary = {
      ...createConformanceEvidenceSummary(checkResults),
      applicableChecks: checkResults.length,
      nonApplicableChecks: 0,
    };
    expect(summary).toMatchObject({
      failedChecks,
      passedChecks,
      unsupportedChecks,
    });
    expect(deriveConformanceRunStatus(summary)).toBe(expected);
    expect(() => {
      assertConformanceEvidence(
        { ...runnerEvidence(), checkResults, status: expected, summary },
        "mixed evidence"
      );
    }).not.toThrow();
  });
}

test("compatibility classification keeps passing lanes with unsupported checks", () => {
  const runner = {
    adapterManifestPath: "adapter.json",
    implementationId: "sample",
    language: "typescript",
    project: "sample",
    reportLabel: "sample",
  };
  const evidence = {
    ...runnerEvidence(),
    status: "pass" as const,
    summary: {
      applicableChecks: 2,
      failedChecks: 0,
      nonApplicableChecks: 0,
      passedChecks: 1,
      totalChecks: 2,
      unsupportedChecks: 1,
    },
  };
  expect(
    classifyConformanceReportStatus(
      runner,
      evidence,
      "pass",
      new Set(["kernel.store"])
    )
  ).toBe("full_pass");
  expect(
    classifyConformanceReportStatus(
      runner,
      evidence,
      "pass",
      new Set(["kernel.tree"])
    )
  ).toBe("capability_subset_pass");
  expect(
    classifyConformanceReportStatus(
      runner,
      { ...evidence, summary: { ...evidence.summary, passedChecks: 0 } },
      "pass",
      new Set()
    )
  ).toBe("unsupported");
});
