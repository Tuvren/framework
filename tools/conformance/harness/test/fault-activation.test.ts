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

import { expect, test } from "bun:test";

import {
  controlConsumesInstance,
  controlInputProblem,
} from "../../plan-compiler/control-input.ts";
import { createFaultActivationTracker } from "../fault-activation.ts";

test("shared controls and fault activation use catalog metadata across ports", () => {
  const operation = {
    handles: { consumes: ["instance"] },
    input: {
      additionalProperties: false,
      properties: { instance: { type: "string" } },
      required: ["instance"],
      type: "object",
    },
    kind: "control",
    observation: {},
    operationId: "storage.pause.arm",
  } as const;
  expect(controlConsumesInstance(operation)).toBe(true);
  expect(
    controlInputProblem(operation, { instance: "owned-instance" })
  ).toBeUndefined();
  expect(controlInputProblem(operation, {})).toContain("instance");
  expect(controlConsumesInstance({ ...operation, kind: "syscall" })).toBe(
    false
  );
  const faults = createFaultActivationTracker();
  const token = "arming-1";
  const point = "storage-boundary";
  faults.arm(
    { mode: "throw", occurrence: 1, point, selector: {} },
    { kind: "result", value: { result: { token } } },
    "storage_interrupted"
  );
  expect(faults.isFaultOutcome("storage_interrupted")).toBe(true);
  expect(
    faults.observe({
      error: {
        code: "another_error",
        details: { point, token },
        message: "other",
      },
      kind: "error",
    })
  ).toBe(false);
  expect(faults.missing()).toEqual([token]);
  expect(
    faults.observe({
      error: {
        code: "storage_interrupted",
        details: { point, token },
        message: "injected",
      },
      kind: "error",
    })
  ).toBe(true);
  expect(faults.missing()).toEqual([]);
});

test("a blocked fault activates only after a matching receipt and forced death in the same epoch", () => {
  const faults = createFaultActivationTracker();
  faults.arm(
    { mode: "block", occurrence: 1, point: "before-commit", selector: {} },
    { kind: "result", value: { result: { token: "armed" } } },
    "storage_interrupted"
  );
  expect(faults.missing()).toEqual(["armed"]);
  expect(
    faults.receipt(
      { token: "other", phase: "before-commit", processEpoch: 3 },
      3
    )
  ).toBe(false);
  expect(
    faults.receipt({ token: "armed", phase: "wrong", processEpoch: 3 }, 3)
  ).toBe(false);
  expect(
    faults.receipt(
      { token: "armed", phase: "before-commit", processEpoch: 2 },
      3
    )
  ).toBe(false);
  expect(
    faults.receipt(
      { token: "armed", phase: "before-commit", processEpoch: 3 },
      3
    )
  ).toBe(true);
  expect(faults.missing()).toEqual(["armed"]);
  faults.death(2, { code: null, signal: "SIGKILL" });
  faults.death(3, { code: 0, signal: null });
  expect(faults.missing()).toEqual(["armed"]);
  faults.death(3, { code: null, signal: "SIGKILL" });
  expect(faults.missing()).toEqual([]);
});
