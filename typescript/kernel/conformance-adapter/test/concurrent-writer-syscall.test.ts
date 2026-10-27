import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { readAdapterManifest } from "../../../../tools/conformance/harness/run-plans.ts";
import { loadConformancePlan } from "../../../../tools/conformance/plan-compiler/index.ts";
import { assertConformanceEvidence } from "../../../../tools/scripts/lib/conformance-contract.ts";

const planPath =
  "spec/conformance/kernel/plans/kernel-concurrent-writer-syscall.json";
const root = path.resolve(import.meta.dirname, "../../../..");

const runRace = async (serialized: boolean) => {
  const directory = await mkdtemp(path.join(tmpdir(), "de003-race-"));
  try {
    const { plan } = await loadConformancePlan(planPath);
    const evidence = path.join(directory, "evidence.json");
    let adapter = "typescript/kernel/conformance-adapter/adapter.json";
    if (serialized) {
      const manifest = await readAdapterManifest(adapter);
      const script = `
        import { createSyscallBindings } from ${JSON.stringify(path.join(root, "typescript/kernel/conformance-adapter/src/host-syscalls.ts"))};
        import { serveStdioAdapter } from ${JSON.stringify(path.join(root, "tools/conformance/adapter-protocol/stdio-host.ts"))};
        const bridge = createSyscallBindings({adapterId: "sequential-writers", backend: "memory", capabilities: ${JSON.stringify(manifest.capabilities)}});
        let previous = Promise.resolve();
        const outcomes = new Map();
        await serveStdioAdapter({
          ...bridge,
          initialize: (packetId, planVersion) => ({adapterId: "sequential-writers", capabilities: ${JSON.stringify(manifest.capabilities)}, packetId, planVersion, protocolVersion: "0.2.0"}),
          dispatch: (operation, input, controls, instance) => bridge.dispatch(operation, input, instance),
          startOperation: async (operation, input, instance) => {
            const operationHandle = "sequential-" + outcomes.size;
            const outcome = previous.then(() => bridge.dispatch(operation, input, instance, undefined, operationHandle));
            outcomes.set(operationHandle, outcome);
            previous = outcome.then(() => undefined, () => undefined);
            return {operationHandle};
          },
          awaitOperation: async handle => await outcomes.get(handle)
        });`;
      adapter = path.join(directory, "adapter.json");
      await writeFile(
        adapter,
        JSON.stringify({
          ...manifest,
          adapterId: "sequential-writers",
          command: ["bun", "--eval", script],
        })
      );
    }
    const child = Bun.spawn(
      [
        "bun",
        "tools/conformance/harness/run.ts",
        "--adapter",
        adapter,
        "--packet",
        "spec/kernel/authority-packet.json",
        "--plan",
        planPath,
        "--check",
        "kernel.syscall.concurrent_writer.a_first",
        "--check",
        "kernel.syscall.concurrent_writer.b_first",
        "--evidence-out",
        evidence,
      ],
      { cwd: root, stderr: "pipe", stdout: "pipe" }
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code, stderr + stdout).toBe(serialized ? 1 : 0);
    const result: unknown = JSON.parse(await readFile(evidence, "utf-8"));
    assertConformanceEvidence(result, "writer race evidence");
    expect(result.checkResults).toHaveLength(2);
    for (const check of result.checkResults) {
      expect(check.status).toBe(serialized ? "fail" : "pass");
      if (serialized) {
        expect(check.failure?.classification).toBe("adapter_protocol");
        const observations = check.failure?.observation;
        if (!Array.isArray(observations)) {
          throw new TypeError("missing failed trace");
        }
        const readStep = (stepId: string): unknown =>
          observations.find(
            (entry: unknown) =>
              typeof entry === "object" &&
              entry !== null &&
              "stepId" in entry &&
              entry.stepId === stepId
          );
        expect(readStep("firstReceipt")).toMatchObject({
          outcome: { kind: "result" },
        });
        const second = readStep("secondReceipt");
        expect(second).toMatchObject({ stepId: "secondReceipt" });
        expect(
          typeof second === "object" && second !== null && "outcome" in second
        ).toBe(false);
        expect(JSON.stringify(check.failure)).toContain(
          "implementation entry receipt"
        );
        expect(JSON.stringify(check.failure?.observation)).not.toContain(
          '"stepId":"release"'
        );
      } else {
        expect(check.details?.traceStepIds).toContain("secondReceipt");
        const planned = plan.checks.find(
          (entry) => entry.checkId === check.checkId
        );
        expect(
          planned?.assertions.some((assertion) => assertion.when !== undefined)
        ).toBe(true);
      }
    }
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
};

test("writer race passes with two native entry receipts in both orderings", async () => {
  await runRace(false);
}, 30_000);
test("writer race fails before release when the contenders execute sequentially", async () => {
  await runRace(true);
}, 30_000);

test("stale-head mutation activates and the new syscall claims kill it", async () => {
  const { NEGATIVE_CONTROL_PORTS, runNegativeControls } =
    await import("../../../../tools/conformance/meta-conformance/negative-controls.ts");
  const config = NEGATIVE_CONTROL_PORTS.find((port) => port.port === "kernel");
  if (config === undefined) {
    throw new Error("missing kernel controls");
  }
  const report = await runNegativeControls(config, {
    mutants: ["kernel.accept-stale-head-update"],
  });
  expect(report.control.status).toBe("pass");
  expect(report.mutants).toHaveLength(1);
  const [mutant] = report.mutants;
  expect(mutant, mutant?.reason).toMatchObject({
    activated: true,
    outcome: "killed",
  });
  expect(mutant?.activationCount).toBeGreaterThan(0);
  for (const ordering of ["a_first", "b_first"]) {
    expect(
      mutant?.designatedFailures.some((id) =>
        id.startsWith(`kernel.syscall.concurrent_writer.${ordering}.`)
      )
    ).toBe(true);
  }
}, 60_000);

test("both contenders are released together after a held-head read", async () => {
  const { plan } = await loadConformancePlan(planPath);
  for (const check of plan.checks) {
    const steps = check.steps ?? [];
    const releases = steps.filter((step) => step.action === "release");
    expect(releases).toHaveLength(1);
    expect(releases[0]?.participants).toEqual(["firstStart", "secondStart"]);
    const held = steps.findIndex((step) => step.stepId === "heldHead");
    expect(held).toBeGreaterThan(
      steps.findIndex((step) => step.stepId === "secondReceipt")
    );
    expect(held).toBeLessThan(
      steps.findIndex((step) => step.action === "release")
    );
    expect(
      check.assertions.some((assertion) => assertion.kind === "arrival")
    ).toBe(false);
  }
});

test("barrier holds only named participants and clears after their release", async () => {
  const { createMemoryBackend } = await import("@tuvren/backend-memory");
  const { createKernelBarrierControl } =
    await import("../../testkit/src/lib/kernel-barrier-control.ts");
  const barrier = createKernelBarrierControl(createMemoryBackend());
  barrier.arm("writers", "kernel.persistence.before-transact", ["a", "b"]);
  const a = barrier.run(
    "handle-a",
    undefined,
    async () =>
      await barrier.backend.transact(async () => await Promise.resolve(1)),
    "a"
  );
  const b = barrier.run(
    "handle-b",
    undefined,
    async () =>
      await barrier.backend.transact(async () => await Promise.resolve(2)),
    "b"
  );
  try {
    await barrier.wait("writers", "handle-a", 100);
    await barrier.wait("writers", "handle-b", 100);
    const third = barrier.run(
      "handle-third",
      undefined,
      async () =>
        await barrier.backend.transact(async () => await Promise.resolve(3)),
      "third"
    );
    const expired = Promise.withResolvers<never>();
    const timer = setTimeout(() => {
      expired.reject(new Error("third operation held"));
    }, 100);
    try {
      expect(await Promise.race([third, expired.promise])).toBe(3);
    } finally {
      clearTimeout(timer);
    }
    barrier.release("writers", ["handle-a", "handle-b"]);
    expect(await Promise.all([a, b])).toEqual([1, 2]);
    expect(() =>
      barrier.arm("next", "kernel.persistence.before-transact", ["c", "d"])
    ).not.toThrow();
  } finally {
    barrier.close();
    await Promise.allSettled([a, b]);
  }
});

test("closing a barrier rejects held writers before they enter storage", async () => {
  const { createMemoryBackend } = await import("@tuvren/backend-memory");
  const { createKernelBarrierControl } =
    await import("../../testkit/src/lib/kernel-barrier-control.ts");
  const barrier = createKernelBarrierControl(createMemoryBackend());
  barrier.arm("writers", "kernel.persistence.before-transact", ["a", "b"]);
  let entered = false;
  const writer = barrier.run(
    "a",
    undefined,
    async () => {
      await barrier.backend.transact(async () => {
        entered = true;
        await Promise.resolve();
      });
    },
    "a"
  );
  await barrier.wait("writers", "a", 100);
  const outcome = Promise.allSettled([writer]);
  barrier.close();
  expect(await outcome).toMatchObject([{ status: "rejected" }]);
  expect(entered).toBe(false);
});

const success = (target: string) => ({
  outcome: { kind: "result" },
  result: { branch: { headTurnNodeHash: target } },
});
const failure = (code = "kernel_runtime_lateral_head_movement") => ({
  outcome: { kind: "error" },
  state: { adapterError: { code, message: "lateral" } },
});

test("race assertions accept either winner and reject double success, double conflict, wrong errors, escaped gates, and overwritten heads", async () => {
  const { evaluateAssertions } =
    await import("../../../../tools/conformance/harness/assertion-engine/index.ts");
  const { plan } = await loadConformancePlan(planPath);
  const fixture: unknown = JSON.parse(
    await readFile(
      path.join(
        root,
        "spec/conformance/kernel/fixtures/concurrent-writer/errors.json"
      ),
      "utf-8"
    )
  );
  for (const check of plan.checks) {
    const firstTarget = check.checkId.endsWith("a_first") ? "a" : "b";
    const secondTarget = firstTarget === "a" ? "b" : "a";
    for (const winner of ["first", "second"]) {
      const winningTarget = winner === "first" ? firstTarget : secondTarget;
      const trace = {
        aCheckpoint: { result: { turnNodeHash: "a" } },
        aNode: { result: { previousTurnNodeHash: "base" } },
        bCheckpoint: { result: { turnNodeHash: "b" } },
        bNode: { result: { previousTurnNodeHash: "base" } },
        baseCheckpoint: { result: { turnNodeHash: "base" } },
        commonHead: { result: { headTurnNodeHash: "base" } },
        firstOutcome: winner === "first" ? success(firstTarget) : failure(),
        firstReceipt: {
          result: {
            barrierId: "writers",
            operationHandle: "h1",
            seam: "kernel.persistence.before-transact",
          },
        },
        head: { result: { headTurnNodeHash: winningTarget } },
        heldHead: { result: { headTurnNodeHash: "base" } },
        release: { result: { operationHandles: ["h1", "h2"] } },
        secondOutcome: winner === "second" ? success(secondTarget) : failure(),
        secondReceipt: {
          result: {
            barrierId: "writers",
            operationHandle: "h2",
            seam: "kernel.persistence.before-transact",
          },
        },
      };
      const evaluate = (value: typeof trace) =>
        evaluateAssertions(check, {
          fixture,
          result: { trace: value },
          state: { trace: value },
        });
      expect(
        evaluate(trace).every((evaluation) => evaluation.status === "pass")
      ).toBe(true);
      for (const patch of [
        {
          firstOutcome: success(firstTarget),
          secondOutcome: success(secondTarget),
        },
        { firstOutcome: failure(), secondOutcome: failure() },
        winner === "first"
          ? { secondOutcome: failure("wrong_error") }
          : { firstOutcome: failure("wrong_error") },
        { heldHead: { result: { headTurnNodeHash: winningTarget } } },
        { head: { result: { headTurnNodeHash: "overwritten" } } },
      ]) {
        expect(
          evaluate({ ...trace, ...patch }).some(
            (evaluation) => evaluation.status === "fail"
          )
        ).toBe(true);
      }
    }
  }
});

test("stale-read setHead splits transactions without harness barriers", async () => {
  const { createMemoryBackend } = await import("@tuvren/backend-memory");
  const { selectKernelMutant } = await import("../../testkit/src/index.ts");
  const { decorateBackend } =
    await import("../../testkit/src/lib/kernel-mutant-backend.ts");
  const { createConformanceRuntimeKernel } =
    await import("../src/host-support.ts");
  const mutant = selectKernelMutant("kernel.accept-stale-head-update");
  let transactions = 0;
  const inner = createMemoryBackend();
  const backend = mutant.wrapBackend(
    decorateBackend(inner, {
      transact: async (work) => {
        transactions += 1;
        return await inner.transact(work);
      },
    })
  );
  const kernel = createConformanceRuntimeKernel({ mutant }, { backend });
  const schemaId = await kernel.schema.register({
    incorporationRules: [{ objectType: "message", targetPath: "messages" }],
    paths: [{ collection: "ordered", path: "messages" }],
    schemaId: "split",
  });
  const thread = await kernel.thread.create("thread", schemaId, "source");
  await kernel.turn.create(
    "turn",
    "thread",
    "source",
    undefined,
    thread.rootTurnNodeHash
  );
  await kernel.run.create(
    "run",
    "turn",
    "source",
    schemaId,
    thread.rootTurnNodeHash,
    [{ deterministic: false, id: "step", sideEffects: false }]
  );
  await kernel.run.beginStep("run", "step");
  const checkpoint = await kernel.run.completeStep("run", "step");
  if (checkpoint.turnNodeHash === undefined) {
    throw new Error("missing checkpoint");
  }
  await kernel.branch.create("target", "thread", thread.rootTurnNodeHash);
  transactions = 0;
  const result = await kernel.branch.setHead("target", checkpoint.turnNodeHash);
  expect(result.branch.headTurnNodeHash).toBe(checkpoint.turnNodeHash);
  expect(transactions).toBe(2);
  expect(mutant.readActivation()).toMatchObject({ activated: true });
});
