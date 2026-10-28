import { expect, test } from "bun:test";
import {
  chmod,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { parseOperationCatalog } from "../../plan-compiler/certification-rules.ts";
import { loadConformancePlan } from "../../plan-compiler/index.ts";
import { readAdapterManifest } from "../run-plans.ts";
import { runScheduledChecks } from "../run.ts";

test.each(["a_first", "b_first"])(
  "postgres shared writer race %s records both processes and receipts",
  async (order) => {
    const manifest = await readAdapterManifest(
      "typescript/kernel/conformance-adapter/adapter-postgres.json"
    );
    const plan = await loadConformancePlan(
      "spec/conformance/kernel/plans/kernel-shared-writer-syscall.json"
    );
    plan.catalog = parseOperationCatalog(
      JSON.parse(
        await readFile("spec/conformance/kernel/operations.json", "utf8")
      ),
      "kernel catalog"
    );
    const original = plan.checks.find(({ check }) =>
      check.checkId.endsWith(order)
    );
    if (original === undefined) {
      throw new Error("missing writer check");
    }
    const check = structuredClone(original.check);
    const [entry] = await runScheduledChecks(
      manifest,
      [{ plan, compiledCheck: { ...original, check }, index: 0 }],
      1,
      () => "replay",
      true
    );
    expect(
      entry?.checkResult.status,
      JSON.stringify({
        assertions: entry?.checkResult.assertionResults,
        failure: {
          classification: entry?.checkResult.failure?.classification,
          observation: entry?.checkResult.failure?.observation,
        },
      })
    ).toBe("pass");
    const details = entry?.checkResult.details;
    expect(details?.adapterErrors).toBeDefined();
    expect(details?.processes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "primary",
          pid: expect.any(Number),
          exit: { code: 0, signal: null },
          stderrTail: expect.any(String),
          epochs: expect.any(Array),
        }),
        expect.objectContaining({
          name: "second",
          pid: expect.any(Number),
          exit: { code: 0, signal: null },
          stderrTail: expect.any(String),
          epochs: expect.any(Array),
        }),
      ])
    );
    if (!Array.isArray(details?.processes)) {
      throw new Error("missing process evidence");
    }
    expect(
      new Set(details.processes.map((entry: { pid: number }) => entry.pid)).size
    ).toBe(2);
    const schedule = details?.schedule;
    if (!Array.isArray(schedule)) {
      throw new Error("missing schedule");
    }
    expect(schedule).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stepId: "firstReceipt",
          process: "primary",
          receipt: expect.objectContaining({
            barrierId: "writers",
            seam: "kernel.persistence.before-transact",
            operationHandle: expect.any(String),
          }),
        }),
        expect.objectContaining({
          stepId: "secondReceipt",
          process: "second",
          receipt: expect.objectContaining({
            barrierId: "writers",
            seam: "kernel.persistence.before-transact",
            operationHandle: expect.any(String),
          }),
        }),
        expect.objectContaining({
          stepId: "release",
          participants:
            order === "a_first"
              ? ["firstStart", "secondStart"]
              : ["secondStart", "firstStart"],
          input: expect.objectContaining({
            operationHandles: expect.any(Array),
          }),
        }),
      ])
    );
  },
  60_000
);

test("non-certification multi-process summaries omit winner-dependent diagnostics", async () => {
  const manifest = await readAdapterManifest(
    "typescript/kernel/conformance-adapter/adapter-postgres.json"
  );
  const plan = await loadConformancePlan(
    "spec/conformance/kernel/plans/kernel-shared-writer-syscall.json"
  );
  plan.catalog = parseOperationCatalog(
    JSON.parse(
      await readFile("spec/conformance/kernel/operations.json", "utf8")
    ),
    "kernel catalog"
  );
  const compiledCheck = plan.checks[0];
  if (compiledCheck === undefined) {
    throw new Error("missing writer check");
  }
  const [entry] = await runScheduledChecks(
    manifest,
    [{ plan, compiledCheck, index: 0 }],
    1,
    () => "replay",
    false
  );
  expect(entry?.checkResult.status).toBe("pass");
  expect(entry?.checkResult.details?.adapterErrors).toBeUndefined();
}, 60_000);

test("postgres clock skew uses the server clock for both preemption decisions", async () => {
  const manifest = await readAdapterManifest(
    "typescript/kernel/conformance-adapter/adapter-postgres.json"
  );
  const plan = await loadConformancePlan(
    "spec/conformance/kernel/plans/kernel-clock-skew-syscall.json"
  );
  plan.catalog = parseOperationCatalog(
    JSON.parse(
      await readFile("spec/conformance/kernel/operations.json", "utf8")
    ),
    "kernel catalog"
  );
  const compiledCheck = plan.checks[0];
  if (compiledCheck === undefined) {
    throw new Error("missing clock skew check");
  }
  const [entry] = await runScheduledChecks(
    manifest,
    [{ plan, compiledCheck, index: 0 }],
    1,
    () => "replay",
    true
  );
  expect(
    entry?.checkResult.status,
    JSON.stringify(entry?.checkResult.assertionResults)
  ).toBe("pass");
}, 60_000);

test("an unconstrained outcome schema cannot admit an unexpected native error", async () => {
  const manifest = await readAdapterManifest(
    "typescript/kernel/conformance-adapter/adapter-postgres.json"
  );
  const plan = await loadConformancePlan(
    "spec/conformance/kernel/plans/kernel-clock-skew-syscall.json"
  );
  plan.catalog = parseOperationCatalog(
    JSON.parse(
      await readFile("spec/conformance/kernel/operations.json", "utf8")
    ),
    "kernel catalog"
  );
  plan.fixtures = new Map([
    ["errors", { expected: { liveLeaseErrorOutcome: true } }],
  ]);
  const compiledCheck = plan.checks[0];
  if (compiledCheck === undefined) {
    throw new Error("missing clock skew check");
  }
  const [entry] = await runScheduledChecks(
    manifest,
    [{ plan, compiledCheck, index: 0 }],
    1,
    () => "replay",
    false
  );
  expect(entry?.checkResult.status).toBe("fail");
  expect(entry?.checkResult.assertionResults).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        status: "fail",
        message: expect.stringContaining("has no adapterError assertion"),
      }),
    ])
  );
}, 60_000);

test("a restarted PostgreSQL process restores the server and worker clock sources", async () => {
  const manifest = await readAdapterManifest(
    "typescript/kernel/conformance-adapter/adapter-postgres.json"
  );
  const plan = await loadConformancePlan(
    "spec/conformance/kernel/plans/kernel-clock-skew-syscall.json"
  );
  plan.catalog = parseOperationCatalog(
    JSON.parse(
      await readFile("spec/conformance/kernel/operations.json", "utf8")
    ),
    "kernel catalog"
  );
  const original = plan.checks[0];
  if (original === undefined) {
    throw new Error("missing clock skew check");
  }
  const check = structuredClone(original.check);
  const steps = check.steps;
  if (steps === undefined) {
    throw new Error("missing clock skew steps");
  }
  steps.splice(
    steps.findIndex((step) => step.stepId === "livePreempt"),
    0,
    {
      stepId: "restart",
      action: "restart",
      operation: "kernel.process.restart",
      arguments: {},
    },
    {
      stepId: "reopen",
      action: "openInstance",
      operation: "kernel.instance.open",
      arguments: {},
    }
  );
  const [entry] = await runScheduledChecks(
    manifest,
    [{ plan, compiledCheck: { ...original, check }, index: 0 }],
    1,
    () => "replay",
    true
  );
  expect(
    entry?.checkResult.status,
    JSON.stringify(entry?.checkResult.assertionResults)
  ).toBe("pass");
  expect(entry?.checkResult.details?.processes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        name: "primary",
        epochs: expect.arrayContaining([
          expect.objectContaining({ epoch: 1 }),
          expect.objectContaining({ epoch: 2 }),
        ]),
      }),
    ])
  );
}, 60_000);

test("sequential writer contenders cannot produce shared-backend race evidence", async () => {
  const manifest = await readAdapterManifest(
    "typescript/kernel/conformance-adapter/adapter-postgres.json"
  );
  const plan = await loadConformancePlan(
    "spec/conformance/kernel/plans/kernel-shared-writer-syscall.json"
  );
  plan.catalog = parseOperationCatalog(
    JSON.parse(
      await readFile("spec/conformance/kernel/operations.json", "utf8")
    ),
    "kernel catalog"
  );
  const original = plan.checks[0];
  if (original === undefined) {
    throw new Error("missing writer race");
  }
  const check = structuredClone(original.check);
  const steps = check.steps;
  if (steps === undefined) {
    throw new Error("missing writer steps");
  }
  for (const id of ["secondReceipt", "secondStart"]) {
    const index = steps.findIndex((step) => step.stepId === id);
    const [step] = steps.splice(index, 1);
    if (step === undefined) {
      throw new Error(`missing ${id}`);
    }
    const awaitFirst = steps.findIndex(
      (candidate) => candidate.stepId === "firstOutcome"
    );
    steps.splice(awaitFirst + 1, 0, step);
  }
  const [entry] = await runScheduledChecks(
    manifest,
    [{ plan, compiledCheck: { ...original, check }, index: 0 }],
    1,
    () => "replay",
    true
  );
  expect(entry?.checkResult).toMatchObject({
    status: "fail",
    failure: { classification: "verification" },
  });
}, 60_000);

test("a process exit assertion reads the named secondary supervisor epoch", async () => {
  const manifest = await readAdapterManifest(
    "typescript/kernel/conformance-adapter/adapter-postgres.json"
  );
  const plan = await loadConformancePlan(
    "spec/conformance/kernel/plans/kernel-shared-writer-syscall.json"
  );
  plan.catalog = parseOperationCatalog(
    JSON.parse(
      await readFile("spec/conformance/kernel/operations.json", "utf8")
    ),
    "kernel catalog"
  );
  const original = plan.checks[0];
  if (original?.check.steps === undefined) {
    throw new Error("missing writer steps");
  }
  const check = structuredClone(original.check);
  const steps = check.steps;
  if (steps === undefined) {
    throw new Error("missing cloned steps");
  }
  const index = steps.findIndex((step) => step.stepId === "head");
  steps.splice(index, 0, {
    stepId: "killSecond",
    action: "kill",
    process: "second",
    operation: "kernel.process.kill",
    arguments: {},
    assertions: [
      { kind: "processExit", process: "second", epoch: 1, signal: "SIGKILL" },
    ],
  });
  const [entry] = await runScheduledChecks(
    manifest,
    [{ plan, compiledCheck: { ...original, check }, index: 0 }],
    1,
    () => "replay",
    true
  );
  expect(
    entry?.checkResult.status,
    JSON.stringify(entry?.checkResult.assertionResults)
  ).toBe("pass");
  expect(entry?.checkResult.details?.processes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        name: "second",
        exit: { code: null, signal: "SIGKILL" },
      }),
    ])
  );
}, 60_000);

test("barrier and collect follow their participants after the primary process exits", async () => {
  const manifest = await readAdapterManifest(
    "typescript/kernel/conformance-adapter/adapter-postgres.json"
  );
  const plan = await loadConformancePlan(
    "spec/conformance/kernel/plans/kernel-shared-writer-syscall.json"
  );
  plan.catalog = parseOperationCatalog(
    JSON.parse(
      await readFile("spec/conformance/kernel/operations.json", "utf8")
    ),
    "kernel catalog"
  );
  const original = plan.checks[0];
  if (original === undefined) {
    throw new Error("missing writer race");
  }
  const check = structuredClone(original.check);
  const steps = check.steps;
  if (steps === undefined) {
    throw new Error("missing writer steps");
  }
  for (const id of ["firstStart", "heldHead", "head"]) {
    const step = steps.find((entry) => entry.stepId === id);
    if (step === undefined) {
      throw new Error(`missing ${id}`);
    }
    step.process = "second";
  }
  steps.splice(
    steps.findIndex((step) => step.action === "barrier"),
    0,
    {
      stepId: "killPrimary",
      action: "kill",
      operation: "kernel.process.kill",
      arguments: {},
    }
  );
  const [entry] = await runScheduledChecks(
    manifest,
    [{ plan, compiledCheck: { ...original, check }, index: 0 }],
    1,
    () => "replay",
    true
  );
  expect(
    entry?.checkResult.status,
    JSON.stringify(entry?.checkResult.assertionResults)
  ).toBe("pass");
}, 60_000);

test("a spawned process can create its own instance on the shared storage reference", async () => {
  const manifest = await readAdapterManifest(
    "typescript/kernel/conformance-adapter/adapter-postgres.json"
  );
  const plan = await loadConformancePlan(
    "spec/conformance/kernel/plans/kernel-shared-writer-syscall.json"
  );
  plan.catalog = parseOperationCatalog(
    JSON.parse(
      await readFile("spec/conformance/kernel/operations.json", "utf8")
    ),
    "kernel catalog"
  );
  const original = plan.checks[0];
  if (original === undefined) {
    throw new Error("missing writer race");
  }
  const check = structuredClone(original.check);
  const open = check.steps?.find((step) => step.stepId === "open");
  if (open === undefined) {
    throw new Error("missing instance step");
  }
  open.action = "createInstance";
  open.operation = "kernel.instance.create";
  const [entry] = await runScheduledChecks(
    manifest,
    [{ plan, compiledCheck: { ...original, check }, index: 0 }],
    1,
    () => "replay",
    true
  );
  expect(
    entry?.checkResult.status,
    JSON.stringify(entry?.checkResult.assertionResults)
  ).toBe("pass");
}, 60_000);

test("the runner routes identical opaque handle strings to their owning processes", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "shared-handles-"));
  try {
    const manifest = await readAdapterManifest(
      "typescript/kernel/conformance-adapter/adapter-postgres.json"
    );
    const executable = path.join(directory, "adapter.mjs");
    const host = new URL(
      "../../adapter-protocol/stdio-host.ts",
      import.meta.url
    ).href;
    const script = `#!/usr/bin/env bun
import { serveStdioAdapter } from ${JSON.stringify(host)};
let started;
await serveStdioAdapter({
  initialize: (packetId, planVersion) => ({ adapterId: ${JSON.stringify(manifest.adapterId)}, capabilities: ${JSON.stringify(manifest.capabilities)}, packetId, planVersion, protocolVersion: "0.2.0", profiles: [], storageKinds: ["postgres-database"] }),
  createInstance: async () => "instance",
  openInstance: async () => "instance",
  dispatch: async (operation, input) => {
    if (operation === "kernel.barrier.arm") return { kind: "result", value: { result: { barrierId: input.barrierId, seam: input.seam } } };
    if (operation === "kernel.barrier.wait") return { kind: "result", value: { result: { barrierId: input.barrierId, seam: "kernel.persistence.before-transact", operationHandle: input.operationHandle } } };
    if (operation === "kernel.barrier.release") return { kind: "result", value: { result: { barrierId: input.barrierId, operationHandles: input.operationHandles } } };
    throw new Error("unexpected operation");
  },
  startOperation: async (_operation, input) => { started = input; return { operationHandle: "same" }; },
  awaitOperation: async () => ({ kind: "result", value: { result: { branch: { branchId: "branch", threadId: "thread", headTurnNodeHash: started.turnNodeHash } } } }),
});
`;
    await writeFile(executable, script);
    await chmod(executable, 0o755);
    const planFile = path.join(directory, "plan.json");
    const handle = (name: string) => ({ $ref: `capture.${name}` });
    const steps = [
      {
        stepId: "spawn",
        action: "spawn",
        process: "second",
        operation: "kernel.process.spawn",
        arguments: {},
      },
      {
        stepId: "open",
        action: "openInstance",
        process: "second",
        operation: "kernel.instance.open",
        arguments: {},
      },
      {
        stepId: "arm",
        action: "barrier",
        operation: "kernel.barrier.arm",
        arguments: {},
        barrierId: "gate",
        seam: "kernel.persistence.before-transact",
        participants: ["a", "b"],
      },
      {
        stepId: "a",
        action: "start",
        operation: "kernel.branch.setHead",
        arguments: { branchId: "branch", turnNodeHash: "a".repeat(64) },
        handleCapture: "a",
      },
      {
        stepId: "b",
        action: "start",
        process: "second",
        operation: "kernel.branch.setHead",
        arguments: { branchId: "branch", turnNodeHash: "b".repeat(64) },
        handleCapture: "b",
      },
      {
        stepId: "receiptA",
        operation: "kernel.barrier.wait",
        arguments: {
          barrierId: "gate",
          operationHandle: handle("a"),
          timeoutMs: 1000,
        },
      },
      {
        stepId: "receiptB",
        operation: "kernel.barrier.wait",
        arguments: {
          barrierId: "gate",
          operationHandle: handle("b"),
          timeoutMs: 1000,
        },
      },
      {
        stepId: "release",
        action: "release",
        operation: "kernel.barrier.release",
        arguments: {},
        barrierId: "gate",
        participants: ["a", "b"],
      },
      {
        stepId: "awaitA",
        action: "await",
        operation: "kernel.branch.setHead",
        arguments: { operationHandle: handle("a") },
      },
      {
        stepId: "awaitB",
        action: "await",
        operation: "kernel.branch.setHead",
        arguments: { operationHandle: handle("b") },
      },
      {
        stepId: "collect",
        action: "collect",
        operation: "kernel.harness.collect",
        arguments: {},
        participants: ["awaitA", "awaitB"],
        assertions: [
          { kind: "resultField", field: "$.byKind.result", length: 2 },
        ],
      },
    ];
    await writeFile(
      planFile,
      JSON.stringify({
        planId: "test.handles",
        planVersion: "0.1.0",
        packetId: "tuvren.kernel.protocol",
        applicability: { capabilities: ["kernel.syscall"] },
        checks: [
          {
            checkId: "test.handles",
            operation: "kernel.branch.setHead",
            steps,
            assertions: [
              {
                kind: "resultField",
                field: "$.trace.collect.result.outcomes",
                length: 2,
              },
            ],
          },
        ],
      })
    );
    const plan = await loadConformancePlan(planFile);
    plan.catalog = parseOperationCatalog(
      JSON.parse(
        await readFile("spec/conformance/kernel/operations.json", "utf8")
      ),
      "kernel catalog"
    );
    const compiledCheck = plan.checks[0];
    if (compiledCheck === undefined) {
      throw new Error("missing handle check");
    }
    const [entry] = await runScheduledChecks(
      { ...manifest, executable, command: [executable], profiles: [] },
      [{ plan, compiledCheck, index: 0 }],
      1,
      () => "replay",
      true
    );
    expect(
      entry?.checkResult.status,
      JSON.stringify(entry?.checkResult.assertionResults)
    ).toBe("pass");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

test("a secondary process owns its fault receipt, death, and recovery epoch", async () => {
  const manifest = await readAdapterManifest(
    "typescript/kernel/conformance-adapter/adapter-postgres.json"
  );
  const plan = await loadConformancePlan(
    "spec/conformance/kernel/plans/kernel-crash-recovery-durable-syscall.json"
  );
  plan.catalog = parseOperationCatalog(
    JSON.parse(
      await readFile("spec/conformance/kernel/operations.json", "utf8")
    ),
    "kernel catalog"
  );
  const original = plan.checks[0];
  if (original === undefined) {
    throw new Error("missing crash check");
  }
  const check = structuredClone(original.check);
  const steps = check.steps;
  if (steps === undefined) {
    throw new Error("missing crash steps");
  }
  for (const step of steps) {
    if (
      !["await", "cancel", "barrier", "release", "collect"].includes(
        step.action ?? "dispatch"
      )
    ) {
      step.process = "second";
    }
    for (const assertion of step.assertions ?? []) {
      if (assertion.kind === "processExit") {
        assertion.process = "second";
      }
    }
  }
  for (const assertion of check.assertions) {
    if (assertion.kind === "processExit") {
      assertion.process = "second";
    }
  }
  steps.unshift(
    {
      stepId: "spawn",
      action: "spawn",
      process: "second",
      operation: "kernel.process.spawn",
      arguments: {},
    },
    {
      stepId: "attach",
      action: "openInstance",
      process: "second",
      operation: "kernel.instance.open",
      arguments: {},
    }
  );
  const [entry] = await runScheduledChecks(
    manifest,
    [{ plan, compiledCheck: { ...original, check }, index: 0 }],
    1,
    () => "replay",
    true
  );
  expect(
    entry?.checkResult.status,
    JSON.stringify(entry?.checkResult.assertionResults)
  ).toBe("pass");
  expect(entry?.checkResult.details?.fault).toMatchObject({
    receipts: [{ process: "second", processEpoch: 1 }],
  });
  expect(entry?.checkResult.details?.processes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        name: "second",
        epochs: expect.arrayContaining([
          expect.objectContaining({ epoch: 1, signal: "SIGKILL" }),
          expect.objectContaining({ epoch: 2 }),
        ]),
      }),
    ])
  );
}, 60_000);

test("postgres worker-clock mutant is activated and killed by the live-lease assertion", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "worker-clock-probe-"));
  try {
    const manifest = await readAdapterManifest(
      "typescript/kernel/conformance-adapter/adapter-postgres-mutant.json"
    );
    const wrapped = {
      ...manifest,
      executable: "/usr/bin/env",
      command: [
        "/usr/bin/env",
        "TUVREN_KERNEL_MUTANT=kernel.worker-clock-expiry",
        "bun",
        "tools/conformance/meta-conformance/activation-probe.ts",
        "--record",
        directory,
        "--operation",
        "kernel.mutant.activation",
        "--",
        ...manifest.command,
      ],
    };
    const plan = await loadConformancePlan(
      "spec/conformance/kernel/plans/kernel-clock-skew-syscall.json"
    );
    plan.catalog = parseOperationCatalog(
      JSON.parse(
        await readFile("spec/conformance/kernel/operations.json", "utf8")
      ),
      "kernel catalog"
    );
    const compiledCheck = plan.checks[0];
    if (compiledCheck === undefined) {
      throw new Error("missing clock skew check");
    }
    const [entry] = await runScheduledChecks(
      wrapped,
      [{ plan, compiledCheck, index: 0 }],
      1,
      () => "replay",
      true
    );
    expect(entry?.checkResult.status).toBe("fail");
    expect(entry?.checkResult.failure?.classification).toBe("implementation");
    expect(entry?.checkResult.assertionResults).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          assertionId: "kernel.syscall.clock_skew.preemption.2.schemaValid",
          status: "fail",
        }),
      ])
    );
    const [file] = await readdir(directory);
    if (file === undefined) {
      throw new Error("missing activation proof");
    }
    expect(
      JSON.parse(await readFile(path.join(directory, file), "utf8"))
    ).toMatchObject({
      reply: {
        result: {
          kind: "result",
          value: {
            result: {
              activation: {
                mutantId: "kernel.worker-clock-expiry",
                activated: true,
                activationCount: expect.any(Number),
              },
            },
          },
        },
      },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
