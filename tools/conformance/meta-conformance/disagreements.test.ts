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
  compareObservations,
  normalizeObservation,
  stabilizeObservations,
  validateObservationSteps,
} from "./observation-comparison.ts";

const check = (checkId: string, status = "pass") => ({
  assertionResults: [],
  checkId,
  status,
});
const implementation = (
  implementationId: string,
  observations: unknown[],
  checks = [check("check")]
) => ({ checks, implementationId, observations });
const frame = (result: unknown, operation = "kernel.thread.get") => ({
  method: "dispatch",
  operation,
  outcome: { kind: "result", value: { result } },
});

const error = (code: string, message: string) => ({
  method: "dispatch",
  operation: "op",
  outcome: { error: { code, message }, kind: "error" },
});

const fencingStream = (first: string, second: string) => [
  frame({ fencingToken: first }),
  frame({ fencingToken: second }),
  frame({ fencingToken: first }),
];

test("compares N implementations and keeps unknown differences as disagreements", () => {
  const report = compareObservations([
    implementation("first", [[frame(1)]]),
    implementation("second", [[frame(2)]]),
    implementation("third", [[frame(3)]]),
  ]);
  expect(report).toHaveLength(3);
  expect(
    report.every(({ classification }) => classification === "disagreement")
  ).toBe(true);
  expect(report[0]?.path).toBe("$[0].outcome.value.result");
});

test("normalizes nested tagged maps by key while preserving ordinary array order", () => {
  const left = {
    $map: [
      [
        "b",
        {
          $map: [
            ["z", 1],
            ["a", 2],
          ],
        },
      ],
      ["a", 3],
    ],
  };
  const right = {
    $map: [
      ["a", 3],
      [
        "b",
        {
          $map: [
            ["a", 2],
            ["z", 1],
          ],
        },
      ],
    ],
  };
  expect(normalizeObservation(left)).toEqual(normalizeObservation(right));
  expect(
    compareObservations([
      implementation("a", [[left]]),
      implementation("b", [[right]]),
    ])
  ).toEqual([]);
  expect(
    compareObservations([
      implementation("a", [[[1, 2]]]),
      implementation("b", [[[2, 1]]]),
    ]).length
  ).toBeGreaterThan(0);
});

test("sanctions error prose only with equal codes and reports coverage separately", () => {
  const report = compareObservations([
    implementation(
      "a",
      [[error("same", "alpha")], []],
      [check("check"), check("only")]
    ),
    implementation("b", [[error("same", "beta")]]),
  ]);
  expect(report.find(({ kind }) => kind === "observations")).toMatchObject({
    citation: expect.stringContaining("ADR-0075"),
    classification: "sanctioned",
  });
  expect(report.find(({ kind }) => kind === "applicability")).toMatchObject({
    classification: "coverage",
  });
  expect(
    compareObservations([
      implementation("a", [[error("one", "alpha")]]),
      implementation("b", [[error("two", "beta")]]),
    ]).every(({ classification }) => classification === "disagreement")
  ).toBe(true);
});

test("checks each recorded dispatch and events operation against its plan", () => {
  const steps = [
    { operation: "kernel.store.put", stepId: "put" },
    { operation: "kernel.store.has", stepId: "has" },
  ];
  const observations = steps.flatMap(({ operation }) => [
    frame(true, operation),
    { method: "events", operation, outcome: [] },
  ]);
  expect(() =>
    validateObservationSteps("check", steps, observations)
  ).not.toThrow();
  expect(() =>
    validateObservationSteps("check", steps, [
      observations[2],
      observations[3],
      observations[0],
      observations[1],
    ])
  ).toThrow("put");
  expect(() =>
    validateObservationSteps("check", steps, observations.slice(0, 2))
  ).toThrow();
});

test("pseudonymizes fencing tokens deterministically and preserves references and rotations", () => {
  const left = stabilizeObservations(fencingStream("random-a", "random-b"));
  expect(left).toEqual(
    stabilizeObservations(fencingStream("other-a", "other-b"))
  );
  expect(left).not.toEqual(
    stabilizeObservations(fencingStream("same", "same"))
  );
});

test("equal fencing rotations compare equal across implementations", () => {
  expect(
    compareObservations([
      implementation("rust", [
        stabilizeObservations(fencingStream("r1", "r2")),
      ]),
      implementation("typescript", [
        stabilizeObservations(fencingStream("t1", "t2")),
      ]),
    ])
  ).toEqual([]);
});

test("fencing rotation versus reuse is an unsanctioned disagreement", () => {
  const differences = compareObservations([
    implementation("rust", [stabilizeObservations(fencingStream("r1", "r2"))]),
    implementation("typescript", [
      stabilizeObservations(fencingStream("t1", "t1")),
    ]),
  ]);
  expect(differences).toHaveLength(1);
  expect(differences[0]).toMatchObject({
    classification: "disagreement",
    path: "$[1].outcome.value.result.fencingToken",
  });
});

test("requires observed bootstrap ancestry before sanctioning node hashes", () => {
  const stream = (hash: string) => [
    frame({ rootTurnNodeHash: hash }, "kernel.thread.create"),
    frame(
      { hash: `${hash}-child`, previousTurnNodeHash: hash },
      "kernel.node.get"
    ),
  ];
  const report = compareObservations([
    implementation("a", [stream("root-a")]),
    implementation("b", [stream("root-b")]),
  ]);
  expect(
    report.every(({ classification }) => classification === "sanctioned")
  ).toBe(true);
  expect(
    compareObservations([
      implementation("a", [[frame({ hash: "other-a" }, "kernel.node.get")]]),
      implementation("b", [[frame({ hash: "other-b" }, "kernel.node.get")]]),
    ])[0]?.classification
  ).toBe("disagreement");
});
