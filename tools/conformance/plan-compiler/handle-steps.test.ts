import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { loadConformancePlan } from "./index.ts";

const start = {
  stepId: "start",
  action: "start",
  operation: "probe",
  arguments: {},
  handleCapture: "pending",
};
const plan = (steps: unknown[]) => ({
  packetId: "probe",
  planId: "probe",
  planVersion: "0.1.0",
  applicability: { capabilities: ["probe"] },
  checks: [
    {
      checkId: "probe",
      operation: "probe",
      assertions: [
        { kind: "resultField", field: "$.trace.done.result", present: true },
      ],
      steps,
    },
  ],
});

test.each(["capture", "assertions", "inspectState"])(
  "compiler rejects %s on start and cancel",
  async (field) => {
    const directory = await mkdtemp(path.join(tmpdir(), "handle-shape-"));
    const file = path.join(directory, "plan.json");
    try {
      for (const action of ["start", "cancel"]) {
        const values: Record<string, unknown> = {
          capture: [{ name: "receipt", path: "result" }],
          assertions: [{ kind: "resultField", field: "$", present: true }],
          inspectState: {},
        };
        const value = values[field];
        await writeFile(
          file,
          JSON.stringify(
            plan([
              {
                stepId: "probe",
                action,
                operation: "probe",
                arguments: {},
                [field]: value,
              },
            ])
          )
        );
        await expect(loadConformancePlan(file)).rejects.toThrow();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
);

test("compiler rejects cancellation without a prior matching gated entry receipt", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "handle-order-"));
  const file = path.join(directory, "plan.json");
  try {
    await writeFile(
      file,
      JSON.stringify(
        plan([
          start,
          {
            stepId: "cancel",
            action: "cancel",
            operation: "probe",
            arguments: {
              operationHandle: { $ref: "capture.pending" },
              reason: "stop",
            },
          },
        ])
      )
    );
    await expect(loadConformancePlan(file)).rejects.toThrow("entry receipt");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("compiler accepts cancellation after its gated entry and rejects wrong or released receipts", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "handle-cancel-gate-"));
  const file = path.join(directory, "plan.json");
  try {
    const arm = {
      stepId: "gate",
      action: "barrier",
      operation: "kernel.barrier.arm",
      arguments: {},
      barrierId: "gate",
      seam: "kernel.persistence.before-transact",
      participants: ["start", "other"],
    };
    const other = { ...start, stepId: "other", handleCapture: "other" };
    const receipt = {
      stepId: "entry",
      operation: "kernel.barrier.wait",
      arguments: {
        barrierId: "gate",
        operationHandle: { $ref: "capture.pending" },
        timeoutMs: 1000,
      },
    };
    const cancel = {
      stepId: "cancel",
      action: "cancel",
      operation: "probe",
      arguments: {
        operationHandle: { $ref: "capture.pending" },
        reason: "stop",
      },
    };
    const steps = [arm, start, other, receipt, cancel];
    await writeFile(file, JSON.stringify(plan(steps)));
    await expect(loadConformancePlan(file)).resolves.toBeDefined();
    await writeFile(
      file,
      JSON.stringify(
        plan([
          arm,
          start,
          other,
          {
            ...receipt,
            arguments: {
              ...receipt.arguments,
              operationHandle: { $ref: "capture.other" },
            },
          },
          cancel,
        ])
      )
    );
    await expect(loadConformancePlan(file)).rejects.toThrow("entry receipt");
    await writeFile(
      file,
      JSON.stringify(
        plan([
          arm,
          start,
          other,
          receipt,
          {
            stepId: "release",
            action: "release",
            operation: "kernel.barrier.release",
            arguments: {},
            barrierId: "gate",
          },
          cancel,
        ])
      )
    );
    await expect(loadConformancePlan(file)).rejects.toThrow("entry receipt");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("process selectors are accepted on owned actions and rejected on handle-routed actions", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "process-routing-"));
  const file = path.join(directory, "plan.json");
  try {
    const spawn = {
      stepId: "spawn",
      action: "spawn",
      operation: "kernel.process.spawn",
      process: "second",
    };
    const open = {
      stepId: "open",
      action: "openInstance",
      operation: "kernel.instance.open",
      process: "second",
      arguments: {},
    };
    await writeFile(file, JSON.stringify(plan([spawn, open])));
    await expect(loadConformancePlan(file)).resolves.toBeDefined();
    const routedSteps = {
      await: {
        arguments: {
          operationHandle: { $ref: "capture.pending" },
          reason: "stop",
        },
      },
      cancel: {
        arguments: {
          operationHandle: { $ref: "capture.pending" },
          reason: "stop",
        },
      },
      barrier: { barrierId: "gate", seam: "seam", participants: ["a", "b"] },
      release: { barrierId: "gate" },
      collect: { participants: ["a", "b"] },
      subscribe: {},
      pull: {},
    };
    for (const [action, properties] of Object.entries(routedSteps)) {
      const step = { action, ...properties };
      await writeFile(
        file,
        JSON.stringify(
          plan([
            spawn,
            open,
            start,
            { stepId: "bad", operation: "probe", process: "second", ...step },
          ])
        )
      );
      await expect(loadConformancePlan(file), action).rejects.toThrow();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a named process must be spawned exactly once before it is selected", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "process-order-"));
  const file = path.join(directory, "plan.json");
  try {
    const spawn = {
      stepId: "spawn",
      action: "spawn",
      operation: "kernel.process.spawn",
      process: "other",
    };
    const use = {
      stepId: "open",
      action: "openInstance",
      operation: "kernel.instance.open",
      process: "other",
      arguments: {},
    };
    for (const steps of [
      [use],
      [use, spawn],
      [spawn, { ...spawn, stepId: "again" }],
      [{ ...spawn, process: "primary" }],
    ]) {
      await writeFile(file, JSON.stringify(plan(steps)));
      await expect(loadConformancePlan(file)).rejects.toThrow();
    }
    await writeFile(file, JSON.stringify(plan([spawn, use])));
    await expect(loadConformancePlan(file)).resolves.toBeDefined();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the compiler rejects collection of sequential contenders", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "collect-order-"));
  const file = path.join(directory, "plan.json");
  try {
    const awaitStep = {
      stepId: "done",
      action: "await",
      operation: "probe",
      arguments: { operationHandle: { $ref: "capture.pending" } },
    };
    const collect = {
      stepId: "collect",
      action: "collect",
      operation: "kernel.harness.collect",
      participants: ["done"],
    };
    await writeFile(file, JSON.stringify(plan([start, awaitStep, collect])));
    await expect(loadConformancePlan(file)).rejects.toThrow("entry receipts");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
