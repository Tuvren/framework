import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

import { claimAssertions } from "../meta-conformance/claim-coverage.ts";
import {
  assertCertificationEnforcement,
  assessConformancePlans,
  loadCertificationAuthority,
} from "./certification-assessment.ts";
import { loadConformancePlan } from "./index.ts";

const PLAN = "spec/conformance/kernel/plans/kernel-codec.json";
const object = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("expected an object");
  }
  return value;
};
const list = (value: unknown): unknown[] => {
  if (!Array.isArray(value)) {
    throw new TypeError("expected an array");
  }
  return value;
};
const text = (value: unknown): string => {
  if (typeof value !== "string") {
    throw new TypeError("expected a string");
  }
  return value;
};
const json = async (path: string): Promise<unknown> =>
  JSON.parse(await readFile(path, "utf8"));
const CONTEXT_ROOT = /^\$\./u;
const at = (value: unknown, path: string): unknown => {
  let current = value;
  for (const key of path.replace(CONTEXT_ROOT, "").split(".")) {
    current = object(current)[key];
  }
  return current;
};

test("codec-only plans enforce catalogue and observation rules", async () => {
  const authority = await loadCertificationAuthority([
    "spec/kernel/authority-packet.json",
  ]);
  const assessments = await assessConformancePlans([PLAN], authority);
  expect(assessments[0]?.mode).toBe("enforcing");
  expect(assessments[0]?.violations).toEqual([]);
  expect(() => assertCertificationEnforcement(assessments)).not.toThrow();
  const compiled = await loadConformancePlan(PLAN);
  expect(compiled.plan.applicability.capabilities).toEqual(["kernel.codec"]);
  expect(compiled.checks).toHaveLength(69);
  const catalog = authority.packets.get(compiled.plan.packetId)?.catalog;
  for (const { check } of compiled.checks) {
    for (const step of check.steps ?? []) {
      expect(catalog?.operations.get(step.operation)).toMatchObject({
        kind: "syscall",
      });
      expect(step.arguments).toBeDefined();
      expect(step.claimIds).toEqual(check.claimIds);
    }
  }
});

test("the obligation map covers all 68 legacy assertions with committed expectations", async () => {
  const map = object(
    await json("spec/conformance/kernel/codec-obligation-map.json")
  );
  expect(map.summary).toEqual({ mapped: 68, retired: 0 });
  const obligations = list(map.obligations).map(object);
  const compiled = await loadConformancePlan(PLAN);
  const vectors = compiled.fixtures.get("vectors");
  const oldIds: string[] = [];
  const legacyPlans = [
    "spec/conformance/kernel/plans/kernel-protocol-core.json",
    "spec/conformance/kernel/plans/kernel-protocol-extended.json",
  ];
  for (const path of legacyPlans) {
    const legacy = await loadConformancePlan(path);
    for (const { check } of legacy.checks) {
      if (
        ![
          "kernel.protocol.deterministic-hashing",
          "kernel.protocol.canonical-rejection",
        ].includes(check.operation)
      ) {
        continue;
      }
      for (const [index, assertion] of check.assertions.entries()) {
        oldIds.push(`${check.checkId}.${index + 1}.${assertion.kind}`);
      }
    }
  }
  expect(oldIds).toHaveLength(68);
  expect(
    obligations.map((entry) => text(entry.legacyAssertion)).toSorted()
  ).toEqual(oldIds.toSorted());
  expect(new Set(obligations.map((entry) => entry.claimId)).size).toBe(68);
  for (const entry of obligations) {
    expect(entry.status).toBe("mapped");
    expect(legacyPlans).toContain(text(entry.legacyPlan));
    const check = compiled.checks.find(
      ({ check }) => check.checkId === entry.claimId
    )?.check;
    if (check === undefined) {
      throw new Error(`unmapped claim ${text(entry.claimId)}`);
    }
    expect(
      claimAssertions(check).map(({ assertionId }) => assertionId)
    ).toContain(text(entry.assertionId));
    const source = object(await json(text(list(entry.authority)[0])));
    if (entry.expectationPath !== undefined) {
      const path = text(entry.expectationPath);
      const field = path.split(".").at(-1);
      if (field === undefined) {
        throw new Error("missing expected source field");
      }
      expect(at(vectors, path)).toEqual(source[field]);
      const key = path.split(".")[2];
      if (key === undefined) {
        throw new Error("missing vector key");
      }
      const input = object(at(vectors, `$.input.${key}`));
      expect(input.rawOpaqueBytes).toEqual({
        $bytes: Buffer.from(
          list(source.rawOpaqueBytes).map((value) => {
            if (typeof value !== "number") {
              throw new TypeError("expected a byte");
            }
            return value;
          })
        ).toString("hex"),
      });
      for (const record of ["turnTreeSchemaRecord", "turnNodeIdentityRecord"]) {
        expect(input[`${record}Bytes`]).toEqual({
          $bytes: source[`${record}CborHex`],
        });
      }
      continue;
    }
    {
      const name = text(entry.claimId).replace("kernel.codec.decode.", "");
      const sourceCase = object(object(source.cases)[name]);
      expect(at(vectors, `$.input.${name}.bytes`)).toEqual({
        $bytes: Buffer.from(
          list(sourceCase.cborBytes).map((value) => {
            if (typeof value !== "number") {
              throw new TypeError("expected a byte");
            }
            return value;
          })
        ).toString("hex"),
      });
      expect(entry.reason).toBe(sourceCase.description);
    }
  }
});
