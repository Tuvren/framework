import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { spawn } from "bun";

import { readAdapterManifest } from "../../../../tools/conformance/harness/run-plans.ts";
import { loadConformancePlan } from "../../../../tools/conformance/plan-compiler/index.ts";
import type { ConformancePlanStep } from "../../../../tools/conformance/plan-compiler/index.ts";
import { assertConformanceEvidence } from "../../../../tools/scripts/lib/conformance-contract.ts";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const planPath =
  "spec/conformance/kernel/plans/kernel-protocol-core-syscall.json";

test("promoted serial plan assertions keep their results when syscalls run through handles", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "kernel-handle-parity-"));
  try {
    const { plan } = await loadConformancePlan(planPath);
    const originalPacket: unknown = JSON.parse(
      await readFile(
        path.join(repoRoot, "spec/kernel/authority-packet.json"),
        "utf-8"
      )
    );
    if (typeof originalPacket !== "object" || originalPacket === null) {
      throw new Error("missing authority packet");
    }
    const manifest = await readAdapterManifest(
      "typescript/kernel/conformance-adapter/adapter.json"
    );
    const packetPath = path.join(directory, "packet.json");
    const adapterPath = path.join(directory, "adapter.json");
    const temporaryPlan = path.join(directory, "plan.json");
    await writeFile(
      packetPath,
      JSON.stringify({
        ...originalPacket,
        conformancePlans: [
          {
            path: temporaryPlan,
            planId: plan.planId,
            planVersion: plan.planVersion,
          },
        ],
      })
    );
    await writeFile(
      adapterPath,
      JSON.stringify({ ...manifest, authorityPackets: [packetPath] })
    );
    const fixtures = Object.fromEntries(
      Object.entries(plan.fixtures ?? {}).map(([key, value]) => [
        key,
        path.resolve(repoRoot, path.dirname(planPath), value),
      ])
    );
    const execute = async (handles: boolean): Promise<unknown> => {
      const checks = plan.checks.map((check) => ({
        ...check,
        steps: check.steps?.flatMap((step): ConformancePlanStep[] => {
          if (!handles || step.action !== undefined) {
            return [step];
          }
          const capture = `operation_${step.stepId}`;
          return [
            {
              action: "start",
              arguments: step.arguments,
              claimIds: step.claimIds,
              handleCapture: capture,
              operation: step.operation,
              stepId: `${step.stepId}Start`,
            },
            {
              ...step,
              action: "await",
              arguments: {
                operationHandle: { $ref: `capture.${capture}` },
              },
            },
          ];
        }),
      }));
      await writeFile(
        temporaryPlan,
        JSON.stringify({ ...plan, checks, fixtures })
      );
      const evidencePath = path.join(directory, `evidence-${handles}.json`);
      const child = spawn(
        [
          "bun",
          "tools/conformance/harness/run.ts",
          "--adapter",
          adapterPath,
          "--concurrency",
          "1",
          "--summary-only",
          "--evidence-out",
          evidencePath,
        ],
        { cwd: repoRoot, stderr: "pipe", stdout: "pipe" }
      );
      const [exit, stderr, stdout] = await Promise.all([
        child.exited,
        new Response(child.stderr).text(),
        new Response(child.stdout).text(),
      ]);
      expect({ exit, stderr, stdout }).toMatchObject({ exit: 0 });
      const evidence: unknown = JSON.parse(
        await readFile(evidencePath, "utf-8")
      );
      assertConformanceEvidence(evidence, evidencePath);
      const originalSteps = new Set(
        plan.checks.flatMap(
          (check) => check.steps?.map((step) => step.stepId) ?? []
        )
      );
      return {
        ...evidence,
        checkResults: evidence.checkResults.map((check) => ({
          ...check,
          ...(check.details === undefined
            ? {}
            : {
                details: {
                  ...check.details,
                  traceStepIds: Array.isArray(check.details.traceStepIds)
                    ? check.details.traceStepIds.filter(
                        (id: unknown) =>
                          typeof id === "string" && originalSteps.has(id)
                      )
                    : check.details.traceStepIds,
                },
              }),
        })),
      };
    };
    const serial = await execute(false);
    const handles = await execute(true);
    expect(handles).toEqual(serial);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}, 15_000);
