import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import type {
  ConformanceCheckResult,
  ConformanceEvidence,
} from "../../scripts/lib/conformance-contract.js";
import type { AdapterManifest } from "../harness/adapter-client.js";
import type { CertifiedEntry } from "./certification-manifest.js";
import type { ProfileBundle } from "./profile-bundles.js";

interface OutputOptions {
  controlReport?: string;
  evidenceOut?: string;
  requireCertified: boolean;
  summaryOnly: boolean;
}

const ROOT = path.resolve(import.meta.dirname, "../../..");

export const writeRunOutput = async (
  options: OutputOptions,
  manifest: AdapterManifest,
  evidence: ConformanceEvidence,
  bundles: readonly ProfileBundle[],
  previewFailure: (result: ConformanceCheckResult) => ConformanceCheckResult
): Promise<void> => {
  const single = bundles.length === 1 ? bundles[0] : undefined;
  const output =
    options.controlReport === undefined
      ? evidence
      : (single?.evidence ?? evidence);
  const text = `${JSON.stringify(
    {
      ...output,
      ...(single?.fields ?? {}),
      checkResults: output.checkResults.map(previewFailure),
    },
    null,
    2
  )}\n`;
  if (options.evidenceOut !== undefined) {
    const destination = path.resolve(ROOT, options.evidenceOut);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, text);
  }
  if (
    bundles.length > 0 &&
    (options.evidenceOut !== undefined || options.controlReport !== undefined)
  ) {
    const directory =
      options.evidenceOut === undefined
        ? path.resolve(
            ROOT,
            ".cache/certification",
            manifest.implementationId,
            evidence.runId ?? "run",
            "certificates"
          )
        : path.join(
            path.dirname(path.resolve(ROOT, options.evidenceOut)),
            "certificates"
          );
    await mkdir(directory, { recursive: true });
    for (const bundle of bundles) {
      await writeFile(
        path.join(directory, `${bundle.profileId}.json`),
        `${JSON.stringify(
          {
            ...bundle.evidence,
            ...bundle.fields,
            checkResults: bundle.evidence.checkResults.map(previewFailure),
          },
          null,
          2
        )}\n`
      );
    }
  }
  if (options.summaryOnly) {
    process.stdout.write(
      `${JSON.stringify(
        {
          adapterId: evidence.adapterId,
          implementationId: evidence.implementationId,
          ...(single?.fields.certificate === undefined
            ? {}
            : { certificate: single.fields.certificate }),
          status: evidence.status,
          suiteId: evidence.suiteId,
          suiteVersion: evidence.suiteVersion,
          summary: evidence.summary,
        },
        null,
        2
      )}\n`
    );
  } else {
    process.stdout.write(text);
  }
};

export const requiredCertificatesPassed = (
  required: boolean,
  bundles: readonly ProfileBundle[],
  missing: readonly CertifiedEntry[]
): boolean => {
  const incomplete = bundles.filter(
    (bundle) => bundle.fields.certificate?.status !== "certified"
  );
  if (
    !required ||
    (missing.length === 0 && bundles.length > 0 && incomplete.length === 0)
  ) {
    return true;
  }
  const names = [
    ...missing.map((entry) => entry.profile),
    ...incomplete.map((bundle) => bundle.profileId),
  ];
  process.stderr.write(
    `the requested certificate is incomplete or lacks a matching passing control run: ${names.join(", ") || "no certified profiles"}\n`
  );
  return false;
};

export const certifiedSelectionPassed = (
  entries: readonly CertifiedEntry[],
  applicableCount: number
): boolean => {
  if (entries.length === 0 || applicableCount > 0) {
    return true;
  }
  for (const entry of entries) {
    process.stderr.write(
      `certified project ${entry.project} (profile ${entry.profile}) selected zero applicable checks; a certified run must exercise its profile\n`
    );
  }
  return false;
};
