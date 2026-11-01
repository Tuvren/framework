import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { arch, platform, release } from "node:os";
import path from "node:path";
import process from "node:process";

import { version as bunVersion } from "bun";

import type {
  ConformanceCheckResult,
  ConformanceRunStatus,
} from "../../scripts/lib/conformance-contract.js";
import type { AdapterManifest } from "../harness/adapter-client.js";
import { readAdapterManifest } from "../harness/run-plans.js";
import {
  profileConditionalAssertions,
  profileSemanticAssertions,
} from "../meta-conformance/claim-coverage.js";
import type { CompiledConformancePlan } from "../plan-compiler/index.js";
import { matchesControlRun, profileControlReport } from "./control-link.js";
import { readProfileScopedControls } from "./profile.js";
import type { CertificationProfile } from "./profile.js";
import {
  computeCertificateDigests,
  computeImplementationDigest,
  digestAdapterManifest,
} from "./provenance.js";
import type { CertificateDigests } from "./provenance.js";

interface RunOptions {
  adapter: string;
  controlReport?: string;
  capabilities: readonly string[];
  checks: readonly string[];
  packets: readonly string[];
  plans: readonly string[];
  shard?: unknown;
}

export interface BundleFields {
  certificate?: {
    complete: boolean;
    profile: string;
    status: "certified" | "uncertified";
  };
  digests?: CertificateDigests;
  environment?: Record<string, unknown>;
  negativeControlRunId?: string;
}

const ROOT = path.resolve(import.meta.dirname, "../../..");
const CARGO_VERSION = /^version = "([^"]+)"/mu;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const beginCertificate = async (
  options: RunOptions,
  manifest: AdapterManifest,
  profiles: readonly CertificationProfile[]
): Promise<CertificateDigests | undefined> => {
  const unfiltered =
    options.checks.length === 0 &&
    options.capabilities.length === 0 &&
    options.packets.length === 0 &&
    options.plans.length === 0 &&
    options.shard === undefined;
  return options.controlReport !== undefined &&
    unfiltered &&
    profiles.length > 0
    ? await computeCertificateDigests(manifest, options.adapter)
    : undefined;
};

const backendKindForStorage = (storage: AdapterManifest["storage"]) => {
  switch (storage) {
    case "none":
      return "memory";
    case "sqlite-directory":
      return "sqlite";
    case "postgres-database":
      return "postgres";
    default:
      throw new Error("certificate adapter must declare its storage kind");
  }
};

const certificationEnvironment = async (
  manifest: AdapterManifest,
  results: readonly ConformanceCheckResult[]
) => {
  const backendKind = backendKindForStorage(manifest.storage);
  if (manifest.language === "rust" && backendKind !== "memory") {
    throw new Error(`unsupported Rust certificate backend ${backendKind}`);
  }
  const packageValue: unknown =
    manifest.language === "rust"
      ? undefined
      : JSON.parse(
          await readFile(
            path.join(
              ROOT,
              `typescript/kernel/backends/${backendKind}/package.json`
            ),
            "utf8"
          )
        );
  const typescriptVersion = isRecord(packageValue)
    ? packageValue.version
    : undefined;
  const backendVersion =
    manifest.language === "rust"
      ? (await readFile(path.join(ROOT, "Cargo.toml"), "utf8")).match(
          CARGO_VERSION
        )?.[1]
      : typescriptVersion;
  if (typeof backendVersion !== "string") {
    throw new Error(`cannot determine the ${backendKind} backend version`);
  }
  let implementationToolchain: Record<string, string>;
  if (manifest.language === "rust") {
    const rustc = spawnSync("rustc", ["--version"], { encoding: "utf8" });
    const cargo = spawnSync("cargo", ["--version"], { encoding: "utf8" });
    if (rustc.status !== 0 || cargo.status !== 0) {
      throw new Error("cannot determine the Rust toolchain versions");
    }
    implementationToolchain = {
      cargo: cargo.stdout.trim(),
      rustc: rustc.stdout.trim(),
    };
  } else if (manifest.language === "typescript") {
    const compiler: unknown = JSON.parse(
      await readFile(
        path.join(ROOT, "node_modules/typescript/package.json"),
        "utf8"
      )
    );
    if (!isRecord(compiler) || typeof compiler.version !== "string") {
      throw new Error("cannot determine the TypeScript toolchain version");
    }
    implementationToolchain = { typescript: compiler.version };
  } else {
    throw new Error(
      `unsupported certificate implementation ${manifest.language}`
    );
  }
  const serverVersions = new Set(
    results.flatMap((result) => {
      const storage = result.details?.storageIdentity;
      return isRecord(storage) && typeof storage.serverVersion === "string"
        ? [storage.serverVersion]
        : [];
    })
  );
  const serverVersion = [...serverVersions][0];
  if (backendKind === "postgres" && serverVersions.size > 1) {
    throw new Error(
      "cannot determine a single PostgreSQL server version from provisioned storage"
    );
  }
  if (backendKind === "postgres" && serverVersion === undefined) {
    return undefined;
  }
  const values = {
    architecture: arch(),
    backend: {
      kind: backendKind,
      version: backendVersion,
      ...(backendKind === "postgres" ? { serverVersion } : {}),
    },
    operatingSystem: { platform: platform(), release: release() },
    toolchains: {
      bun: bunVersion,
      bunExecutable: createHash("sha256")
        .update(await readFile(process.execPath))
        .digest("hex"),
      ...implementationToolchain,
    },
  };
  return {
    ...values,
    fingerprint: createHash("sha256")
      .update(JSON.stringify(values))
      .digest("hex"),
  };
};

const profilePassed = (
  profile: CertificationProfile,
  plans: readonly CompiledConformancePlan[],
  results: readonly ConformanceCheckResult[]
): boolean => {
  const byId = new Map(results.map((result) => [result.checkId, result]));
  const claims = new Set(profile.claimIds);
  const required = plans
    .flatMap(({ checks }) => checks.map(({ check }) => check))
    .filter((check) =>
      [
        ...(check.claimIds ?? []),
        ...(check.steps ?? []).flatMap((step) => step.claimIds ?? []),
      ].some((id) => claims.has(id))
    );
  if (
    required.length === 0 ||
    required.some((check) => byId.get(check.checkId)?.status !== "pass")
  ) {
    return false;
  }
  if (
    !hasProfileEvidence(
      profile.requiredEvidence,
      required.map((check) => check.checkId),
      byId
    )
  ) {
    return false;
  }
  const points = new Set<string>();
  for (const result of results) {
    const fault = result.details?.fault;
    if (
      !(
        isRecord(fault) &&
        Array.isArray(fault.armed) &&
        Array.isArray(fault.activations)
      )
    ) {
      continue;
    }
    for (const armed of fault.armed) {
      if (
        isRecord(armed) &&
        typeof armed.point === "string" &&
        fault.activations.includes(armed.token)
      ) {
        points.add(armed.point);
      }
    }
  }
  return profile.faultPoints.every((point) => points.has(point));
};

const hasProfileEvidence = (
  paths: readonly string[],
  checkIds: readonly string[],
  results: ReadonlyMap<string, ConformanceCheckResult>
): boolean => {
  const satisfied = new Set<string>();
  for (const checkId of checkIds) {
    const prefix = `${checkId}.requiredEvidence.`;
    for (const assertion of results.get(checkId)?.assertionResults ?? []) {
      if (
        assertion.status === "pass" &&
        assertion.assertionId.startsWith(prefix)
      ) {
        satisfied.add(assertion.assertionId.slice(prefix.length));
      }
    }
  }
  return paths.every((path) => satisfied.has(path));
};

const completedProcess = (value: unknown, schedule: unknown): boolean => {
  if (isRecord(value) && Array.isArray(value.epochs)) {
    if (!Array.isArray(schedule)) {
      return false;
    }
    const endings = schedule.flatMap((step: unknown) =>
      isRecord(step) && (step.action === "restart" || step.action === "kill")
        ? [step.action]
        : []
    );
    if (value.epochs.length !== endings.length + 1) {
      return false;
    }
    return value.epochs.every((epoch: unknown, index: number) => {
      if (
        !(isRecord(epoch) && isRecord(epoch.exit)) ||
        typeof epoch.pid !== "number" ||
        !Number.isSafeInteger(epoch.pid) ||
        epoch.pid <= 0 ||
        epoch.epoch !== index + 1 ||
        epoch.signal !== epoch.exit.signal
      ) {
        return false;
      }
      return endings[index] === "kill"
        ? epoch.exit.code === null && epoch.exit.signal === "SIGKILL"
        : epoch.exit.code === 0 && epoch.exit.signal === null;
    });
  }
  if (!(isRecord(value) && isRecord(value.exit))) {
    return false;
  }
  if (
    typeof value.pid !== "number" ||
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 0
  ) {
    return false;
  }
  return (
    value.exit.code === 0 ||
    (value.exit.signal === "SIGTERM" && value.supervisorTerminated === true)
  );
};

const completedProcesses = (result: ConformanceCheckResult): boolean => {
  const details = result.details;
  const schedule = details?.schedule;
  if (!Array.isArray(details?.processes)) {
    return completedProcess(details?.process, schedule);
  }
  return (
    details.processes.length > 0 &&
    details.processes.every((process: unknown) => {
      if (
        !(
          isRecord(process) &&
          typeof process.name === "string" &&
          Array.isArray(schedule)
        )
      ) {
        return false;
      }
      const ownSchedule = schedule.filter(
        (step: unknown) =>
          isRecord(step) && (step.process ?? "primary") === process.name
      );
      return completedProcess(process, ownSchedule);
    })
  );
};

const branchAdapterNames = (
  reports: readonly unknown[]
): Set<string> | undefined => {
  const names = new Set<string>();
  for (const report of reports) {
    if (!(isRecord(report) && isRecord(report.control))) {
      return undefined;
    }
    const controls = report.control.branchControls;
    if (controls === undefined) {
      continue;
    }
    if (!Array.isArray(controls)) {
      return undefined;
    }
    for (const control of controls) {
      if (!isRecord(control) || typeof control.adapter !== "string") {
        return undefined;
      }
      names.add(control.adapter);
    }
  }
  return names;
};

const branchProvenanceMatches = async (
  value: unknown,
  profile: string
): Promise<boolean> => {
  const document = profileControlReport(value, profile);
  if (
    !(
      isRecord(document) &&
      Array.isArray(document.reports) &&
      isRecord(document.controlRun) &&
      Array.isArray(document.controlRun.adapters)
    )
  ) {
    return false;
  }
  const names = branchAdapterNames(document.reports);
  if (names === undefined) {
    return false;
  }
  for (const name of names) {
    const digest = document.controlRun.adapters.find(
      (entry: unknown) => isRecord(entry) && entry.adapter === name
    );
    if (!isRecord(digest)) {
      return false;
    }
    const manifest = await readAdapterManifest(path.resolve(ROOT, name));
    if (
      digest.adapterManifest !== (await digestAdapterManifest(name)) ||
      digest.implementation !== (await computeImplementationDigest(manifest))
    ) {
      return false;
    }
  }
  return true;
};

const controlRun = async (
  options: RunOptions,
  profile: CertificationProfile,
  plans: readonly CompiledConformancePlan[],
  digests: CertificateDigests
): Promise<string | undefined> => {
  if (options.controlReport === undefined) {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(
      await readFile(path.resolve(ROOT, options.controlReport), "utf8")
    );
    if (!(await branchProvenanceMatches(value, profile.profileId))) {
      return undefined;
    }
    const { implementation, adapterManifest, ...verifierDigests } = digests;
    return matchesControlRun(value, {
      adapter: path.relative(ROOT, path.resolve(ROOT, options.adapter)),
      adapterManifest,
      implementation,
      negativeControls: profile.negativeControls,
      scopedControls: await readProfileScopedControls(
        await readAdapterManifest(options.adapter),
        profile
      ),
      conditionalAssertions: profileConditionalAssertions(
        profile.claimIds,
        plans
      ),
      semanticAssertions: profileSemanticAssertions(profile.claimIds, plans),
      profile: profile.profileId,
      verifierDigests,
    });
  } catch {
    return undefined;
  }
};

export const finishCertificate = async (
  options: RunOptions,
  manifest: AdapterManifest,
  profile: CertificationProfile | undefined,
  plans: readonly CompiledConformancePlan[],
  results: readonly ConformanceCheckResult[],
  status: ConformanceRunStatus,
  before: CertificateDigests | undefined,
  snapshotAfter?: CertificateDigests
): Promise<BundleFields> => {
  if (profile === undefined) {
    return {};
  }
  const incomplete = {
    certificate: {
      complete: false,
      profile: profile.profileId,
      status: "uncertified" as const,
    },
  };
  if (before === undefined) {
    return incomplete;
  }
  const after =
    snapshotAfter ??
    (await computeCertificateDigests(manifest, options.adapter));
  const environment = await certificationEnvironment(manifest, results);
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    return { ...incomplete, environment };
  }
  const negativeControlRunId = await controlRun(options, profile, plans, after);
  const complete =
    environment !== undefined &&
    negativeControlRunId !== undefined &&
    status === "pass" &&
    profilePassed(profile, plans, results) &&
    results.every(
      (result) =>
        completedProcesses(result) &&
        result.details?.schedule !== undefined &&
        result.details?.storageIdentity !== undefined
    );
  return {
    certificate: {
      complete,
      profile: profile.profileId,
      status: complete ? ("certified" as const) : ("uncertified" as const),
    },
    digests: after,
    environment,
    ...(negativeControlRunId === undefined ? {} : { negativeControlRunId }),
  };
};
