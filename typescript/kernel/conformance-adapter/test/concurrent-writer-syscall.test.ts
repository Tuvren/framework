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
          planned?.assertions.some((assertion) => assertion.kind === "arrival")
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
