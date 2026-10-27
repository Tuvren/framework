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

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import type {
  ConformanceCheckResult,
  ConformanceFailureClassification,
} from "../../scripts/lib/conformance-contract.ts";
import { classifyMutantRun, runNegativeControls } from "./negative-controls.ts";
import type {
  HarnessRun,
  MutantReport,
  NegativeControlPortConfig,
  NegativeControlReport,
} from "./negative-controls.ts";

const FIXTURE_ADAPTER = nodePath.resolve(
  import.meta.dirname,
  "fixtures/synthetic-mutant-adapter.ts"
);
const MUTANT_ENV = "SYNTHETIC_NEGATIVE_CONTROL_MUTANT";
const ALPHA = "synthetic.alpha_check.1.resultField";
const BETA = "synthetic.beta_check.1.resultField";
const GAMMA = "synthetic.gamma_check.1.resultField";

let directory = "";
let logDirectory = "";

const fieldCheck = (field: string, equals: number, capability?: string) => ({
  assertions: [{ equals, field: `$.${field}`, kind: "resultField" }],
  ...(capability === undefined ? {} : { capabilities: [capability] }),
  checkId: `synthetic.${field}_check`,
  evidence: [field],
  operation: `synthetic.${field}`,
});

const implementation = (mutantId: string, designated: string[]) => ({
  activation: { precondition: "synthetic", signal: `${mutantId}.entered` },
  claimIds: ["synthetic.claim"],
  designatedAssertions: designated,
  kind: "implementation",
  mutantId,
  profiles: ["synthetic.profile"],
  rule: "synthetic",
});

const adapterManifest = (adapterId: string, extra: string[]) => ({
  adapterId,
  authorityPackets: [nodePath.join(directory, "packet.json")],
  boundary: "shared",
  capabilities: ["synthetic.core"],
  command: ["bun", FIXTURE_ADAPTER, "--adapter-id", adapterId, ...extra],
  implementationId: adapterId,
  language: "typescript",
  protocol: {
    name: "tuvren.conformance-adapter",
    transport: "json-rpc-2.0-stdio",
    version: "0.1.0",
  },
  suiteId: "tuvren.synthetic",
  suiteVersion: "0.1.0",
});

let report: NegativeControlReport;
let brokenReport: NegativeControlReport;

const writeJson = async (name: string, value: unknown): Promise<string> => {
  const file = nodePath.join(directory, name);
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
  return file;
};

const config = (controlAdapter: string): NegativeControlPortConfig => ({
  activationOperation: "synthetic.mutant.activation",
  controlAdapter,
  mutantAdapter: nodePath.join(directory, "adapter-mutant.json"),
  mutantEnv: MUTANT_ENV,
  packet: nodePath.join(directory, "packet.json"),
  port: "synthetic",
  profile: "synthetic.profile",
});

const mutant = (mutantId: string): MutantReport => {
  const entry = report.mutants.find((item) => item.mutantId === mutantId);
  if (entry === undefined) {
    throw new Error(`report omits ${mutantId}`);
  }
  return entry;
};

beforeAll(async () => {
  directory = await mkdtemp(nodePath.join(tmpdir(), "tuvren-negative-"));
  const plan = await writeJson("plan.json", {
    applicability: { capabilities: ["synthetic.core"] },
    checks: [
      fieldCheck("alpha", 1),
      fieldCheck("beta", 2),
      fieldCheck("gamma", 3, "synthetic.missing"),
    ],
    packetId: "tuvren.synthetic",
    planId: "tuvren.synthetic.plan",
    planVersion: "0.1.0",
  });
  const manifest = await writeJson("negative-controls.json", {
    controls: [
      implementation("synthetic.crash-at-startup", [ALPHA]),
      implementation("synthetic.wrong-alpha", [ALPHA]),
      implementation("synthetic.dormant", [ALPHA]),
      implementation("synthetic.beta-only", [ALPHA]),
      implementation("synthetic.alpha-and-beta", [ALPHA]),
      implementation("synthetic.gamma-gated", [GAMMA]),
      {
        activation: {
          precondition: "synthetic",
          signal: "synthetic.instrumentation.entered",
        },
        claimIds: ["synthetic.claim"],
        expectedRejection: "missing_fault_activation",
        kind: "instrumentation",
        mutantId: "synthetic.instrumentation",
        profiles: ["synthetic.profile"],
        rule: "synthetic",
      },
      {
        ...implementation("synthetic.other-profile", [ALPHA]),
        profiles: ["synthetic.other"],
      },
    ],
  });
  await writeJson("packet.json", {
    conformancePlans: [
      { path: plan, planId: "tuvren.synthetic.plan", planVersion: "0.1.0" },
    ],
    negativeControlManifest: manifest,
    packetId: "tuvren.synthetic",
  });
  const control = await writeJson(
    "adapter.json",
    adapterManifest("synthetic", [])
  );
  const broken = await writeJson(
    "adapter-broken.json",
    adapterManifest("synthetic", ["--broken"])
  );
  await writeJson(
    "adapter-mutant.json",
    adapterManifest("synthetic-mutant", ["--mutant-env", MUTANT_ENV])
  );
  logDirectory = nodePath.join(directory, "verification-logs");
  report = await runNegativeControls(config(control), { logDirectory });
  brokenReport = await runNegativeControls(config(broken), { logDirectory });
}, 120_000);

afterAll(async () => {
  if (directory.length > 0) {
    await rm(directory, { force: true, recursive: true });
  }
});

describe("negative-control runner", () => {
  test("uses generic or configured reasons for unsupported mutants", async () => {
    for (const reason of [
      undefined,
      "synthetic port has no reproduction; not run",
    ]) {
      const limited = await runNegativeControls(
        {
          ...config(nodePath.join(directory, "adapter.json")),
          mutants: [],
          ...(reason === undefined
            ? {}
            : { unsupportedReasons: { "synthetic.wrong-alpha": reason } }),
        },
        { logDirectory, mutants: ["synthetic.wrong-alpha"] }
      );
      expect(limited.mutants[0]).toMatchObject({
        outcome: "unsupported",
        reason:
          reason ??
          "mutant is not supported by this port configuration; not run",
      });
    }
  });

  test("counts mutants only after the unmutated control passes", () => {
    expect(report.control.status).toBe("pass");
    expect(report.counted).toBe(true);
    expect(report.findings).toEqual([]);
  });

  test("classifies a mutant that crashes at startup as invalid", () => {
    expect(mutant("synthetic.crash-at-startup")).toMatchObject({
      activated: false,
      outcome: "invalid",
    });
  });

  test("kills an activated mutant whose designated assertion fails", () => {
    expect(mutant("synthetic.wrong-alpha")).toMatchObject({
      activated: true,
      collateral: { assertions: [], count: 0 },
      designatedFailures: [ALPHA],
      outcome: "killed",
    });
  });

  test("does not count a mutant that never activated", () => {
    const dormant = mutant("synthetic.dormant");

    expect(dormant.activated).toBe(false);
    expect(dormant.outcome).not.toBe("killed");
    expect(dormant.outcome).not.toBe("survived");
  });

  test("lists failures outside the designated set as collateral, never as kills", () => {
    expect(mutant("synthetic.beta-only")).toMatchObject({
      activated: true,
      collateral: { count: 1 },
      designatedFailures: [],
      outcome: "survived",
    });
    expect(
      mutant("synthetic.beta-only").collateral.assertions.map(
        ({ assertionId }) => assertionId
      )
    ).toEqual([BETA]);
    expect(mutant("synthetic.alpha-and-beta")).toMatchObject({
      collateral: { count: 1 },
      designatedFailures: [ALPHA],
      outcome: "killed",
    });
  });

  test("classifies a capability gap on every designated check as invalid", () => {
    expect(mutant("synthetic.gamma-gated").outcome).toBe("invalid");
  });

  test("never counts an instrumentation control as killed without the expected runner rejection", () => {
    const instrumentation = mutant("synthetic.instrumentation");

    expect(instrumentation.activated).toBe(true);
    expect(instrumentation.outcome).not.toBe("killed");
    expect(instrumentation.reason).toContain("missing_fault_activation");
  });

  test("does not run a control outside the configured profile", () => {
    expect(mutant("synthetic.other-profile")).toMatchObject({
      activated: false,
      outcome: "unsupported",
    });
  });

  test("totals each outcome once per mutant", () => {
    expect(report.totals).toEqual({
      activated: 4,
      equivalent: 0,
      invalid: 2,
      killed: 2,
      survived: 2,
      unsupported: 2,
    });
  });

  test("retains failure artifacts whose replays outlive the work directory", async () => {
    const killed = mutant("synthetic.wrong-alpha");
    const mutantAdapter = nodePath.join(directory, "adapter-mutant.json");
    const artifacts = killed.artifacts ?? [];

    expect(artifacts.length).toBeGreaterThan(0);
    expect(killed.replay).toContain(`--adapter ${mutantAdapter} `);

    for (const file of artifacts) {
      expect(file.startsWith(logDirectory)).toBe(true);
      const retained = JSON.parse(await readFile(file, "utf-8")) as {
        checkResults: { failure?: { replay: string } }[];
      };
      const replays = retained.checkResults.flatMap(({ failure }) =>
        failure === undefined ? [] : [failure.replay]
      );

      expect(replays.length).toBeGreaterThan(0);
      for (const replay of replays) {
        expect(replay).toStartWith(
          `${MUTANT_ENV}=synthetic.wrong-alpha bun tools/conformance/harness/run.ts --adapter ${mutantAdapter} `
        );
        expect(replay).not.toContain("tuvren-negative-controls-");
      }
    }

    const controlArtifacts = brokenReport.control.artifacts ?? [];
    expect(controlArtifacts.length).toBeGreaterThan(0);
    await Promise.all(controlArtifacts.map(async (file) => await access(file)));
  });

  test("records a failing unmutated control as a finding and counts no mutant", () => {
    expect(brokenReport.control.status).toBe("fail");
    expect(brokenReport.counted).toBe(false);
    expect(brokenReport.findings.length).toBeGreaterThan(0);
    expect(brokenReport.mutants).toEqual([]);
    expect(brokenReport.totals.killed).toBe(0);
  });
});

describe("mutant run classification", () => {
  const MUTANT = "synthetic.mixed";

  const failedCheck = (
    check: string,
    classification: ConformanceFailureClassification
  ): ConformanceCheckResult => ({
    assertionResults: [
      { assertionId: `synthetic.${check}_check.1.resultField`, status: "fail" },
    ],
    checkId: `synthetic.${check}_check`,
    failure: { classification, replay: "replay" },
    status: "fail",
  });

  const activatedRun = (
    checkResults: ConformanceCheckResult[]
  ): HarnessRun => ({
    activations: [
      {
        activated: true,
        activationCount: 1,
        mutantId: MUTANT,
        signal: `${MUTANT}.entered`,
      },
    ],
    evidence: {
      boundary: "shared",
      checkResults,
      implementationId: "synthetic-mutant",
      language: "typescript",
      status: "fail",
      suiteId: "tuvren.synthetic",
      suiteVersion: "0.1.0",
      summary: {
        failedChecks: checkResults.length,
        passedChecks: 0,
        totalChecks: checkResults.length,
      },
    },
    unanswered: [],
  });

  const control = {
    activation: { signal: `${MUTANT}.entered` },
    claimIds: ["synthetic.claim"],
    designatedAssertions: [ALPHA],
    kind: "implementation",
    mutantId: MUTANT,
    profiles: ["synthetic.profile"],
  };

  test.each(["adapter_protocol", "environment", "verification"] as const)(
    "invalidates a designated kill when another check failed with %s",
    (classification) => {
      const classified = classifyMutantRun(
        control,
        activatedRun([
          failedCheck("alpha", "implementation"),
          failedCheck("beta", classification),
        ])
      );

      expect(classified.outcome).toBe("invalid");
      expect(classified.reason).toContain(
        `synthetic.beta_check: ${classification}`
      );
    }
  );

  test("keeps unrelated implementation failures as collateral of a kill", () => {
    expect(
      classifyMutantRun(
        control,
        activatedRun([
          failedCheck("alpha", "implementation"),
          failedCheck("beta", "implementation"),
        ])
      )
    ).toMatchObject({
      collateral: { count: 1 },
      designatedFailures: [ALPHA],
      outcome: "killed",
    });
  });
  test.each(["missing_fault_activation", "unexpected_rejection"])(
    "instrumentation requires its designated rejection: %s",
    (code) => {
      const check = {
        ...failedCheck("alpha", "verification"),
        details: { experimentStatus: "invalid", rejection: { code } },
      };
      const instrumentation = {
        ...control,
        kind: "instrumentation",
        expectedRejection: "missing_fault_activation",
      };
      expect(
        classifyMutantRun(instrumentation, activatedRun([check])).outcome
      ).toBe(code === "missing_fault_activation" ? "killed" : "invalid");
    }
  );
  test("instrumentation rejection is not a kill without mutant activation", () => {
    const run = activatedRun([
      {
        ...failedCheck("alpha", "verification"),
        details: { rejection: { code: "missing_fault_activation" } },
      },
    ]);
    run.activations = run.activations.map((activation) => ({
      ...activation,
      activated: false,
      activationCount: 0,
    }));
    expect(
      classifyMutantRun(
        {
          ...control,
          kind: "instrumentation",
          expectedRejection: "missing_fault_activation",
        },
        run
      ).outcome
    ).toBe("unsupported");
  });
});
