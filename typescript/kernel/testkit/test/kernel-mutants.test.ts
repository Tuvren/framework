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
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { RuntimeBackend } from "@tuvren/kernel-protocol";
import {
  decodeDeterministicKernelRecord,
  hashOpaqueObjectBytes,
} from "@tuvren/kernel-protocol";
import Ajv2020 from "ajv/dist/2020.js";

import type {
  FaultInjectingBackendFactory,
  KernelMutantCodec,
} from "../src/index.ts";
import { listKernelMutants, selectKernelMutant } from "../src/index.ts";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const MANIFEST_PATH = "spec/conformance/kernel/negative-controls.json";
const PACKET_PATH = "spec/kernel/authority-packet.json";
const SCHEMA_PATH = "tools/schemas/negative-control-manifest.schema.json";
const PLANS_DIRECTORY = "spec/conformance/kernel/plans";
const KERNEL_SPEC_PATH = "docs/KrakenKernelSpecification.md";
const ADR_DIRECTORY = ".constitution/tech-spec/adrs";

const EXPECTED_MUTANTS = [
  ["kernel.accept-noncanonical-cbor", "implementation"],
  ["kernel.accept-stale-head-update", "implementation"],
  ["kernel.accept-stale-owner-after-takeover", "implementation"],
  ["kernel.delete-object-reachable-through-live-root", "implementation"],
  ["kernel.drop-uncommitted-staged-result-on-recovery", "implementation"],
  ["kernel.fault-seam-never-fires", "instrumentation"],
  ["kernel.lease-takeover-before-expiry", "implementation"],
  ["kernel.never-sweep-eligible-objects", "implementation"],
  ["kernel.noncanonical-changed-paths-order", "implementation"],
  ["kernel.promote-staged-before-checkpoint", "implementation"],
  ["kernel.resolve-object-across-scopes", "implementation"],
  ["kernel.sweep-inside-grace-window", "implementation"],
  ["kernel.wrong-opaque-object-hash", "implementation"],
] as const;

interface ManifestControl {
  activation: { precondition: string; signal: string };
  claimIds: string[];
  designatedAssertions?: string[];
  expectedRejection?: string;
  kind: string;
  mutantId: string;
  profiles: string[];
  rule: string;
}

interface PlanCheck {
  assertions: { kind: string }[];
  checkId: string;
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

const readOptionalStrings = (value: unknown): string[] | undefined =>
  value === undefined ? undefined : readStrings(value);

const readOptionalString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const readControl = (value: Record<string, unknown>): ManifestControl => {
  const activation = isRecord(value.activation) ? value.activation : {};
  const designatedAssertions = readOptionalStrings(value.designatedAssertions);
  const expectedRejection = readOptionalString(value.expectedRejection);
  return {
    activation: {
      precondition: String(activation.precondition),
      signal: String(activation.signal),
    },
    claimIds: readStrings(value.claimIds),
    ...(designatedAssertions === undefined ? {} : { designatedAssertions }),
    ...(expectedRejection === undefined ? {} : { expectedRejection }),
    kind: String(value.kind),
    mutantId: String(value.mutantId),
    profiles: readStrings(value.profiles),
    rule: String(value.rule),
  };
};

const readControls = (): ManifestControl[] => {
  const manifest = readJson(MANIFEST_PATH);
  if (!(isRecord(manifest) && Array.isArray(manifest.controls))) {
    throw new Error(`${MANIFEST_PATH} must declare controls`);
  }
  return readRecords(manifest.controls).map(readControl);
};

const readPlanChecks = (): Map<string, PlanCheck> => {
  const checks = new Map<string, PlanCheck>();
  for (const file of readdirSync(path.join(REPO_ROOT, PLANS_DIRECTORY))) {
    const plan = readJson(path.join(PLANS_DIRECTORY, file));
    for (const check of readRecords(isRecord(plan) ? plan.checks : [])) {
      checks.set(String(check.checkId), {
        assertions: readRecords(check.assertions).map((assertion) => ({
          kind: String(assertion.kind),
        })),
        checkId: String(check.checkId),
      });
    }
  }
  return checks;
};

const ASSERTION_ID = /^(?<checkId>.+)\.(?<index>\d+)\.(?<kind>[A-Za-z]+)$/u;

const parseAssertionId = (
  assertionId: string
): { checkId: string; index: number; kind: string } => {
  const groups = ASSERTION_ID.exec(assertionId)?.groups;
  if (
    groups?.checkId === undefined ||
    groups.index === undefined ||
    groups.kind === undefined
  ) {
    throw new Error(`malformed designated assertion ${assertionId}`);
  }
  return {
    checkId: groups.checkId,
    index: Number(groups.index),
    kind: groups.kind,
  };
};

const slugHeading = (heading: string): string =>
  heading
    .trim()
    .toLowerCase()
    .replaceAll(/[^\p{Letter}\p{Number}\s-]/gu, "")
    .replaceAll(/\s/gu, "-");

const readKernelSpecAnchors = (): Set<string> =>
  new Set(
    readFileSync(path.join(REPO_ROOT, KERNEL_SPEC_PATH), "utf-8")
      .split("\n")
      .filter((line) => line.startsWith("#"))
      .map((line) => slugHeading(line.replace(/^#+/u, "")))
  );

const ruleResolves = (rule: string, anchors: ReadonlySet<string>): boolean => {
  if (rule.startsWith(`${KERNEL_SPEC_PATH}#`)) {
    return anchors.has(rule.slice(KERNEL_SPEC_PATH.length + 1));
  }
  if (/^ADR-\d{4}$/u.test(rule)) {
    return readdirSync(path.join(REPO_ROOT, ADR_DIRECTORY)).some((file) =>
      file.startsWith(`${rule}-`)
    );
  }
  return false;
};

const referenceCodec: KernelMutantCodec = {
  decodeDeterministicKernelRecord,
  hashOpaqueObjectBytes,
};

const unreachable = (): never => {
  throw new Error("fake backend member must not be called");
};

const fakeBackend: RuntimeBackend = {
  capabilities: () => ({ "thread.enumeration": false }),
  health: unreachable,
  transact: unreachable,
};

const referenceFaultFactory: FaultInjectingBackendFactory = (inner) => inner;

describe("kernel mutant registry", () => {
  test("registers exactly the memory-applicable ADR-0079 mutant set", () => {
    expect(
      listKernelMutants().map(({ kind, mutantId }) => [mutantId, kind])
    ).toEqual(EXPECTED_MUTANTS.map(([mutantId, kind]) => [mutantId, kind]));
  });

  test("rejects an unknown mutant id", () => {
    expect(() => selectKernelMutant("kernel.no-such-mutant")).toThrow(
      "unknown kernel mutant kernel.no-such-mutant"
    );
  });

  test("a selection starts with no recorded activation", () => {
    for (const { mutantId, kind, signal } of listKernelMutants()) {
      expect(selectKernelMutant(mutantId).readActivation()).toEqual({
        activated: false,
        activationCount: 0,
        kind,
        mutantId,
        signal,
      });
    }
  });

  test("only the selected mutant's seams alter the wrapped reference", () => {
    for (const { mutantId } of listKernelMutants()) {
      const mutant = selectKernelMutant(mutantId);
      const { seams } = mutant;
      expect(seams.length).toBeGreaterThan(0);
      expect(mutant.wrapCodec(referenceCodec) === referenceCodec).toBe(
        !seams.includes("codec")
      );
      expect(mutant.wrapBackend(fakeBackend) === fakeBackend).toBe(
        !seams.includes("backend")
      );
      expect(
        mutant.wrapFaultInjection(referenceFaultFactory) ===
          referenceFaultFactory
      ).toBe(!seams.includes("faultInjection"));
    }
  });

  test("the wrong-hash mutant alters opaque hashes and records activation", async () => {
    const bytes = new TextEncoder().encode("opaque");
    const selected = selectKernelMutant("kernel.wrong-opaque-object-hash");
    const other = selectKernelMutant("kernel.accept-noncanonical-cbor");
    const mutated = selected.wrapCodec(referenceCodec);

    expect(await mutated.hashOpaqueObjectBytes(bytes)).not.toBe(
      await hashOpaqueObjectBytes(bytes)
    );
    expect(
      await other.wrapCodec(referenceCodec).hashOpaqueObjectBytes(bytes)
    ).toBe(await hashOpaqueObjectBytes(bytes));
    expect(selected.readActivation().activationCount).toBe(1);
    expect(other.readActivation().activated).toBe(false);
  });

  test("the noncanonical-CBOR mutant accepts exactly a non-minimal integer head", () => {
    const selected = selectKernelMutant("kernel.accept-noncanonical-cbor");
    const mutated = selected.wrapCodec(referenceCodec);

    expect(mutated.decodeDeterministicKernelRecord(Uint8Array.of(24, 5))).toBe(
      5
    );
    expect(selected.readActivation().activationCount).toBe(1);
    expect(() =>
      mutated.decodeDeterministicKernelRecord(Uint8Array.of(152, 1, 0))
    ).toThrow();
    expect(mutated.decodeDeterministicKernelRecord(Uint8Array.of(5))).toBe(5);
    expect(selected.readActivation().activationCount).toBe(1);
  });

  test("activation counts are private to one selection", async () => {
    const first = selectKernelMutant("kernel.wrong-opaque-object-hash");
    const second = selectKernelMutant("kernel.wrong-opaque-object-hash");

    await first
      .wrapCodec(referenceCodec)
      .hashOpaqueObjectBytes(Uint8Array.of(1));

    expect(first.readActivation().activationCount).toBe(1);
    expect(second.readActivation().activationCount).toBe(0);
  });

  test("the fault-seam mutant disarms every fault plan it receives", () => {
    const selected = selectKernelMutant("kernel.fault-seam-never-fires");
    let armed = 0;
    const factory: FaultInjectingBackendFactory = (inner) => {
      armed += 1;
      return inner;
    };

    const backend = selected.wrapFaultInjection(factory)(fakeBackend, {
      point: "before-commit",
      policy: "once",
    });

    expect(backend).toBe(fakeBackend);
    expect(armed).toBe(0);
    expect(selected.readActivation().activationCount).toBe(1);
  });
});

describe("kernel negative-control manifest", () => {
  test("validates against the pinned negative-control manifest schema", () => {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    const schema = readJson(SCHEMA_PATH);
    if (!isRecord(schema)) {
      throw new Error(`${SCHEMA_PATH} must be a JSON Schema object`);
    }
    const validate = ajv.compile(schema);
    const valid = validate(readJson(MANIFEST_PATH));

    expect(validate.errors ?? []).toEqual([]);
    expect(valid).toBe(true);
  });

  test("maps every control one-to-one onto a registered mutant", () => {
    const controls = readControls();
    const registered = new Map(
      listKernelMutants().map((mutant) => [mutant.mutantId, mutant])
    );

    expect(controls.map((control) => control.mutantId).toSorted()).toEqual(
      [...registered.keys()].toSorted()
    );
    for (const control of controls) {
      const mutant = registered.get(control.mutantId);
      expect(control.kind).toBe(mutant?.kind ?? "unregistered");
      expect(control.activation.signal).toBe(mutant?.signal ?? "unregistered");
      expect(control.activation.precondition.length).toBeGreaterThan(0);
      expect(control.profiles).toEqual(["kernel.memory"]);
    }
  });

  test("cites a resolvable authority rule for every control", () => {
    const anchors = readKernelSpecAnchors();
    for (const control of readControls()) {
      expect({
        mutantId: control.mutantId,
        resolves: ruleResolves(control.rule, anchors),
      }).toEqual({
        mutantId: control.mutantId,
        resolves: true,
      });
    }
  });

  test("implementation controls designate current plan assertions that their claims cover", () => {
    const checks = readPlanChecks();
    for (const control of readControls().filter(
      (entry) => entry.kind === "implementation"
    )) {
      expect(control.expectedRejection).toBeUndefined();
      expect(control.designatedAssertions?.length ?? 0).toBeGreaterThan(0);
      for (const assertionId of control.designatedAssertions ?? []) {
        const { checkId, index, kind } = parseAssertionId(assertionId);
        const check = checks.get(checkId);
        expect({
          assertionId,
          kind: check?.assertions[index - 1]?.kind,
        }).toEqual({
          assertionId,
          kind,
        });
        expect(control.claimIds).toContain(checkId);
      }
      for (const claimId of control.claimIds) {
        expect(checks.has(claimId)).toBe(true);
      }
    }
  });

  test("instrumentation controls expect the missing fault-activation rejection", () => {
    const checks = readPlanChecks();
    const instrumentation = readControls().filter(
      (entry) => entry.kind !== "implementation"
    );

    expect(instrumentation.map((control) => control.mutantId)).toEqual([
      "kernel.fault-seam-never-fires",
    ]);
    for (const control of instrumentation) {
      expect(control.kind).toBe("instrumentation");
      expect(control.designatedAssertions).toBeUndefined();
      expect(control.expectedRejection).toBe("missing_fault_activation");
      for (const claimId of control.claimIds) {
        expect(checks.has(claimId)).toBe(true);
      }
    }
  });

  test("the kernel authority packet references the manifest", () => {
    const packet = readJson(PACKET_PATH);
    expect(isRecord(packet) ? packet.negativeControlManifest : undefined).toBe(
      MANIFEST_PATH
    );
  });
});

const listPackageManifests = (directory: string): string[] =>
  readdirSync(directory).flatMap((entry) => {
    if (entry === "node_modules" || entry === "dist") {
      return [];
    }
    const entryPath = path.join(directory, entry);
    if (statSync(entryPath).isDirectory()) {
      return listPackageManifests(entryPath);
    }
    return entry === "package.json" ? [entryPath] : [];
  });

const listSourceFiles = (directory: string): string[] =>
  existsSync(directory)
    ? readdirSync(directory, { recursive: true, withFileTypes: true })
        .filter(
          (entry) => entry.isFile() && /\.[cm]?[jt]sx?$/u.test(entry.name)
        )
        .map((entry) => path.join(entry.parentPath, entry.name))
    : [];

describe("mutant containment", () => {
  test("no production package depends on or imports the mutant registry", () => {
    const productionPackages = listPackageManifests(
      path.join(REPO_ROOT, "typescript")
    ).flatMap((manifestPath) => {
      const manifest: unknown = JSON.parse(readFileSync(manifestPath, "utf-8"));
      return isRecord(manifest) && manifest.private !== true
        ? [{ directory: path.dirname(manifestPath), manifest }]
        : [];
    });

    expect(productionPackages.length).toBeGreaterThan(0);
    const offenders = productionPackages.flatMap(({ directory, manifest }) => [
      ...["dependencies", "optionalDependencies", "peerDependencies"]
        .filter((field) => {
          const deps = manifest[field];
          return isRecord(deps) && "@tuvren/kernel-testkit" in deps;
        })
        .map((field) => `${directory} ${field}`),
      ...listSourceFiles(path.join(directory, "src")).filter((file) => {
        const source = readFileSync(file, "utf-8");
        return (
          source.includes("@tuvren/kernel-testkit") ||
          source.includes("kernel-mutant")
        );
      }),
    ]);

    expect(offenders).toEqual([]);
  });
});
