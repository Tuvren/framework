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

import { loadConformancePlan } from "../../plan-compiler/index.ts";
import { evaluateAssertions } from "../assertion-engine/index.ts";
import {
  ArgumentResolutionError,
  createCaptureStore,
  recordStepCaptures,
  resolveStepArguments,
} from "../step-arguments.ts";

describe("step argument captures", () => {
  test("kernel clock branches use worker time when the descriptor omits shared-lease-clock", async () => {
    const plan = await loadConformancePlan(
      "spec/conformance/kernel/plans/kernel-protocol-core-syscall.json"
    );
    const checks = plan.checks.filter(({ check }) =>
      check.steps?.some((step) =>
        step.capture?.some(({ name }) => name === "sharedLeaseClock")
      )
    );
    expect(checks).toHaveLength(2);
    for (const { check } of checks) {
      const capture = check.steps
        ?.flatMap((step) => step.capture ?? [])
        .find(({ name }) => name === "sharedLeaseClock");
      const branchAssertions =
        check.steps
          ?.flatMap((step) => step.assertions ?? [])
          .filter(
            (assertion) => assertion.when?.path === "$.capture.sharedLeaseClock"
          ) ?? [];
      if (capture === undefined || branchAssertions.length !== 2) {
        throw new Error("missing shared-clock branches");
      }
      for (const [descriptor, timestamp, appliedIndex] of [
        [{ "thread.enumeration": true }, 200, 1],
        [{ "thread.enumeration": true, "shared-lease-clock": false }, 200, 1],
        [{ "thread.enumeration": true, "shared-lease-clock": true }, 100, 0],
      ] as const) {
        const store = createCaptureStore();
        recordStepCaptures([capture], { result: descriptor }, store);
        const fixture = {
          assertions: branchAssertions,
          checkId: check.checkId,
          operation: check.operation,
        };
        const evaluation = evaluateAssertions(fixture, {
          capture: store.values,
          result: { stagedResult: { timestamp } },
        });
        expect(evaluation.every(({ status }) => status === "pass")).toBe(true);
        expect(evaluation[appliedIndex]?.when).toBe("applied");
        const wrong = evaluateAssertions(fixture, {
          capture: store.values,
          result: { stagedResult: { timestamp: timestamp + 1 } },
        });
        expect(wrong[appliedIndex]?.status).toBe("fail");
      }
    }
  });
  test("uses an explicit default for an omitted optional capability", () => {
    for (const [descriptor, expected] of [
      [{ "thread.enumeration": true }, false],
      [{ "thread.enumeration": true, "shared-lease-clock": false }, false],
      [{ "thread.enumeration": true, "shared-lease-clock": true }, true],
    ] as const) {
      const store = createCaptureStore();
      recordStepCaptures(
        [{ name: "clock", path: "result.shared-lease-clock", default: false }],
        { result: descriptor },
        store
      );
      expect(store.values.clock).toBe(expected);
    }
  });

  test("a capture default does not hide a missing or invalid parent observation", () => {
    for (const result of [undefined, null, 5]) {
      const store = createCaptureStore();
      recordStepCaptures(
        [{ name: "clock", path: "result.shared-lease-clock", default: false }],
        { result },
        store
      );
      expect(Object.hasOwn(store.values, "clock")).toBe(false);
    }
  });
  test("stores a capture named __proto__ as an own data property", () => {
    const store = createCaptureStore();
    recordStepCaptures(
      [{ name: "__proto__", path: "result.value" }],
      { result: { value: { polluted: true } } },
      store
    );

    expect(Object.getPrototypeOf(store.values)).toBeNull();
    expect(Object.hasOwn(store.values, "__proto__")).toBe(true);
    expect(
      resolveStepArguments(
        { value: { $ref: "capture.__proto__" } },
        { capture: store.values, fixture: undefined, input: undefined }
      )
    ).toEqual({ value: { polluted: true } });
  });

  test("does not resolve inherited properties of the capture root", () => {
    const store = createCaptureStore();

    expect(() =>
      resolveStepArguments(
        { $ref: "capture.toString" },
        { capture: store.values, fixture: undefined, input: undefined }
      )
    ).toThrow(ArgumentResolutionError);
  });

  test("rejects a reused capture name even when the first capture was absent", () => {
    const store = createCaptureStore();
    recordStepCaptures(
      [{ name: "token", path: "result.absent" }],
      { result: { token: "first" } },
      store
    );

    expect(Object.hasOwn(store.values, "token")).toBe(false);
    expect(() => {
      recordStepCaptures(
        [{ name: "token", path: "result.token" }],
        { result: { token: "second" } },
        store
      );
    }).toThrow("capture token is already defined");
  });

  test("rejects a reused capture name within a single step", () => {
    const store = createCaptureStore();

    expect(() => {
      recordStepCaptures(
        [
          { name: "token", path: "result.absent" },
          { name: "token", path: "result.token" },
        ],
        { result: { token: "value" } },
        store
      );
    }).toThrow("capture token is already defined");
  });

  test("records an empty events array", () => {
    const store = createCaptureStore();
    recordStepCaptures(
      [{ name: "events", path: "events" }],
      { events: [] },
      store
    );

    expect(store.values.events).toEqual([]);
  });
});
