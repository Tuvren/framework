import { expect, test } from "bun:test";

import {
  controlOutcomes,
  controlRunId,
  matchesControlRun,
} from "./control-link.ts";
import type { VerifierDigests } from "./provenance.ts";

const verifierDigests: VerifierDigests = {
  harness: "h",
  packet: "p",
  plans: "pl",
  catalogs: "c",
  fixtures: "f",
  profiles: "pr",
  controls: "co",
  verifierAuthority: "v",
};
const typescript = {
  adapter: "typescript",
  adapterManifest: "ts-manifest",
  implementation: "ts-identity",
};
const rust = {
  adapter: "rust",
  adapterManifest: "rust-manifest",
  implementation: "rust-identity",
};
const profile = "kernel.memory";
const expected = {
  ...typescript,
  profile,
  verifierDigests,
  negativeControls: ["a", "b"],
  scopedControls: ["a", "b"],
  semanticAssertions: ["detector"],
  conditionalAssertions: ["worker"],
};

const report = (
  adapter: string,
  outcomes: string[] = ["killed", "killed"],
  branch = "worker"
) => ({
  control: {
    adapter,
    status: "pass",
    conditionalAssertions: [
      { assertionId: branch, status: "pass", when: "applied" },
    ],
    postBaseline: {
      status: "pass",
      conditionalAssertions: [
        { assertionId: branch, status: "pass", when: "applied" },
      ],
    },
  },
  counted: true,
  findings: [],
  mode: "enforcing",
  notRun: [],
  profile,
  mutants: outcomes.map((outcome, index) => ({
    mutantId: index === 0 ? "a" : "b",
    kind: "implementation",
    outcome,
    activated: outcome === "killed",
    designatedFailures: outcome === "killed" ? ["detector"] : [],
    designatedAssertionsEvaluated: ["detector"],
    ...(outcome === "unsupported" ? { reason: "not implemented" } : {}),
  })),
});

const document = (reports: ReturnType<typeof report>[]) => {
  const identity = {
    profile,
    status: "pass" as const,
    verifierDigests,
    adapters: [typescript, rust],
    outcomes: controlOutcomes(reports),
  };
  return { reports, controlRun: { ...identity, id: controlRunId(identity) } };
};

test("only the matching implementation's report and kills satisfy its link", () => {
  for (const outcome of ["invalid", "unsupported", "survived"]) {
    const data = document([
      report(typescript.adapter),
      report(rust.adapter, ["killed", outcome]),
    ]);
    expect(matchesControlRun(data, expected)).toBe(data.controlRun.id);
    expect(matchesControlRun(data, { ...expected, ...rust })).toBeUndefined();
  }
  const borrowed = document([
    report(typescript.adapter, ["killed", "survived"]),
    report(rust.adapter),
  ]);
  expect(matchesControlRun(borrowed, expected)).toBeUndefined();
  const missing = document([report(rust.adapter)]);
  expect(matchesControlRun(missing, expected)).toBeUndefined();
  const duplicate = document([
    report(typescript.adapter),
    report(typescript.adapter),
  ]);
  expect(matchesControlRun(duplicate, expected)).toBeUndefined();
});

test("per-implementation control runs select only their own report", () => {
  const tsReport = report(typescript.adapter);
  const rustReport = report(rust.adapter, ["killed", "unsupported"]);
  const tsIdentity = {
    profile,
    status: "pass" as const,
    verifierDigests,
    adapters: [typescript],
    outcomes: controlOutcomes([tsReport]),
  };
  const rustIdentity = {
    profile,
    status: "fail" as const,
    verifierDigests,
    adapters: [rust],
    outcomes: controlOutcomes([rustReport]),
  };
  const data = {
    reports: [tsReport, rustReport],
    controlRuns: [
      { ...tsIdentity, id: controlRunId(tsIdentity) },
      { ...rustIdentity, id: controlRunId(rustIdentity) },
    ],
  };
  expect(matchesControlRun(data, expected)).toBe(controlRunId(tsIdentity));
  expect(matchesControlRun(data, { ...expected, ...rust })).toBeUndefined();
  expect(
    matchesControlRun(
      { ...data, controlRuns: [...data.controlRuns, data.controlRuns[0]] },
      expected
    )
  ).toBeUndefined();
});

test("links are bound to identity, manifest, profile, authority and both baselines", () => {
  const data = document([report(typescript.adapter), report(rust.adapter)]);
  expect(matchesControlRun(data, expected)).toBe(data.controlRun.id);
  for (const changed of [
    { ...expected, adapter: "other" },
    { ...expected, implementation: "memory-substitution" },
    { ...expected, adapterManifest: "other" },
    { ...expected, profile: "kernel.process-crash" },
    ...Object.keys(verifierDigests).map((key) => ({
      ...expected,
      verifierDigests: { ...verifierDigests, [key]: "changed" },
    })),
  ])
    expect(matchesControlRun(data, changed)).toBeUndefined();
  const noPost = report(typescript.adapter);
  Reflect.deleteProperty(noPost.control, "postBaseline");
  expect(matchesControlRun(document([noPost]), expected)).toBeUndefined();
  const failedPost = report(typescript.adapter);
  failedPost.control.postBaseline.status = "fail";
  expect(matchesControlRun(document([failedPost]), expected)).toBeUndefined();
  const tampered = document([report(typescript.adapter)]);
  tampered.reports[0]?.mutants.pop();
  expect(matchesControlRun(tampered, expected)).toBeUndefined();
});

test("the observed selected branch must pass on both baselines; the other branch is unnecessary", () => {
  for (const branch of ["worker", "shared"]) {
    const data = document([
      report(typescript.adapter, ["killed", "killed"], branch),
    ]);
    expect(
      matchesControlRun(data, { ...expected, conditionalAssertions: [branch] })
    ).toBe(data.controlRun.id);
    expect(
      matchesControlRun(data, {
        ...expected,
        conditionalAssertions: [branch === "worker" ? "shared" : "worker"],
      })
    ).toBeUndefined();
  }
});

test("only published testkit links require an in-process control statement", () => {
  const own = report(typescript.adapter);
  const data = document([own]);
  expect(matchesControlRun(data, expected)).toBe(data.controlRun.id);
  expect(
    matchesControlRun(data, { ...expected, publishedTestkit: true })
  ).toBeUndefined();
  const inProcess = {
    ...own,
    control: { ...own.control, execution: "in-process" },
  };
  const disclosed = document([inProcess]);
  expect(
    matchesControlRun(disclosed, { ...expected, publishedTestkit: true })
  ).toBe(disclosed.controlRun.id);
});
