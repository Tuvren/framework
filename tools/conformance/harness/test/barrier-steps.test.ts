import { expect, test } from "bun:test";

import type { ConformancePlanStep } from "../../plan-compiler/index.ts";
import { createBarrierSteps } from "../barrier-steps.ts";

const arm: ConformancePlanStep = {
  action: "barrier",
  barrierId: "writers",
  operation: "test.arm",
  participants: ["a", "b"],
  seam: "persistence",
  stepId: "arm",
};
const release: ConformancePlanStep = {
  action: "release",
  barrierId: "writers",
  operation: "test.release",
  participants: ["b", "a"],
  stepId: "release",
};
const receipt: ConformancePlanStep = {
  operation: "test.wait",
  stepId: "receipt",
};

test("barrier release requires every native receipt and preserves the plan's release ordering", () => {
  const barriers = createBarrierSteps();
  expect(barriers.input(arm, {})).toEqual({
    barrierId: "writers",
    participants: ["a", "b"],
    seam: "persistence",
  });
  barriers.observe(arm, {
    kind: "result",
    value: { result: { barrierId: "writers", seam: "persistence" } },
  });
  barriers.started("a", "handle-a");
  barriers.started("b", "handle-b");
  barriers.observe(receipt, {
    kind: "result",
    value: {
      result: {
        barrierId: "writers",
        operationHandle: "handle-a",
        seam: "persistence",
      },
    },
  });
  expect(() => barriers.input(release, {})).toThrow(
    "every implementation entry receipt"
  );
  barriers.observe(receipt, {
    kind: "result",
    value: {
      result: {
        barrierId: "another",
        operationHandle: "handle-b",
        seam: "persistence",
      },
    },
  });
  expect(() => barriers.input(release, {})).toThrow(
    "every implementation entry receipt"
  );
  barriers.observe(receipt, {
    kind: "result",
    value: {
      result: {
        barrierId: "writers",
        operationHandle: "handle-b",
        seam: "persistence",
      },
    },
  });
  expect(barriers.input(release, {})).toEqual({
    barrierId: "writers",
    operationHandles: ["handle-b", "handle-a"],
  });
  expect(barriers.input({ ...release, participants: ["b"] }, {})).toEqual({
    barrierId: "writers",
    operationHandles: ["handle-b"],
  });
});

test("barrier requires its arming acknowledgement to match before starting participants", () => {
  const barriers = createBarrierSteps();
  barriers.input(arm, {});
  expect(() => {
    barriers.observe(arm, {
      kind: "result",
      value: { result: { barrierId: "wrong", seam: "persistence" } },
    });
  }).toThrow("arming acknowledgement");
});
