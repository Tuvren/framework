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
import { profileConditionalAssertions } from "../meta-conformance/claim-coverage.js";
import type { CompiledConformancePlan } from "../plan-compiler/index.js";
import { matchesControlRun } from "./control-link.js";
import type { CertificationProfile } from "./profile.js";
import { computeCertificateDigests } from "./provenance.js";
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

interface BundleFields {
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
    profiles.length === 1
    ? await computeCertificateDigests(manifest, options.adapter)
    : undefined;
};

const certificationEnvironment = async (manifest: AdapterManifest) => {
  const rustc = spawnSync("rustc", ["--version"], { encoding: "utf8" });
  const cargo = spawnSync("cargo", ["--version"], { encoding: "utf8" });
  if (rustc.status !== 0 || cargo.status !== 0) {
    throw new Error("cannot determine the Rust toolchain versions");
  }
  const packageValue: unknown =
    manifest.language === "rust"
      ? undefined
      : JSON.parse(
          await readFile(
            path.join(ROOT, "typescript/kernel/backends/memory/package.json"),
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
    throw new Error("cannot determine the memory backend version");
  }
  const values = {
    architecture: arch(),
    backend: { kind: "memory", version: backendVersion },
    operatingSystem: { platform: platform(), release: release() },
    toolchains: {
      bun: bunVersion,
      bunExecutable: createHash("sha256")
        .update(await readFile(process.execPath))
        .digest("hex"),
      cargo: cargo.stdout.trim(),
      rustc: rustc.stdout.trim(),
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

const completedProcess = (value: unknown): boolean => {
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
    const { implementation, adapterManifest, ...verifierDigests } = digests;
    return matchesControlRun(value, {
      adapter: path.relative(ROOT, path.resolve(ROOT, options.adapter)),
      adapterManifest,
      implementation,
      negativeControls: profile.negativeControls,
      conditionalAssertions: profileConditionalAssertions(
        profile.claimIds,
        plans
      ),
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
  before: CertificateDigests | undefined
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
  const after = await computeCertificateDigests(manifest, options.adapter);
  const environment = await certificationEnvironment(manifest);
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    return { ...incomplete, environment };
  }
  const negativeControlRunId = await controlRun(options, profile, plans, after);
  const complete =
    negativeControlRunId !== undefined &&
    status === "pass" &&
    profilePassed(profile, plans, results) &&
    results.every(
      (result) =>
        completedProcess(result.details?.process) &&
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
