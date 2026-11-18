import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { parseOperationCatalog } from "../../plan-compiler/certification-rules.ts";
import { loadConformancePlan } from "../../plan-compiler/index.ts";
import { JsonRpcAdapterClient } from "../adapter-client.ts";
import { selectCheck } from "../check-selection.ts";
import { readAdapterManifest } from "../run-plans.ts";
import { runScheduledChecks } from "../run.ts";

const SCOPE =
  "spec/conformance/kernel/plans/kernel-scope-isolation-syscall.json";
const CODEC = "spec/conformance/kernel/plans/kernel-codec.json";
const adapters = [
  "typescript/kernel/conformance-adapter/adapter.json",
  "rust/kernel-conformance-adapter/adapter.json",
];

const scopePlan = async () => {
  const plan = await loadConformancePlan(SCOPE);
  plan.catalog = parseOperationCatalog(
    JSON.parse(
      await readFile("spec/conformance/kernel/operations.json", "utf8")
    ),
    "kernel catalog"
  );
  return plan;
};

test("schema and compiler accept scoped names and reject unknown, duplicate, and unscoped names", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "dq002-names-"));
  const file = path.join(directory, "plan.json");
  try {
    const original = await scopePlan();
    await writeFile(file, JSON.stringify(original.plan));
    await expect(loadConformancePlan(file)).resolves.toBeDefined();
    for (const mode of ["unknown", "duplicate", "unscoped", "empty"]) {
      const plan = structuredClone(original.plan);
      const check = plan.checks[0];
      const create = check?.steps?.[0];
      const read = check?.steps?.find((step) => step.stepId === "has");
      if (
        create === undefined ||
        read === undefined ||
        check?.steps === undefined
      ) {
        throw new Error("missing scope trace");
      }
      switch (mode) {
        case "unknown":
          read.instance = "unknown";
          break;
        case "duplicate":
          check.steps.splice(1, 0, { ...create, stepId: "duplicate" });
          break;
        case "unscoped":
          create.arguments = {};
          break;
        default:
          create.instance = "";
      }
      await writeFile(file, JSON.stringify(plan));
      await expect(loadConformancePlan(file)).rejects.toThrow();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

for (const adapter of adapters) {
  test(`${adapter} passes canonical scope and codec plans without loading legacy plans`, async () => {
    const manifest = await readAdapterManifest(adapter);
    const scope = await scopePlan();
    const codec = await loadConformancePlan(CODEC);
    codec.catalog = scope.catalog;
    const plans = [scope, codec];
    expect(plans.map(({ plan }) => plan.planId)).toEqual([
      "tuvren.kernel.scope-isolation.syscall",
      "tuvren.kernel.codec",
    ]);
    const checks = plans.flatMap((plan) =>
      plan.checks.map((compiledCheck) => ({ plan, compiledCheck }))
    );
    for (const { plan, compiledCheck } of checks) {
      expect(
        selectCheck({
          adapter: new Set(manifest.capabilities),
          checkId: compiledCheck.check.checkId,
          protocolVersion: manifest.protocol.version,
          requested: new Set(["kernel.syscall", "kernel.codec"]),
          required: [
            ...plan.plan.applicability.capabilities,
            ...(compiledCheck.check.capabilities ?? []),
          ],
          steps: compiledCheck.check.steps,
        }).selected
      ).toBe(true);
    }
    const results = await runScheduledChecks(
      manifest,
      checks.map((entry, index) => ({ ...entry, index })),
      1,
      () => "replay",
      true
    );
    expect(results).toHaveLength(71);
    for (const { checkResult } of results) {
      expect(checkResult.status, JSON.stringify(checkResult)).toBe("pass");
    }
    const content = results.find(({ checkResult }) =>
      checkResult.checkId.endsWith("own_content")
    );
    expect(content?.checkResult.assertionResults).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          assertionId:
            "kernel.syscall.scope-isolation.own_content.has.1.resultField",
          status: "pass",
        }),
        expect.objectContaining({
          assertionId:
            "kernel.syscall.scope-isolation.own_content.otherHas.1.resultField",
          status: "pass",
        }),
        expect.objectContaining({
          assertionId:
            "kernel.syscall.scope-isolation.own_content.otherGet.1.resultField",
          status: "pass",
        }),
      ])
    );
  }, 60_000);

  test(`${adapter} shares a substrate across names and rejects released substrate reuse`, async () => {
    const manifest = await readAdapterManifest(adapter);
    const plan = await scopePlan();
    const original = plan.checks[0];
    if (original === undefined) {
      throw new Error("missing content check");
    }
    const check = structuredClone(original.check);
    for (const step of check.steps ?? []) {
      if (step.stepId === "scopeB") {
        step.arguments = { scope: "tuvren.scope.a" };
      }
      if (step.stepId === "otherHas") {
        step.assertions = [{ kind: "resultField", field: "$", equals: true }];
      }
      if (step.stepId === "otherGet") {
        step.assertions = [
          {
            kind: "resultField",
            field: "$",
            equals: { $bytes: "00ff8073636f7065" },
          },
        ];
      }
    }
    const [result] = await runScheduledChecks(
      manifest,
      [{ plan, compiledCheck: { ...original, check }, index: 0 }],
      1,
      () => "replay",
      true
    );
    expect(
      result?.checkResult.status,
      JSON.stringify(result?.checkResult)
    ).toBe("pass");
    const client = new JsonRpcAdapterClient({
      command: manifest.command,
      cwd: process.cwd(),
    });
    try {
      await client.initialize("tuvren.kernel.protocol", "0.1.0");
      const storageRef = `dq002-${randomUUID()}`;
      const first = await client.createInstance({}, { storageRef, scope: "a" });
      const second = await client.createInstance(
        {},
        { storageRef, scope: "b" }
      );
      await client.destroyInstance(first);
      await client.destroyInstance(second);
      await expect(
        client.createInstance({}, { storageRef, scope: "a" })
      ).rejects.toThrow("released substrate");
    } finally {
      await client.shutdown();
    }
  }, 30_000);
}

test.each(["unknown", "duplicate"])(
  "runner rejects %s names even if compilation is bypassed",
  async (mode) => {
    const manifest = await readAdapterManifest(adapters[0] ?? "");
    const plan = await scopePlan();
    const original = plan.checks[0];
    if (original === undefined) {
      throw new Error("missing content check");
    }
    const check = structuredClone(original.check);
    const create = check.steps?.[0];
    const read = check.steps?.find((step) => step.stepId === "has");
    if (
      create === undefined ||
      read === undefined ||
      check.steps === undefined
    ) {
      throw new Error("missing trace");
    }
    if (mode === "unknown") {
      read.instance = "unknown";
    } else {
      check.steps.splice(1, 0, { ...create, stepId: "duplicate" });
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
    expect(entry?.checkResult.details?.verificationError).toContain(mode);
  }
);
