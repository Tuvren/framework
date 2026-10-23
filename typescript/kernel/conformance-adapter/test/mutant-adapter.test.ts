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

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  isMutantAdapterCommand,
  readCertificationManifest,
} from "../../../../tools/conformance/certification/certification-manifest.ts";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const ADAPTER_DIRECTORY = "typescript/kernel/conformance-adapter";
const MUTANT_MANIFEST = `${ADAPTER_DIRECTORY}/adapter-mutant.json`;
const CERTIFYING_MANIFESTS = [
  `${ADAPTER_DIRECTORY}/adapter.json`,
  `${ADAPTER_DIRECTORY}/adapter-postgres.json`,
  `${ADAPTER_DIRECTORY}/adapter-sqlite.json`,
];
const PLANS_DIRECTORY = "spec/conformance/kernel/plans";
const MUTANT_ENV = "TUVREN_KERNEL_MUTANT";
const ACTIVATION_OPERATION = "kernel.mutant.activation";

// Controls whose designated checks need a capability the memory adapter does
// not advertise, so the memory baseline cannot reach their mutated branch.
const UNREACHABLE_ON_MEMORY = new Set(["kernel.lease-takeover-before-expiry"]);

interface AdapterManifest {
  adapterId: string;
  capabilities: string[];
  command: string[];
}

interface PlanCheck {
  assertions: { field?: string }[];
  capabilities: string[];
  checkId: string;
  fixture?: string;
  operation: string;
}

interface ResolvedCheck {
  capabilities: string[];
  check: PlanCheck;
  fixture?: unknown;
}

interface ManifestControl {
  claimIds: string[];
  designatedAssertions?: string[];
  kind: string;
  mutantId: string;
}

interface RpcResponse {
  id: unknown;
  result?: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readJson = (relativePath: string): unknown =>
  JSON.parse(readFileSync(path.join(REPO_ROOT, relativePath), "utf-8"));

const readRecords = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.filter(isRecord) : [];

const readStrings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];

const readPlanCheck = (check: Record<string, unknown>): PlanCheck => ({
  assertions: readRecords(check.assertions).map((assertion) =>
    typeof assertion.field === "string" ? { field: assertion.field } : {}
  ),
  capabilities: readStrings(check.requiredCapabilities ?? check.capabilities),
  checkId: String(check.checkId),
  ...(typeof check.fixture === "string" ? { fixture: check.fixture } : {}),
  operation: String(check.operation),
});

const readManifest = (relativePath: string): AdapterManifest => {
  const value = readJson(relativePath);
  if (!(isRecord(value) && Array.isArray(value.command))) {
    throw new Error(`${relativePath} must be an adapter manifest`);
  }
  const manifest: AdapterManifest = {
    adapterId: String(value.adapterId),
    capabilities: Array.isArray(value.capabilities)
      ? value.capabilities.map(String)
      : [],
    command: value.command.map(String),
  };
  return manifest;
};

const readPlanChecks = (): Map<string, ResolvedCheck> => {
  const checks = new Map<string, ResolvedCheck>();
  for (const file of readdirSync(path.join(REPO_ROOT, PLANS_DIRECTORY))) {
    const planPath = path.join(PLANS_DIRECTORY, file);
    const plan = readJson(planPath);
    const planRecord = isRecord(plan) ? plan : {};
    const fixtures = isRecord(planRecord.fixtures) ? planRecord.fixtures : {};
    const applicability = isRecord(planRecord.applicability)
      ? planRecord.applicability
      : {};
    const planCapabilities = readStrings(applicability.capabilities);
    for (const check of readRecords(planRecord.checks).map(readPlanCheck)) {
      const fixturePath =
        check.fixture === undefined ? undefined : fixtures[check.fixture];
      checks.set(check.checkId, {
        capabilities: [...planCapabilities, ...check.capabilities],
        check,
        ...(typeof fixturePath === "string"
          ? {
              fixture: readJson(path.join(path.dirname(planPath), fixturePath)),
            }
          : {}),
      });
    }
  }
  return checks;
};

const readControls = (): ManifestControl[] => {
  const manifest = readJson("spec/conformance/kernel/negative-controls.json");
  if (!(isRecord(manifest) && Array.isArray(manifest.controls))) {
    throw new Error("negative-control manifest must declare controls");
  }
  return readRecords(manifest.controls).map((control) => ({
    claimIds: readStrings(control.claimIds),
    ...(control.designatedAssertions === undefined
      ? {}
      : { designatedAssertions: readStrings(control.designatedAssertions) }),
    kind: String(control.kind),
    mutantId: String(control.mutantId),
  }));
};

const detectionCheckIds = (control: ManifestControl): string[] =>
  control.kind === "implementation"
    ? [
        ...new Set(
          (control.designatedAssertions ?? []).map((assertionId) =>
            assertionId.replace(/\.\d+\.[A-Za-z]+$/u, "")
          )
        ),
      ]
    : control.claimIds;

const designatedFields = (
  control: ManifestControl,
  checks: ReadonlyMap<string, ResolvedCheck>
): { checkId: string; field: string }[] =>
  (control.designatedAssertions ?? []).flatMap((assertionId) => {
    const match = /^(?<checkId>.+)\.(?<index>\d+)\.[A-Za-z]+$/u.exec(
      assertionId
    )?.groups;
    const checkId = match?.checkId ?? "";
    const index = Number(match?.index ?? "0");
    const field = checks.get(checkId)?.check.assertions[index - 1]?.field;
    return field === undefined ? [] : [{ checkId, field }];
  });

const readField = (value: unknown, field: string): unknown => {
  let current = value;
  for (const segment of field.replace(/^\$\./u, "").split(".")) {
    if (Array.isArray(current)) {
      current = current[Number(segment)];
    } else {
      current = isRecord(current) ? current[segment] : undefined;
    }
  }
  return current;
};

const runAdapter = async (
  manifest: AdapterManifest,
  requests: readonly { method: string; params: unknown }[],
  env: Record<string, string> = {}
): Promise<{ exitCode: number; responses: RpcResponse[]; stderr: string }> => {
  const child = Bun.spawn({
    cmd: manifest.command,
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
    stderr: "pipe",
    stdin: "pipe",
    stdout: "pipe",
  });
  await child.stdin.write(
    requests
      .map(
        (request, index) =>
          `${JSON.stringify({ id: index + 1, jsonrpc: "2.0", ...request })}\n`
      )
      .join("")
  );
  await child.stdin.end();
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const responses = stdout
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line): RpcResponse => {
      const response: unknown = JSON.parse(line);
      return isRecord(response)
        ? { id: response.id, result: response.result }
        : { id: undefined };
    });
  return { exitCode, responses, stderr };
};

const dispatchRequest = (operation: string, input: unknown) => ({
  method: "dispatch",
  params: { controls: {}, input, operation },
});

const checkRequest = (resolved: ResolvedCheck) =>
  dispatchRequest(
    resolved.check.operation,
    resolved.fixture === undefined ? {} : { fixture: resolved.fixture }
  );

const readResult = (response: RpcResponse | undefined): unknown => {
  const outcome = response?.result;
  if (!(isRecord(outcome) && outcome.kind === "result")) {
    throw new Error(
      `expected a result outcome, got ${JSON.stringify(response)}`
    );
  }
  return isRecord(outcome.value) ? outcome.value.result : undefined;
};

const mutantManifest = readManifest(MUTANT_MANIFEST);
const memoryManifest = readManifest(`${ADAPTER_DIRECTORY}/adapter.json`);
const planChecks = readPlanChecks();

describe("mutant adapter manifest", () => {
  test("is a non-certifying memory adapter that selects its mutant by id", () => {
    expect(isMutantAdapterCommand(mutantManifest.command)).toBe(true);
    expect(mutantManifest.command).toContain("--mutant-from-env");
    expect(mutantManifest.adapterId).not.toBe(memoryManifest.adapterId);
    expect(mutantManifest.capabilities).toEqual(memoryManifest.capabilities);
  });

  test("certifying manifests never launch a mutant", () => {
    for (const manifestPath of CERTIFYING_MANIFESTS) {
      expect({
        manifestPath,
        mutant: isMutantAdapterCommand(readManifest(manifestPath).command),
      }).toEqual({ manifestPath, mutant: false });
    }
  });

  test("certification discovery inventory excludes the mutant manifest", async () => {
    const inventory = await readCertificationManifest(
      path.join(
        REPO_ROOT,
        "tools/conformance/certification/certified-projects.json"
      )
    );

    expect(
      inventory.inventory.filter((entry) =>
        isMutantAdapterCommand(readManifest(entry.adapter).command)
      )
    ).toEqual([]);
    expect(
      inventory.inventory.map((entry) => path.normalize(entry.adapter))
    ).not.toContain(path.normalize(MUTANT_MANIFEST));
  });
});

describe("mutant activation control", () => {
  test("the certifying adapter does not answer the activation control", async () => {
    const { responses } = await runAdapter(memoryManifest, [
      dispatchRequest(ACTIVATION_OPERATION, {}),
    ]);

    expect(responses[0]?.result).toEqual({
      error: {
        code: "adapter_operation_not_implemented",
        message: `${memoryManifest.adapterId} does not implement ${ACTIVATION_OPERATION}`,
      },
      kind: "error",
    });
  });

  test("the mutant adapter refuses to start without a registered mutant", async () => {
    const unset = await runAdapter(mutantManifest, [], { [MUTANT_ENV]: "" });
    const unknown = await runAdapter(mutantManifest, [], {
      [MUTANT_ENV]: "kernel.no-such-mutant",
    });

    expect(unset.exitCode).not.toBe(0);
    expect(unknown.exitCode).not.toBe(0);
    expect(unknown.stderr).toContain(
      "unknown kernel mutant kernel.no-such-mutant"
    );
  });

  test("reports zero activation before the mutated branch runs", async () => {
    const { responses } = await runAdapter(
      mutantManifest,
      [dispatchRequest(ACTIVATION_OPERATION, {})],
      { [MUTANT_ENV]: "kernel.never-sweep-eligible-objects" }
    );

    expect(readResult(responses[0])).toEqual({
      activation: {
        activated: false,
        activationCount: 0,
        kind: "implementation",
        mutantId: "kernel.never-sweep-eligible-objects",
        signal: "mutant.never-sweep-eligible-objects.entered",
      },
    });
  });

  for (const control of readControls()) {
    const checks = detectionCheckIds(control).flatMap((checkId) => {
      const resolved = planChecks.get(checkId);
      return resolved === undefined ? [] : [resolved];
    });
    const reachable = checks.filter((resolved) =>
      resolved.capabilities.every((capability) =>
        mutantManifest.capabilities.includes(capability)
      )
    );

    test(`${control.mutantId} activates through its detecting checks on memory`, async () => {
      expect(reachable.length === 0).toBe(
        UNREACHABLE_ON_MEMORY.has(control.mutantId)
      );
      const requests = [
        ...reachable.map(checkRequest),
        dispatchRequest(ACTIVATION_OPERATION, {}),
      ];
      const { responses } = await runAdapter(mutantManifest, requests, {
        [MUTANT_ENV]: control.mutantId,
      });
      const activation = readField(
        readResult(responses.at(-1)),
        "activation.activated"
      );

      expect(activation).toBe(!UNREACHABLE_ON_MEMORY.has(control.mutantId));
    });

    if (
      control.kind === "implementation" &&
      !UNREACHABLE_ON_MEMORY.has(control.mutantId)
    ) {
      test(`${control.mutantId} alters a designated observation before the adapter reports it`, async () => {
        const fields = designatedFields(control, planChecks).filter(
          ({ checkId }) =>
            reachable.some((entry) => entry.check.checkId === checkId)
        );
        const requests = fields.map(({ checkId }) => {
          const resolved = planChecks.get(checkId);
          if (resolved === undefined) {
            throw new Error(`unknown designated check ${checkId}`);
          }
          return checkRequest(resolved);
        });
        const [mutated, reference] = await Promise.all([
          runAdapter(mutantManifest, requests, {
            [MUTANT_ENV]: control.mutantId,
          }),
          runAdapter(memoryManifest, requests),
        ]);
        const changed = fields.filter(
          ({ field }, index) =>
            !Bun.deepEquals(
              readField(
                readResult(mutated.responses[index]),
                field.replace(/^\$\./u, "")
              ),
              readField(
                readResult(reference.responses[index]),
                field.replace(/^\$\./u, "")
              )
            )
        );

        expect(changed.length > 0).toBe(true);
      });
    }
  }
});
