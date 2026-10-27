#!/usr/bin/env bun
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

import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import process from "node:process";

import {
  collectCertificationIntegrityFailures,
  validateCertificationDocument,
} from "../../scripts/conformance/certification-schemas.ts";
import { assertConformanceEvidence } from "../../scripts/lib/conformance-contract.ts";
import type {
  ConformanceEvidence,
  ConformanceEvidenceSummary,
  ConformanceRunStatus,
} from "../../scripts/lib/conformance-contract.ts";
import { createVerificationLogs } from "../../scripts/lib/verification-logs.ts";
import type { VerificationLogs } from "../../scripts/lib/verification-logs.ts";
import {
  controlOutcomes,
  controlRunId,
} from "../certification/control-link.ts";
import {
  computeImplementationDigest,
  computeVerifierDigests,
  digestAdapterManifest,
} from "../certification/provenance.ts";
import {
  readAdapterManifest as readValidatedAdapterManifest,
  readPlans,
} from "../harness/run-plans.ts";
import {
  assertClaimCoverage,
  assertConditionalBranchCoverage,
  assertNegativeControlGate,
  claimAssertions,
  profileConditionalAssertions,
} from "./claim-coverage.ts";

/** One port's negative-control wiring (ADR-0079 decisions 1 to 3). */
export interface NegativeControlPortConfig {
  activationOperation: string;
  capabilities?: readonly string[];
  mutants?: readonly string[];
  unsupportedReasons?: Readonly<Record<string, string>>;
  undetectedReasons?: string;
  /** The certifying adapter whose unmutated run must pass first. */
  controlAdapter: string;
  mutantAdapter: string;
  mutantEnv: string;
  packet: string;
  port: string;
  profile: string;
}

export const NEGATIVE_CONTROL_PORTS: readonly NegativeControlPortConfig[] = [
  {
    activationOperation: "kernel.mutant.activation",
    controlAdapter: "typescript/kernel/conformance-adapter/adapter.json",
    mutantAdapter: "typescript/kernel/conformance-adapter/adapter-mutant.json",
    mutantEnv: "TUVREN_KERNEL_MUTANT",
    packet: "spec/kernel/authority-packet.json",
    port: "kernel",
    profile: "kernel.memory",
    undetectedReasons: "spec/conformance/kernel/kernel-memory-undetected.json",
  },
  {
    activationOperation: "kernel.mutant.activation",
    controlAdapter: "rust/kernel-conformance-adapter/adapter.json",
    mutantAdapter: "rust/kernel-conformance-adapter/adapter-mutant.json",
    mutantEnv: "TUVREN_KERNEL_MUTANT",
    mutants: [
      "kernel.wrong-opaque-object-hash",
      "kernel.drop-uncommitted-staged-result-on-recovery",
      "kernel.delete-object-reachable-through-live-root",
    ],
    unsupportedReasons: {
      "kernel.accept-noncanonical-cbor": "no Rust reproduction yet; not run",
      "kernel.accept-stale-head-update": "no Rust reproduction yet; not run",
      "kernel.accept-stale-owner-after-takeover":
        "no Rust reproduction yet; not run",
      "kernel.fault-seam-never-fires": "no Rust reproduction yet; not run",
      "kernel.lease-takeover-before-expiry":
        "no Rust reproduction yet; not run",
      "kernel.never-sweep-eligible-objects":
        "no Rust reproduction yet; not run",
      "kernel.noncanonical-changed-paths-order":
        "no Rust reproduction yet; not run",
      "kernel.promote-staged-before-checkpoint":
        "no Rust reproduction yet; not run",
      "kernel.resolve-object-across-scopes":
        "no shared-substrate construction seam in the Rust kernel; not run",
      "kernel.sweep-inside-grace-window": "no Rust reproduction yet; not run",
    },
    packet: "spec/kernel/authority-packet.json",
    port: "kernel",
    profile: "kernel.memory",
    undetectedReasons: "spec/conformance/kernel/kernel-memory-undetected.json",
  },
];

export type NegativeControlOutcome =
  | "equivalent"
  | "invalid"
  | "killed"
  | "survived"
  | "unsupported";

export interface CollateralFailure {
  assertionId: string;
  checkId: string;
  classification?: string;
}

export interface MutantReport {
  activated: boolean;
  activationCount: number;
  /** Retained harness failure artifacts, with replays against the real manifest. */
  artifacts?: string[];
  collateral: { assertions: CollateralFailure[]; count: number };
  designatedFailures: string[];
  expectedRejection?: string;
  kind: string;
  mutantId: string;
  outcome: NegativeControlOutcome;
  reason?: string;
  replay?: string;
  summary?: ConformanceEvidenceSummary;
}

export interface NegativeControlReport {
  control: {
    adapter: string;
    artifacts?: string[];
    failedChecks?: string[];
    reason?: string;
    status: ConformanceRunStatus | "error";
    summary?: ConformanceEvidenceSummary;
    conditionalAssertions?: readonly {
      assertionId: string;
      status: string;
      when?: string;
    }[];
  };
  counted: boolean;
  findings: string[];
  manifest: string;
  mode: "enforcing" | "report";
  mutantAdapter: string;
  mutants: MutantReport[];
  notRun: string[];
  packet: string;
  port: string;
  profile: string;
  totals: Record<"activated" | NegativeControlOutcome, number>;
}

export interface NegativeControlRunOptions {
  concurrency?: number;
  /** Verification log root for retained artifacts; defaults to VERIFY_LOG_DIR. */
  logDirectory?: string;
  mutants?: readonly string[];
  timeoutMs?: number;
}

export interface ControlEntry {
  activation: { signal: string };
  claimIds: string[];
  designatedAssertions?: string[];
  expectedRejection?: string;
  kind: string;
  mutantId: string;
  profiles: string[];
}

export interface Activation {
  activated: boolean;
  activationCount: number;
  mutantId: unknown;
  signal: unknown;
}

export interface HarnessRun {
  activations: Activation[];
  artifacts?: string[];
  evidence?: ConformanceEvidence;
  failure?: string;
  unanswered: string[];
}

const REPO_ROOT = nodePath.resolve(import.meta.dirname, "../../..");
const HARNESS = "tools/conformance/harness/run.ts";
const PROBE = nodePath.join(import.meta.dirname, "activation-probe.ts");
const DEFAULT_TIMEOUT_MS = 600_000;
const STDERR_TAIL_CHARS = 2000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const fromRoot = (path: string): string => nodePath.resolve(REPO_ROOT, path);

const display = (path: string): string => {
  const relative = nodePath.relative(REPO_ROOT, fromRoot(path));
  return relative.startsWith("..") ? fromRoot(path) : relative;
};

const readString = (value: unknown): string =>
  typeof value === "string" ? value : "";

const readStrings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];

const readControlEntries = (value: unknown): ControlEntry[] =>
  (Array.isArray(value) ? value : []).filter(isRecord).map((control) => ({
    activation: {
      signal: isRecord(control.activation)
        ? readString(control.activation.signal)
        : "",
    },
    claimIds: readStrings(control.claimIds),
    ...(control.designatedAssertions === undefined
      ? {}
      : { designatedAssertions: readStrings(control.designatedAssertions) }),
    ...(typeof control.expectedRejection === "string"
      ? { expectedRejection: control.expectedRejection }
      : {}),
    kind: readString(control.kind),
    mutantId: readString(control.mutantId),
    profiles: readStrings(control.profiles),
  }));

const readJson = async (path: string): Promise<unknown> =>
  JSON.parse(await readFile(fromRoot(path), "utf-8"));

const readControlManifest = async (
  packetPath: string
): Promise<{ controls: ControlEntry[]; path: string }> => {
  const packet = await readJson(packetPath);
  const manifestPath = isRecord(packet)
    ? packet.negativeControlManifest
    : undefined;
  if (typeof manifestPath !== "string") {
    throw new TypeError(
      `${display(packetPath)} does not reference a negativeControlManifest`
    );
  }
  const manifest = await readJson(manifestPath);
  const failures = [
    ...validateCertificationDocument("negativeControlManifest", manifest),
    ...collectCertificationIntegrityFailures(
      "negativeControlManifest",
      manifest
    ),
  ];
  if (failures.length > 0 || !isRecord(manifest)) {
    throw new Error(
      `${display(manifestPath)} is not a valid negative-control manifest: ${failures.join("; ")}`
    );
  }
  return {
    controls: readControlEntries(manifest.controls),
    path: manifestPath,
  };
};

const readProfileObligations = async (
  config: NegativeControlPortConfig,
  controls: readonly ControlEntry[]
): Promise<
  { negativeControls: string[]; conditionalAssertions: string[] } | undefined
> => {
  const packet = await readJson(config.packet);
  if (!isRecord(packet) || typeof packet.certificationProfiles !== "string") {
    return undefined;
  }
  const document = await readJson(packet.certificationProfiles);
  const failures = [
    ...validateCertificationDocument("certificationProfile", document),
    ...collectCertificationIntegrityFailures("certificationProfile", document),
  ];
  if (
    failures.length > 0 ||
    !isRecord(document) ||
    !Array.isArray(document.profiles)
  ) {
    throw new Error(`invalid certification profiles: ${failures.join("; ")}`);
  }
  const profile = document.profiles.find(
    (entry: unknown) => isRecord(entry) && entry.profileId === config.profile
  );
  if (!isRecord(profile)) {
    throw new Error(`${config.profile} is not declared by ${config.packet}`);
  }
  const reasonsValue =
    config.undetectedReasons === undefined
      ? {}
      : await readJson(config.undetectedReasons);
  if (
    !isRecord(reasonsValue) ||
    Object.values(reasonsValue).some(
      (reason) => typeof reason !== "string" || reason.trim().length === 0
    )
  ) {
    throw new Error(`${config.profile} has invalid undetected claim reasons`);
  }
  const reasons = Object.fromEntries(
    Object.entries(reasonsValue).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string"
    )
  );
  const negativeControls = readStrings(profile.negativeControls);
  const declared = controls.filter((control) =>
    control.profiles.includes(config.profile)
  );
  const unknown = negativeControls.filter(
    (id) => !declared.some((control) => control.mutantId === id)
  );
  if (unknown.length > 0) {
    throw new Error(
      `${config.profile} negative-control inventory mismatch: ${unknown.join(", ")}`
    );
  }
  const adapter = await readValidatedAdapterManifest(config.controlAdapter);
  const plans = await readPlans(adapter, {
    packets: [config.packet],
    plans: [],
  });
  const checks = plans.flatMap((plan) =>
    plan.checks.map(({ check }) => ({
      assertions: claimAssertions(check),
    }))
  );
  assertClaimCoverage(
    config.profile,
    readStrings(profile.claimIds),
    declared.filter((control) => negativeControls.includes(control.mutantId)),
    reasons,
    checks
  );
  const conditionalAssertions = profileConditionalAssertions(
    readStrings(profile.claimIds),
    plans
  );
  return { negativeControls, conditionalAssertions };
};

const readAdapterManifest = async (
  path: string
): Promise<Record<string, unknown>> => {
  const manifest = await readJson(path);
  if (!(isRecord(manifest) && Array.isArray(manifest.command))) {
    throw new TypeError(`${display(path)} must be an adapter manifest`);
  }
  return manifest;
};

const sortedStrings = (value: unknown): string[] =>
  readStrings(value).toSorted();

const readActivation = (
  probe: unknown
): { activation?: Activation; problem?: string } => {
  if (!isRecord(probe)) {
    return { problem: "unreadable probe record" };
  }
  if (isRecord(probe.exit)) {
    return {
      problem: `adapter exited (code ${String(probe.exit.code)}, signal ${String(probe.exit.signal)})`,
    };
  }
  if (typeof probe.error === "string") {
    return { problem: probe.error };
  }
  const reply = isRecord(probe.reply) ? probe.reply : {};
  const outcome = isRecord(reply.result) ? reply.result : {};
  const value = isRecord(outcome.value) ? outcome.value : {};
  const result = isRecord(value.result) ? value.result : {};
  const { activation } = result;
  if (
    outcome.kind !== "result" ||
    !isRecord(activation) ||
    typeof activation.activated !== "boolean" ||
    typeof activation.activationCount !== "number"
  ) {
    return {
      problem: `activation control did not answer: ${JSON.stringify(reply.error ?? outcome)}`,
    };
  }
  return {
    activation: {
      activated: activation.activated,
      activationCount: activation.activationCount,
      mutantId: activation.mutantId,
      signal: activation.signal,
    },
  };
};

const runProcess = async (
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number
): Promise<{ code: number | null; stderr: string; timedOut: boolean }> => {
  const child = spawn("bun", args, {
    cwd: REPO_ROOT,
    env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString("utf-8")).slice(-STDERR_TAIL_CHARS);
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, timeoutMs);
  const closed = Promise.withResolvers<number | null>();
  child.on("close", closed.resolve);
  child.on("error", () => {
    closed.resolve(null);
  });
  const code = await closed.promise;
  clearTimeout(timer);
  return { code, stderr, timedOut };
};

const inSequence = async <T, R>(
  items: readonly T[],
  run: (item: T) => Promise<R>,
  index = 0,
  done: readonly R[] = []
): Promise<R[]> => {
  const item = items[index];
  if (item === undefined) {
    return [...done];
  }
  const next = await run(item);
  return await inSequence(items, run, index + 1, [...done, next]);
};

const replayCommand = (
  config: NegativeControlPortConfig,
  mutantId: string
): string =>
  `${config.mutantEnv}=${mutantId} bun ${HARNESS} --adapter ${display(config.mutantAdapter)} --packet ${display(config.packet)}${(config.capabilities ?? []).map((capability) => ` --capability ${capability}`).join("")} --allow-failing-evidence`;

/** Points harness replays at the real manifest instead of the probe wrapper. */
const rewriteReplays = (
  text: string,
  rewrite: (replay: string) => string
): string => {
  let artifact: unknown;
  try {
    artifact = JSON.parse(text);
  } catch {
    return text;
  }
  if (!(isRecord(artifact) && Array.isArray(artifact.checkResults))) {
    return text;
  }
  const checkResults = artifact.checkResults.map((checkResult: unknown) =>
    isRecord(checkResult) &&
    isRecord(checkResult.failure) &&
    typeof checkResult.failure.replay === "string"
      ? {
          ...checkResult,
          failure: {
            ...checkResult.failure,
            replay: rewrite(checkResult.failure.replay),
          },
        }
      : checkResult
  );
  return `${JSON.stringify({ ...artifact, checkResults }, null, 2)}\n`;
};

const readHarnessArtifacts = async (logRoot: string): Promise<string[]> => {
  const runs = await readdir(logRoot, { withFileTypes: true });
  const files = await Promise.all(
    runs
      .filter((entry) => entry.isDirectory())
      .map(async ({ name }) => {
        const directory = nodePath.join(logRoot, name);
        return (await readdir(directory))
          .filter((file) => file.endsWith(".log"))
          .map((file) => nodePath.join(directory, file));
      })
  );
  return files.flat().toSorted();
};

const retainHarnessArtifacts = async (
  logRoot: string,
  wrappedPath: string,
  replayPrefix: string,
  adapterPath: string,
  retain: (text: string) => Promise<string>
): Promise<string[]> =>
  await inSequence(
    await readHarnessArtifacts(logRoot),
    async (file) =>
      await retain(
        rewriteReplays(
          await readFile(file, "utf-8"),
          (replay) =>
            `${replayPrefix}${replay.split(wrappedPath).join(display(adapterPath))}`
        )
      )
  );

const runHarness = async (
  config: NegativeControlPortConfig,
  adapterPath: string,
  mutantId: string | undefined,
  workDirectory: string,
  options: NegativeControlRunOptions,
  retain: (text: string) => Promise<string>
): Promise<HarnessRun> => {
  const label = mutantId ?? "control";
  const runDirectory = nodePath.join(workDirectory, label);
  const probeDirectory = nodePath.join(runDirectory, "probes");
  const harnessLogs = nodePath.join(runDirectory, "harness-logs");
  await mkdir(probeDirectory, { recursive: true });
  await mkdir(harnessLogs, { recursive: true });
  const manifest = await readAdapterManifest(adapterPath);
  const wrappedPath = nodePath.join(runDirectory, "adapter.json");
  await writeFile(
    wrappedPath,
    `${JSON.stringify({
      ...manifest,
      executable: "bun",
      command: [
        "bun",
        PROBE,
        "--record",
        probeDirectory,
        "--operation",
        config.activationOperation,
        "--",
        ...(typeof manifest.executable === "string"
          ? [manifest.executable, ...readStrings(manifest.command).slice(1)]
          : readStrings(manifest.command)),
      ],
    })}\n`
  );
  const evidencePath = nodePath.join(runDirectory, "evidence.json");
  const env: NodeJS.ProcessEnv = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([key]) => key !== config.mutantEnv)
    ),
    ...(mutantId === undefined ? {} : { [config.mutantEnv]: mutantId }),
    VERIFY_LOG_DIR: harnessLogs,
  };
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const run = await runProcess(
    [
      HARNESS,
      "--adapter",
      wrappedPath,
      "--concurrency",
      String(options.concurrency ?? 4),
      "--allow-failing-evidence",
      ...(config.capabilities ?? []).flatMap((capability) => [
        "--capability",
        capability,
      ]),
      "--evidence-out",
      evidencePath,
      "--summary-only",
    ],
    env,
    timeoutMs
  );
  const probeFiles = await readdir(probeDirectory);
  const probes = await Promise.all(
    probeFiles.map(async (name) =>
      readActivation(
        JSON.parse(await readFile(nodePath.join(probeDirectory, name), "utf-8"))
      )
    )
  );
  const activations = probes.flatMap(({ activation }) =>
    activation === undefined ? [] : [activation]
  );
  const unanswered = probes.flatMap(({ problem }) =>
    problem === undefined ? [] : [problem]
  );
  const retained = await retainHarnessArtifacts(
    harnessLogs,
    wrappedPath,
    mutantId === undefined ? "" : `${config.mutantEnv}=${mutantId} `,
    adapterPath,
    retain
  );
  const observed = {
    activations,
    ...(retained.length === 0 ? {} : { artifacts: retained }),
    unanswered,
  };
  if (run.timedOut) {
    return { ...observed, failure: `harness timed out after ${timeoutMs}ms` };
  }
  if (run.code !== 0) {
    return {
      ...observed,
      failure: `harness exited ${String(run.code)}: ${run.stderr.trim()}`,
    };
  }
  try {
    const evidence: unknown = JSON.parse(await readFile(evidencePath, "utf-8"));
    assertConformanceEvidence(evidence, `${label} evidence`);
    return { ...observed, evidence };
  } catch (error: unknown) {
    return {
      ...observed,
      failure: `harness evidence unusable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
};

const failingAssertions = (
  evidence: ConformanceEvidence
): CollateralFailure[] =>
  evidence.checkResults.flatMap((checkResult) =>
    checkResult.assertionResults
      .filter((assertion) => assertion.status === "fail")
      .map((assertion) => ({
        assertionId: assertion.assertionId,
        checkId: checkResult.checkId,
        ...(checkResult.failure === undefined
          ? {}
          : { classification: checkResult.failure.classification }),
      }))
  );

const locateDesignated = (
  evidence: ConformanceEvidence,
  assertionId: string
): "applicable" | "missing" | "not_applicable" => {
  if (
    evidence.checkResults.some((checkResult) =>
      checkResult.assertionResults.some(
        (assertion) => assertion.assertionId === assertionId
      )
    )
  ) {
    return "applicable";
  }
  return (evidence.nonApplicableCheckIds ?? []).some((checkId) =>
    assertionId.startsWith(`${checkId}.`)
  )
    ? "not_applicable"
    : "missing";
};

const describeControl = (control: ControlEntry) => ({
  activated: false,
  activationCount: 0,
  collateral: { assertions: [] as CollateralFailure[], count: 0 },
  designatedFailures: [] as string[],
  ...(control.expectedRejection === undefined
    ? {}
    : { expectedRejection: control.expectedRejection }),
  kind: control.kind,
  mutantId: control.mutantId,
});

/** Classifies one mutant run under ADR-0079 decision 3. */
export const classifyMutantRun = (
  control: ControlEntry,
  run: HarnessRun
): Omit<MutantReport, "replay"> => {
  const activationCount = run.activations.reduce(
    (total, activation) => total + activation.activationCount,
    0
  );
  const base = {
    ...describeControl(control),
    activated: run.activations.some((activation) => activation.activated),
    activationCount,
  };
  const result = (
    outcome: NegativeControlOutcome,
    reason?: string
  ): Omit<MutantReport, "replay"> => ({
    ...base,
    outcome,
    ...(reason === undefined ? {} : { reason }),
    ...(run.evidence === undefined ? {} : { summary: run.evidence.summary }),
  });

  const { evidence } = run;
  if (run.failure !== undefined || evidence === undefined) {
    return result("invalid", run.failure ?? "harness produced no evidence");
  }
  const designated = new Set(control.designatedAssertions);
  const failing = failingAssertions(evidence);
  base.designatedFailures = failing
    .filter(({ assertionId }) => designated.has(assertionId))
    .map(({ assertionId }) => assertionId);
  const collateral = failing.filter(
    ({ assertionId }) => !designated.has(assertionId)
  );
  base.collateral = { assertions: collateral, count: collateral.length };

  if (run.activations.length === 0 && run.unanswered.length === 0) {
    return result("invalid", "no adapter process reached the activation probe");
  }
  if (run.unanswered.length > 0) {
    return result(
      "invalid",
      `activation unreadable: ${[...new Set(run.unanswered)].join("; ")}`
    );
  }
  const foreign = run.activations.find(
    (activation) =>
      activation.mutantId !== control.mutantId ||
      activation.signal !== control.activation.signal
  );
  if (foreign !== undefined) {
    return result(
      "invalid",
      `activation reported ${String(foreign.mutantId)} (${String(foreign.signal)}), expected ${control.mutantId} (${control.activation.signal})`
    );
  }

  if (control.kind !== "implementation") {
    if (!base.activated) {
      return result("unsupported", "never activated; not counted");
    }
    const rejections = evidence.checkResults.filter((check) => {
      const rejection = check.details?.rejection;
      return (
        check.status === "fail" &&
        isRecord(rejection) &&
        rejection.code === control.expectedRejection
      );
    });
    const infrastructure = evidence.checkResults.filter(
      (check) =>
        check.status === "fail" &&
        check.failure?.classification !== "implementation" &&
        !rejections.includes(check)
    );
    if (infrastructure.length > 0) {
      return result(
        "invalid",
        `unexpected runner failure: ${infrastructure.map((check) => check.checkId).join(", ")}`
      );
    }
    if (rejections.length > 0) {
      return result("killed");
    }
    return result(
      "survived",
      `expected runner rejection ${control.expectedRejection ?? ""} did not occur`
    );
  }

  const located = [...designated].map((assertionId) => ({
    assertionId,
    where: locateDesignated(evidence, assertionId),
  }));
  if (!located.some(({ where }) => where === "applicable")) {
    return result(
      "invalid",
      `no designated assertion was evaluated: ${located
        .map(
          ({ assertionId, where }) =>
            `${assertionId} ${where === "missing" ? "absent from the run" : "not applicable (capability gap)"}`
        )
        .join(", ")}`
    );
  }
  // Any non-implementation failure anywhere in the run invalidates it.
  const infrastructure = evidence.checkResults.filter(
    ({ failure, status }) =>
      status === "fail" && failure?.classification !== "implementation"
  );
  if (infrastructure.length > 0) {
    return result(
      "invalid",
      `checks failed with ${infrastructure
        .map(
          ({ checkId, failure }) =>
            `${checkId}: ${failure?.classification ?? "unclassified"}`
        )
        .join(", ")}`
    );
  }
  if (!base.activated) {
    return result("unsupported", "never activated; not counted");
  }
  if (base.designatedFailures.length > 0) {
    return result("killed");
  }
  return result("survived", "activated, but no designated assertion failed");
};

const emptyTotals = (): NegativeControlReport["totals"] => ({
  activated: 0,
  equivalent: 0,
  invalid: 0,
  killed: 0,
  survived: 0,
  unsupported: 0,
});

const runUnclaimedDiagnostics = async (
  report: NegativeControlReport,
  controlManifest: Record<string, unknown>,
  evidence: ConformanceEvidence | undefined,
  config: NegativeControlPortConfig,
  options: NegativeControlRunOptions,
  workDirectory: string
): Promise<void> => {
  if (
    report.mode !== "enforcing" ||
    !evidence?.checkResults.some(({ checkId }) =>
      checkId.startsWith(`profile.${config.profile}.`)
    )
  ) {
    return;
  }
  const diagnosticAdapter = nodePath.join(
    workDirectory,
    "diagnostic-adapter.json"
  );
  await writeFile(
    diagnosticAdapter,
    JSON.stringify({ ...controlManifest, profiles: [] })
  );
  const diagnostic = await runNegativeControls(
    { ...config, controlAdapter: diagnosticAdapter },
    options
  );
  report.mutants = diagnostic.mutants;
  report.totals = diagnostic.totals;
  report.notRun = diagnostic.notRun;
  report.findings.push(
    "diagnostic outcomes use an unclaimed profile and do not count toward the gate"
  );
};

/** Runs the unmutated control, then every selected mutant, unchanged plans. */
export const runNegativeControls = async (
  config: NegativeControlPortConfig,
  options: NegativeControlRunOptions = {}
): Promise<NegativeControlReport> => {
  const manifest = await readControlManifest(config.packet);
  const obligations = await readProfileObligations(config, manifest.controls);
  const selected = manifest.controls.filter(
    (control) =>
      options.mutants === undefined ||
      options.mutants.length === 0 ||
      options.mutants.includes(control.mutantId)
  );
  const report: NegativeControlReport = {
    control: { adapter: display(config.controlAdapter), status: "error" },
    counted: false,
    findings: [],
    manifest: display(manifest.path),
    mode:
      obligations === undefined || (options.mutants?.length ?? 0) > 0
        ? "report"
        : "enforcing",
    mutantAdapter: display(config.mutantAdapter),
    mutants: [],
    notRun: [],
    packet: display(config.packet),
    port: config.port,
    profile: config.profile,
    totals: emptyTotals(),
  };
  const [controlManifest, mutantManifest] = await Promise.all([
    readAdapterManifest(config.controlAdapter),
    readAdapterManifest(config.mutantAdapter),
  ]);
  if (!readStrings(controlManifest.profiles).includes(config.profile)) {
    report.mode = "report";
  }
  const controlCapabilities = sortedStrings(controlManifest.capabilities);
  if (
    controlCapabilities.join("\n") !==
    sortedStrings(mutantManifest.capabilities).join("\n")
  ) {
    report.findings.push(
      `${report.mutantAdapter} does not declare the capabilities of ${report.control.adapter}, so the control and mutant runs differ in configuration`
    );
    report.notRun = selected.map(({ mutantId }) => mutantId);
    return report;
  }

  const workDirectory = await mkdtemp(
    nodePath.join(tmpdir(), "tuvren-negative-controls-")
  );
  let logs: VerificationLogs | undefined;
  const retain = async (text: string): Promise<string> => {
    logs ??= await createVerificationLogs(
      fromRoot(
        options.logDirectory ??
          process.env.VERIFY_LOG_DIR ??
          ".cache/verification"
      )
    );
    return await logs.create(text);
  };
  try {
    const controlRun = await runHarness(
      config,
      config.controlAdapter,
      undefined,
      workDirectory,
      options,
      retain
    );
    const { evidence } = controlRun;
    report.control = {
      adapter: report.control.adapter,
      ...(controlRun.artifacts === undefined
        ? {}
        : { artifacts: controlRun.artifacts }),
      status: evidence?.status ?? "error",
      ...(evidence === undefined
        ? {}
        : {
            failedChecks: evidence.checkResults
              .filter(({ status }) => status === "fail")
              .map(({ checkId }) => checkId),
            summary: evidence.summary,
            conditionalAssertions: evidence.checkResults.flatMap((check) =>
              check.assertionResults.filter(
                (assertion) => assertion.when !== undefined
              )
            ),
          }),
      ...(controlRun.failure === undefined
        ? {}
        : { reason: controlRun.failure }),
    };
    if (evidence?.status !== "pass") {
      report.findings.push(
        `unmutated control ${report.control.adapter} did not pass (${report.control.status}${
          controlRun.failure === undefined ? "" : `: ${controlRun.failure}`
        }${
          (report.control.failedChecks ?? []).length > 0
            ? `; failed checks ${(report.control.failedChecks ?? []).join(", ")}`
            : ""
        }); no mutant is counted`
      );
      report.notRun = selected.map(({ mutantId }) => mutantId);
      await runUnclaimedDiagnostics(
        report,
        controlManifest,
        evidence,
        config,
        options,
        workDirectory
      );
      return report;
    }
    report.counted = true;

    report.mutants = await inSequence(
      selected,
      async (control): Promise<MutantReport> => {
        if (
          config.mutants !== undefined &&
          !config.mutants.includes(control.mutantId)
        ) {
          return {
            ...describeControl(control),
            outcome: "unsupported",
            reason:
              config.unsupportedReasons?.[control.mutantId] ??
              "mutant is not supported by this port configuration; not run",
          };
        }
        if (!control.profiles.includes(config.profile)) {
          return {
            ...describeControl(control),
            outcome: "unsupported",
            reason: `applies to ${control.profiles.join(", ")}, not ${config.profile}; not run`,
          };
        }
        const run = await runHarness(
          config,
          config.mutantAdapter,
          control.mutantId,
          workDirectory,
          options,
          retain
        );
        return {
          ...classifyMutantRun(control, run),
          ...(run.artifacts === undefined ? {} : { artifacts: run.artifacts }),
          replay: replayCommand(config, control.mutantId),
        };
      }
    );
  } finally {
    await rm(workDirectory, { force: true, recursive: true });
    await logs?.finish(false);
  }

  for (const mutant of report.mutants) {
    report.totals[mutant.outcome] += 1;
    if (mutant.activated) {
      report.totals.activated += 1;
    }
  }
  return report;
};

const pad = (rows: readonly string[][]): string => {
  const widths = rows[0]?.map((_, column) =>
    Math.max(...rows.map((row) => row[column]?.length ?? 0))
  );
  return rows
    .map((row) =>
      row
        .map((cell, column) => cell.padEnd(widths?.[column] ?? 0))
        .join("  ")
        .trimEnd()
    )
    .join("\n");
};

export const formatNegativeControlSummary = (
  report: NegativeControlReport
): string => {
  const { totals } = report;
  const control =
    report.control.summary === undefined
      ? report.control.status
      : `${report.control.status} (${report.control.summary.passedChecks}/${report.control.summary.applicableChecks ?? report.control.summary.totalChecks})`;
  const lines = [
    `negative controls ${report.port} (${report.profile}, ${report.mode} mode): unmutated control ${report.control.adapter} ${control}`,
  ];
  if (!report.counted) {
    lines.push(
      ...report.findings.map((finding) => `finding: ${finding}`),
      `not run: ${report.notRun.join(", ")}`
    );
    if (report.mutants.length === 0) {
      return `${lines.join("\n")}\n`;
    }
    lines.push("diagnostic outcomes only; no mutant counts toward the gate");
  }
  lines.push(
    `activated ${totals.activated}, killed ${totals.killed}, survived ${totals.survived}, equivalent ${totals.equivalent}, unsupported ${totals.unsupported}, invalid ${totals.invalid} of ${report.mutants.length}`,
    pad([
      [
        "mutant",
        "kind",
        "activated",
        "outcome",
        "designated failures",
        "collateral",
      ],
      ...report.mutants.map((mutant) => [
        mutant.mutantId,
        mutant.kind,
        String(mutant.activated),
        mutant.outcome,
        String(mutant.designatedFailures.length),
        String(mutant.collateral.count),
      ]),
    ])
  );
  for (const mutant of report.mutants) {
    if (mutant.reason !== undefined) {
      lines.push(`  ${mutant.mutantId}: ${mutant.reason}`);
    }
  }
  return `${lines.join("\n")}\n`;
};

const parseCli = (
  args: readonly string[]
): NegativeControlRunOptions & { ports: string[]; reportOut?: string } => {
  const parsed: NegativeControlRunOptions & {
    mutants: string[];
    ports: string[];
    reportOut?: string;
  } = { mutants: [], ports: [] };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${arg} requires a value`);
    }
    index += 1;
    switch (arg) {
      case "--port": {
        parsed.ports.push(value);
        break;
      }
      case "--mutant": {
        parsed.mutants.push(value);
        break;
      }
      case "--concurrency": {
        parsed.concurrency = Number(value);
        break;
      }
      case "--timeout-ms": {
        parsed.timeoutMs = Number(value);
        break;
      }
      case "--report-out": {
        parsed.reportOut = value;
        break;
      }
      default: {
        throw new Error(`unknown negative-control argument ${arg}`);
      }
    }
  }
  return parsed;
};

const snapshotControls = async (
  configs: readonly NegativeControlPortConfig[]
) => {
  const packet = configs[0]?.packet;
  if (packet === undefined) {
    throw new Error("no control packet selected");
  }
  const verifierDigests = await computeVerifierDigests([packet]);
  const adapters = await inSequence(configs, async (config) => {
    const manifest = await readValidatedAdapterManifest(config.controlAdapter);
    if (
      manifest.authorityPackets.length !== 1 ||
      manifest.authorityPackets[0] !== config.packet
    ) {
      throw new Error(
        `${config.controlAdapter} must run its full packet inventory`
      );
    }
    return {
      adapter: display(config.controlAdapter),
      adapterManifest: await digestAdapterManifest(config.controlAdapter),
      implementation: await computeImplementationDigest(manifest),
    };
  });
  return { verifierDigests, adapters };
};

const checkFleetGate = async (
  configs: readonly NegativeControlPortConfig[],
  reports: readonly NegativeControlReport[]
): Promise<string[]> => {
  const failures: string[] = [];
  for (const config of configs) {
    try {
      const manifest = await readControlManifest(config.packet);
      const obligations = await readProfileObligations(
        config,
        manifest.controls
      );
      if (obligations === undefined) {
        continue;
      }
      const fleet = reports.filter(
        (report) =>
          report.profile === config.profile && report.mode === "enforcing"
      );
      assertNegativeControlGate(
        config.profile,
        obligations.negativeControls,
        fleet
      );
      assertConditionalBranchCoverage(
        obligations.conditionalAssertions,
        fleet
          .filter((report) => report.counted)
          .map((report) => report.control.conditionalAssertions ?? [])
      );
    } catch (error: unknown) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  return failures;
};

const main = async (): Promise<void> => {
  const options = parseCli(process.argv.slice(2));
  const unknown = options.ports.filter(
    (port) => !NEGATIVE_CONTROL_PORTS.some((config) => config.port === port)
  );
  if (unknown.length > 0) {
    throw new Error(`unknown negative-control port(s) ${unknown.join(", ")}`);
  }
  const configs = NEGATIVE_CONTROL_PORTS.filter(
    ({ port }) => options.ports.length === 0 || options.ports.includes(port)
  );
  const recordProvenance =
    options.reportOut !== undefined && (options.mutants?.length ?? 0) === 0;
  if (
    recordProvenance &&
    new Set(configs.map(({ packet, profile }) => `${packet}\n${profile}`))
      .size !== 1
  ) {
    throw new Error(
      "a control provenance report must cover one packet and profile"
    );
  }
  const profile = configs[0]?.profile;
  const before = recordProvenance ? await snapshotControls(configs) : undefined;
  const reports = await inSequence(configs, async (config) => {
    const report = await runNegativeControls(config, options);
    process.stdout.write(formatNegativeControlSummary(report));
    return report;
  });
  const gateFailures =
    (options.mutants?.length ?? 0) === 0
      ? await checkFleetGate(configs, reports)
      : [];
  const after = recordProvenance ? await snapshotControls(configs) : undefined;
  if (
    before !== undefined &&
    JSON.stringify(before) !== JSON.stringify(after)
  ) {
    gateFailures.push(
      "verifier or implementation inputs changed during the control run"
    );
  }
  const controlRun =
    before === undefined || profile === undefined
      ? undefined
      : (() => {
          const identity = {
            profile,
            status:
              gateFailures.length === 0 &&
              reports.every(
                (report) => report.counted && report.mode === "enforcing"
              )
                ? ("pass" as const)
                : ("fail" as const),
            verifierDigests: before.verifierDigests,
            adapters: before.adapters,
            outcomes: controlOutcomes(reports),
          };
          return { ...identity, id: controlRunId(identity) };
        })();
  const text = `${JSON.stringify({ reports, ...(controlRun === undefined ? {} : { controlRun }) }, null, 2)}\n`;
  const logs = await createVerificationLogs(
    fromRoot(process.env.VERIFY_LOG_DIR ?? ".cache/verification")
  );
  const file = await logs.create(text);
  await logs.finish(false);
  process.stdout.write(`negative-control report written to ${file}\n`);
  if (options.reportOut !== undefined) {
    await mkdir(nodePath.dirname(fromRoot(options.reportOut)), {
      recursive: true,
    });
    await writeFile(fromRoot(options.reportOut), text);
  }
  if (gateFailures.length > 0) {
    throw new Error(gateFailures.join("; "));
  }
};

if (import.meta.main) {
  await main();
}
