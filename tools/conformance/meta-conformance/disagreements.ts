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

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import nodePath from "node:path";
import { isDeepStrictEqual } from "node:util";

import { spawn } from "bun";

import { assertConformanceEvidence } from "../../scripts/lib/conformance-contract.ts";
import type { ConformanceCheckResult } from "../../scripts/lib/conformance-contract.ts";

interface ComparedCheck {
  checkId: string;
  status: string;
  assertionResults: readonly unknown[];
}
interface Disagreement {
  checkId: string;
  differences: string[];
  typescript: { outcome?: ComparedCheck; observations?: unknown };
  rust: { outcome?: ComparedCheck; observations?: unknown };
}

export const compareObservations = (
  typescript: readonly ComparedCheck[],
  rust: readonly ComparedCheck[],
  typescriptObservations: readonly unknown[],
  rustObservations: readonly unknown[]
): Disagreement[] => {
  const indexed = (
    checks: readonly ComparedCheck[],
    observations: readonly unknown[]
  ) =>
    new Map(
      checks.map((check, index) => [
        check.checkId,
        { outcome: check, observations: observations[index] },
      ])
    );
  const left = indexed(typescript, typescriptObservations);
  const right = indexed(rust, rustObservations);
  return [...new Set([...left.keys(), ...right.keys()])]
    .toSorted()
    .flatMap((checkId) => {
      const ts = left.get(checkId);
      const rs = right.get(checkId);
      const differences = [
        ...(ts === undefined || rs === undefined ? ["applicability"] : []),
        ...(ts !== undefined &&
        rs !== undefined &&
        !isDeepStrictEqual(ts.outcome, rs.outcome)
          ? ["outcome"]
          : []),
        ...(ts !== undefined &&
        rs !== undefined &&
        !isDeepStrictEqual(ts.observations, rs.observations)
          ? ["observations"]
          : []),
      ];
      return differences.length === 0
        ? []
        : [{ checkId, differences, typescript: ts ?? {}, rust: rs ?? {} }];
    });
};

export const DISAGREEMENT_DIRECTORY = ".cache/tuvren-certification/DD004";
const ROOT = nodePath.resolve(import.meta.dirname, "../../..");
const digest = (text: string): string =>
  createHash("sha256").update(text).digest("hex");
const outcome = ({
  checkId,
  status,
  assertionResults,
}: ConformanceCheckResult): ComparedCheck => ({
  checkId,
  status,
  assertionResults,
});

const captureImplementation = async (language: string, adapter: string) => {
  const directory = nodePath.resolve(ROOT, DISAGREEMENT_DIRECTORY, language);
  await mkdir(directory, { recursive: true });
  const probes = await mkdtemp(nodePath.join(directory, "observations-"));
  const manifest: unknown = JSON.parse(
    await readFile(nodePath.resolve(ROOT, adapter), "utf-8")
  );
  if (
    typeof manifest !== "object" ||
    manifest === null ||
    !("command" in manifest) ||
    !Array.isArray(manifest.command) ||
    !manifest.command.every((item: unknown) => typeof item === "string")
  ) {
    throw new TypeError(`${adapter} must contain an adapter command`);
  }
  const wrapped = nodePath.join(directory, "adapter.json");
  await writeFile(
    wrapped,
    `${JSON.stringify({ ...manifest, command: ["bun", "tools/conformance/meta-conformance/observation-probe.ts", probes, "--", ...manifest.command] }, null, 2)}\n`
  );
  const evidencePath = nodePath.join(directory, "evidence.json");
  const command = [
    "bun",
    "tools/conformance/harness/run.ts",
    "--adapter",
    wrapped,
    "--capability",
    "kernel.syscall",
    "--concurrency",
    "1",
    "--allow-failing-evidence",
    "--evidence-out",
    evidencePath,
    "--summary-only",
  ];
  const child = spawn(command, {
    cwd: ROOT,
    stdout: "inherit",
    stderr: "inherit",
  });
  if ((await child.exited) !== 0) {
    throw new Error(`${language} comparison harness failed`);
  }
  const text = await readFile(evidencePath, "utf-8");
  const evidence: unknown = JSON.parse(text);
  assertConformanceEvidence(evidence, `${language} comparison evidence`);
  const files = await readdir(probes);
  if (files.length !== 1) {
    throw new Error(
      `${language}: expected one serial observation stream, received ${files.length}`
    );
  }
  const raw = await readFile(nodePath.join(probes, files[0] ?? ""), "utf-8");
  const observations: unknown[] = raw
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  if (observations.length !== evidence.checkResults.length) {
    throw new Error(`${language}: incomplete observation capture`);
  }
  const observationPath = nodePath.join(directory, "observations.json");
  const observationText = `${JSON.stringify(observations, null, 2)}\n`;
  await writeFile(observationPath, observationText);
  return {
    checks: evidence.checkResults.map(outcome),
    observations,
    summary: evidence.summary,
    evidence: nodePath.relative(ROOT, evidencePath),
    evidenceDigest: digest(text),
    observationPath: nodePath.relative(ROOT, observationPath),
    observationDigest: digest(observationText),
  };
};

const main = async (): Promise<void> => {
  const typescript = await captureImplementation(
    "typescript",
    "typescript/kernel/conformance-adapter/adapter.json"
  );
  const rust = await captureImplementation(
    "rust",
    "rust/kernel-conformance-adapter/adapter-syscall.json"
  );
  const disagreements = compareObservations(
    typescript.checks,
    rust.checks,
    typescript.observations,
    rust.observations
  );
  const report = {
    ticketId: "KRT-DD004",
    selection: { capability: "kernel.syscall", concurrency: 1 },
    interpretation:
      "Observations and outcomes only; agreement does not decide authority. Error messages, physical storage summaries, and opaque cursors are compared verbatim.",
    implementations: {
      typescript: {
        evidence: typescript.evidence,
        summary: typescript.summary,
      },
      rust: { evidence: rust.evidence, summary: rust.summary },
    },
    disagreements,
  };
  const reportPath = nodePath.resolve(
    ROOT,
    DISAGREEMENT_DIRECTORY,
    "disagreements.json"
  );
  const text = `${JSON.stringify(report, null, 2)}\n`;
  await writeFile(reportPath, text);
  await writeFile(
    nodePath.resolve(ROOT, DISAGREEMENT_DIRECTORY, "manifest.json"),
    `${JSON.stringify({ ticketId: "KRT-DD004", report: { path: nodePath.relative(ROOT, reportPath), sha256: digest(text) }, inputs: { typescript: { evidence: typescript.evidence, evidenceDigest: typescript.evidenceDigest, observationPath: typescript.observationPath, observationDigest: typescript.observationDigest }, rust: { evidence: rust.evidence, evidenceDigest: rust.evidenceDigest, observationPath: rust.observationPath, observationDigest: rust.observationDigest } }, replay: "bun tools/conformance/meta-conformance/disagreements.ts" }, null, 2)}\n`
  );
  process.stdout.write(
    `${disagreements.length} disagreements written to ${nodePath.relative(ROOT, reportPath)}\n`
  );
};

if (import.meta.main) {
  await main();
}
