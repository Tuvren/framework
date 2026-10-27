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
  operation: "kernel.barrier.wait",
  stepId: "receipt",
};

test("a barrier participant's start arguments pass through unchanged", () => {
  const barriers = createBarrierSteps({});
  barriers.input(arm, {});
  const argumentsValue = { branchId: "main", turnNodeHash: "head" };
  expect(
    barriers.input(
      { action: "start", operation: "kernel.branch.setHead", stepId: "a" },
      argumentsValue
    )
  ).toEqual(argumentsValue);
});

test("barrier release requires every native receipt and preserves the plan's release ordering", () => {
  const barriers = createBarrierSteps({
    first: "handle-a",
    second: "handle-b",
  });
  expect(barriers.input(arm, {})).toEqual({
    barrierId: "writers",
    participants: ["a", "b"],
    seam: "persistence",
  });
  barriers.observe(
    arm,
    {},
    {
      kind: "result",
      value: { result: { barrierId: "writers", seam: "persistence" } },
    }
  );
  barriers.started("a", "first");
  barriers.started("b", "second");
  barriers.observe(
    receipt,
    { operationHandle: "handle-a" },
    {
      kind: "result",
      value: {
        result: {
          barrierId: "writers",
          operationHandle: "handle-a",
          seam: "persistence",
        },
      },
    }
  );
  expect(() => barriers.input(release, {})).toThrow(
    "every implementation entry receipt"
  );
  barriers.observe(
    receipt,
    { operationHandle: "handle-b" },
    {
      kind: "result",
      value: {
        result: {
          barrierId: "another",
          operationHandle: "handle-b",
          seam: "persistence",
        },
      },
    }
  );
  expect(() => barriers.input(release, {})).toThrow(
    "every implementation entry receipt"
  );
  barriers.observe(
    receipt,
    { operationHandle: "handle-b" },
    {
      kind: "result",
      value: {
        result: {
          barrierId: "writers",
          operationHandle: "handle-b",
          seam: "persistence",
        },
      },
    }
  );
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
  const barriers = createBarrierSteps({});
  barriers.input(arm, {});
  expect(() => {
    barriers.observe(
      arm,
      {},
      {
        kind: "result",
        value: { result: { barrierId: "wrong", seam: "persistence" } },
      }
    );
  }).toThrow("arming acknowledgement");
});

test("only a wait response for the requested handle authorizes release", () => {
  const barriers = createBarrierSteps({
    first: "handle-a",
    second: "handle-b",
  });
  barriers.input(arm, {});
  barriers.started("a", "first");
  barriers.started("b", "second");
  const reply = (operationHandle: string) => ({
    kind: "result" as const,
    value: {
      result: { barrierId: "writers", operationHandle, seam: "persistence" },
    },
  });
  barriers.observe(
    { ...receipt, operation: "other.operation" },
    { operationHandle: "handle-a" },
    reply("handle-a")
  );
  barriers.observe(receipt, { operationHandle: "handle-a" }, reply("handle-b"));
  expect(() => barriers.input(release, {})).toThrow(
    "every implementation entry receipt"
  );
  barriers.observe(receipt, { operationHandle: "handle-a" }, reply("handle-a"));
  expect(() => barriers.input(release, {})).toThrow(
    "every implementation entry receipt"
  );
  barriers.observe(receipt, { operationHandle: "handle-b" }, reply("handle-b"));
  expect(barriers.input(release, {})).toEqual({
    barrierId: "writers",
    operationHandles: ["handle-b", "handle-a"],
  });
});
