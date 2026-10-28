import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";

import { runCommand } from "../../scripts/lib/command-runner.js";
import { assertConformanceEvidence } from "../../scripts/lib/conformance-contract.js";
import type { AdapterManifest } from "../harness/adapter-client.js";
import { readAdapterManifest } from "../harness/run-plans.js";
import { readCertificationManifest } from "./certification-manifest.js";
import type { CertificationInventoryEntry } from "./certification-manifest.js";
import { readClaimedProfiles } from "./profile.js";
import type { CertificationProfile } from "./profile.js";
import type { CertificateDigests } from "./provenance.js";
import { computeCertificateDigests } from "./provenance.js";

export interface CompatibilityCertificate {
  backend: string;
  digests: CertificateDigests;
  implementationId: string;
  negativeControlRunId: string;
  profile: string;
  status: "certified";
}

interface CertifiedAdapter extends CertificationInventoryEntry {
  manifest: AdapterManifest;
  profiles: CertificationProfile[];
}

const ROOT = path.resolve(import.meta.dirname, "../../..");
const verifierFields = [
  "harness",
  "packet",
  "plans",
  "catalogs",
  "fixtures",
  "profiles",
  "controls",
  "verifierAuthority",
] as const;
const digestFields = [
  "implementation",
  "adapterManifest",
  ...verifierFields,
] as const;
const hashPattern = /^[0-9a-f]{64}$/u;
const object = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("expected an object");
  }
  return Object.fromEntries(Object.entries(value));
};
const text = (value: unknown): string => {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError("expected a nonempty string");
  }
  return value;
};
const digests = (value: unknown): CertificateDigests => {
  const input = object(value);
  const fields = Object.fromEntries(
    digestFields.map((field) => {
      const digest = text(input[field]);
      if (!hashPattern.test(digest)) {
        throw new Error(`invalid certificate digest ${field}`);
      }
      return [field, digest];
    })
  );
  return {
    implementation: text(fields.implementation),
    adapterManifest: text(fields.adapterManifest),
    harness: text(fields.harness),
    packet: text(fields.packet),
    plans: text(fields.plans),
    catalogs: text(fields.catalogs),
    fixtures: text(fields.fixtures),
    profiles: text(fields.profiles),
    controls: text(fields.controls),
    verifierAuthority: text(fields.verifierAuthority),
  };
};

const certifiedAdapters = async () => {
  const fleet = await readCertificationManifest(
    path.join(ROOT, "tools/conformance/certification/certified-projects.json")
  );
  const result: CertifiedAdapter[] = [];
  for (const entry of fleet.inventory) {
    const manifest = await readAdapterManifest(
      path.resolve(ROOT, entry.adapter)
    );
    const claimed = await readClaimedProfiles(
      manifest,
      manifest.authorityPackets
    );
    const profiles = claimed.filter((profile) =>
      fleet.certified.some(
        (certified) =>
          certified.project === entry.project &&
          certified.profile === profile.profileId
      )
    );
    if (profiles.length > 0) {
      result.push({ ...entry, manifest, profiles });
    }
  }
  return result;
};

const backendKind = (storage: string | undefined): string => {
  switch (storage) {
    case "none":
      return "memory";
    case "sqlite-directory":
      return "sqlite";
    case "postgres-database":
      return "postgres";
    default:
      throw new Error(`unknown certificate storage ${String(storage)}`);
  }
};

export const assertCompatibilityCertificates = async (
  rows: readonly CompatibilityCertificate[]
): Promise<void> => {
  const adapters = await certifiedAdapters();
  const expected = adapters
    .flatMap(({ manifest, profiles }) =>
      profiles.map(
        ({ profileId }) =>
          `${manifest.implementationId}\n${backendKind(manifest.storage)}\n${profileId}`
      )
    )
    .toSorted();
  const actual = rows
    .map(
      ({ implementationId, backend, profile }) =>
        `${implementationId}\n${backend}\n${profile}`
    )
    .toSorted();
  if (
    new Set(actual).size !== actual.length ||
    JSON.stringify(actual) !== JSON.stringify(expected)
  ) {
    throw new Error(
      "compatibility certificate rows do not match the certified implementation, backend, and profile inventory"
    );
  }
  for (const { manifest, adapter, profiles } of adapters) {
    const current = await computeCertificateDigests(manifest, adapter);
    for (const { profileId } of profiles) {
      const row = rows.find(
        (entry) =>
          entry.implementationId === manifest.implementationId &&
          entry.backend === backendKind(manifest.storage) &&
          entry.profile === profileId
      );
      if (row === undefined) {
        throw new Error(`missing certificate row ${profileId}`);
      }
      for (const field of digestFields) {
        if (row.digests[field] !== current[field]) {
          throw new Error(
            `stale certificate digest ${field} for ${manifest.implementationId} ${profileId}`
          );
        }
      }
    }
  }
};

const command = async (args: string[]): Promise<void> => {
  const result = await runCommand(["bun", ...args], {
    cwd: ROOT,
    captureOutput: true,
  });
  if (result.code !== 0) {
    throw new Error(
      `certificate evidence command failed (${result.code}): ${args.join(" ")}\n${result.stderr}\n${result.stdout}`
    );
  }
};

export const collectCompatibilityCertificates = async (): Promise<
  CompatibilityCertificate[]
> => {
  const cache = path.join(ROOT, ".cache");
  await mkdir(cache, { recursive: true });
  const directory = await mkdtemp(
    path.join(cache, "compatibility-certificates-")
  );
  try {
    const reportPath = path.join(directory, "controls.json");
    await command([
      "tools/conformance/meta-conformance/negative-controls.ts",
      "--port",
      "kernel",
      "--report-out",
      reportPath,
    ]);
    const report = object(JSON.parse(await readFile(reportPath, "utf8")));
    const runs = Array.isArray(report.controlRuns)
      ? report.controlRuns
      : [report.controlRun];
    const rows: CompatibilityCertificate[] = [];
    for (const adapter of await certifiedAdapters()) {
      const output = path.join(directory, adapter.project);
      await command([
        "tools/conformance/harness/run.ts",
        "--adapter",
        adapter.adapter,
        "--control-report",
        reportPath,
        "--require-certified",
        "--concurrency",
        "4",
        "--evidence-out",
        path.join(output, "run.json"),
        "--summary-only",
      ]);
      let runId: string | undefined;
      let previousDigests: CertificateDigests | undefined;
      for (const profile of adapter.profiles) {
        const value: unknown = JSON.parse(
          await readFile(
            path.join(output, "certificates", `${profile.profileId}.json`),
            "utf8"
          )
        );
        assertConformanceEvidence(
          value,
          `${adapter.project} ${profile.profileId}`
        );
        const bundle = object(value);
        const certificate = object(bundle.certificate);
        const environment = object(bundle.environment);
        const backend = text(object(environment.backend).kind);
        const currentDigests = digests(bundle.digests);
        const currentRun = text(bundle.runId);
        const controlId = text(bundle.negativeControlRunId);
        const control = object(
          runs.find((run: unknown) => object(run).profile === profile.profileId)
        );
        const controlDigests = object(control.verifierDigests);
        if (
          certificate.status !== "certified" ||
          certificate.complete !== true ||
          certificate.profile !== profile.profileId ||
          backend !== backendKind(adapter.manifest.storage) ||
          control.status !== "pass" ||
          control.id !== controlId ||
          verifierFields.some(
            (field) => currentDigests[field] !== controlDigests[field]
          ) ||
          (runId !== undefined && runId !== currentRun) ||
          (previousDigests !== undefined &&
            JSON.stringify(previousDigests) !== JSON.stringify(currentDigests))
        ) {
          throw new Error(
            `inconsistent certificate bundle for ${adapter.project} ${profile.profileId}`
          );
        }
        runId = currentRun;
        previousDigests = currentDigests;
        rows.push({
          backend,
          digests: currentDigests,
          implementationId: adapter.manifest.implementationId,
          negativeControlRunId: controlId,
          profile: profile.profileId,
          status: "certified",
        });
      }
    }
    await assertCompatibilityCertificates(rows);
    return rows.toSorted((a, b) =>
      `${a.implementationId}\n${a.backend}\n${a.profile}`.localeCompare(
        `${b.implementationId}\n${b.backend}\n${b.profile}`
      )
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};
