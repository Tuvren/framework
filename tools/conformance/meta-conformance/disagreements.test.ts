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

import { compareObservations } from "./disagreements.ts";

const check = (checkId: string, status = "pass") => ({
  checkId,
  status,
  assertionResults: [],
});

test("reports every observation, outcome, and applicability disagreement without grading authority", () => {
  const report = compareObservations(
    [check("same"), check("observation"), check("outcome"), check("left-only")],
    [
      check("same"),
      check("observation"),
      check("outcome", "fail"),
      check("right-only"),
    ],
    [[{ result: 1 }], [{ result: { a: 1, b: 2 } }], [], []],
    [[{ result: 1 }], [{ result: { b: 2, a: 3 } }], [], []]
  );
  expect(report.map((entry) => entry.checkId)).toEqual([
    "left-only",
    "observation",
    "outcome",
    "right-only",
  ]);
  expect(
    report.find((entry) => entry.checkId === "observation")?.differences
  ).toEqual(["observations"]);
  expect(
    report.find((entry) => entry.checkId === "outcome")?.differences
  ).toEqual(["outcome"]);
});

test("ignores JSON object key order and retains observation array order", () => {
  expect(
    compareObservations(
      [check("same")],
      [check("same")],
      [[{ a: 1, b: 2 }]],
      [[{ b: 2, a: 1 }]]
    )
  ).toEqual([]);
  expect(
    compareObservations(
      [check("ordered")],
      [check("ordered")],
      [[[1, 2]]],
      [[[2, 1]]]
    )
  ).toHaveLength(1);
});
