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
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import nodePath from "node:path";

import { spawn } from "bun";

import { assertConformanceEvidence } from "../../scripts/lib/conformance-contract.ts";
import { readAdapterManifest, readPlans } from "../harness/run-plans.ts";
import {
  compareObservations,
  stabilizeObservations,
  validateObservationSteps,
} from "./observation-comparison.ts";

const ROOT = nodePath.resolve(import.meta.dirname, "../../..");
const digest = (text: string): string =>
  createHash("sha256").update(text).digest("hex");
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
interface Options {
  adapters: string[];
  capabilities: string[];
  output: string;
  summaryOut?: string;
}

const parseCli = (args: readonly string[]): Options => {
  const options: Options = {
    adapters: [],
    capabilities: [],
    output: ".cache/conformance-comparison",
  };
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${flag} requires a value`);
    }
    switch (flag) {
      case "--adapter": {
        options.adapters.push(value);
        break;
      }
      case "--capability": {
        options.capabilities.push(value);
        break;
      }
      case "--output": {
        options.output = value;
        break;
      }
      case "--summary-out": {
        options.summaryOut = value;
        break;
      }
      default: {
        throw new Error(`unknown comparison argument ${flag}`);
      }
    }
  }
  if (options.adapters.length < 2) {
    throw new Error("comparison requires at least two --adapter manifests");
  }
  return options;
};

const captureImplementation = async (adapter: string, options: Options) => {
  const manifest = await readAdapterManifest(adapter);
  const plans = await readPlans(manifest, { packets: [], plans: [] });
  const directory = nodePath.resolve(
    ROOT,
    options.output,
    digest(manifest.implementationId).slice(0, 16)
  );
  await mkdir(directory, { recursive: true });
  const probes = await mkdtemp(nodePath.join(directory, "observations-"));
  try {
    const wrapped = nodePath.join(directory, "adapter.json");
    await writeFile(
      wrapped,
      json({
        ...manifest,
        command: [
          "bun",
          "tools/conformance/meta-conformance/observation-probe.ts",
          probes,
          "--",
          ...manifest.command,
        ],
      })
    );
    const evidencePath = nodePath.join(directory, "evidence.json");
    const child = spawn(
      [
        "bun",
        "tools/conformance/harness/run.ts",
        "--adapter",
        wrapped,
        ...options.capabilities.flatMap((capability) => [
          "--capability",
          capability,
        ]),
        "--concurrency",
        "1",
        "--allow-failing-evidence",
        "--evidence-out",
        evidencePath,
        "--summary-only",
      ],
      { cwd: ROOT, stderr: "inherit", stdout: "inherit" }
    );
    if ((await child.exited) !== 0) {
      throw new Error(
        `${manifest.implementationId}: comparison harness failed`
      );
    }
    const evidenceText = await readFile(evidencePath, "utf-8");
    const evidence: unknown = JSON.parse(evidenceText);
    assertConformanceEvidence(
      evidence,
      `${manifest.implementationId} comparison evidence`
    );
    const inventory = evidence.selection;
    if (inventory === undefined) {
      throw new Error(
        "comparison evidence is missing the harness selection inventory"
      );
    }
    const files = await readdir(probes);
    if (files.length !== 1) {
      throw new Error(
        `${manifest.implementationId}: expected one serial observation stream, received ${files.length}`
      );
    }
    const raw = await readFile(nodePath.join(probes, files[0] ?? ""), "utf-8");
    const observations: unknown[] = raw
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    if (observations.length !== evidence.checkResults.length) {
      throw new Error(
        `${manifest.implementationId}: incomplete observation capture`
      );
    }
    const checksById = new Map(
      plans.flatMap(({ checks }) =>
        checks.map(({ check }) => [check.checkId, check] as const)
      )
    );
    for (const [index, check] of evidence.checkResults.entries()) {
      const planCheck = checksById.get(check.checkId);
      if (planCheck === undefined || planCheck.steps === undefined) {
        throw new Error(`${check.checkId}: comparison requires a trace plan`);
      }
      validateObservationSteps(
        check.checkId,
        planCheck.steps,
        observations[index]
      );
    }
    const selected = inventory
      .filter(({ selected: applies }) => applies)
      .map(({ checkId }) => checkId)
      .toSorted();
    if (
      selected.join("\n") !==
      evidence.checkResults
        .map(({ checkId }) => checkId)
        .toSorted()
        .join("\n")
    ) {
      throw new Error(
        `${manifest.implementationId}: evidence disagrees with selection inventory`
      );
    }
    const stable = observations.map((observation) =>
      stabilizeObservations(observation)
    );
    const observationPath = nodePath.join(directory, "observations.json");
    const observationText = json(stable);
    await writeFile(observationPath, observationText);
    return {
      adapter,
      checks: evidence.checkResults.map(
        ({ checkId, status, assertionResults }) => ({
          assertionResults,
          checkId,
          status,
        })
      ),
      evidence: nodePath.relative(ROOT, evidencePath),
      evidenceDigest: digest(evidenceText),
      implementationId: manifest.implementationId,
      observationDigest: digest(observationText),
      observationPath: nodePath.relative(ROOT, observationPath),
      observations: stable,
      selection: inventory,
      summary: evidence.summary,
    };
  } finally {
    await rm(probes, { force: true, recursive: true });
  }
};

const main = async (): Promise<void> => {
  const options = parseCli(process.argv.slice(2));
  const implementations: Awaited<ReturnType<typeof captureImplementation>>[] =
    [];
  const captureNext = async (index: number): Promise<void> => {
    const adapter = options.adapters[index];
    if (adapter === undefined) {
      return;
    }
    const captured = await captureImplementation(adapter, options);
    if (
      implementations.some(
        ({ implementationId }) => implementationId === captured.implementationId
      )
    ) {
      throw new Error(
        `duplicate implementation id ${captured.implementationId}`
      );
    }
    implementations.push(captured);
    await captureNext(index + 1);
  };
  await captureNext(0);
  const differences = compareObservations(implementations);
  const classifications = ["sanctioned", "disagreement", "coverage"] as const;
  const counts = Object.fromEntries(
    classifications.map((classification) => [
      classification,
      {
        checks: new Set(
          differences
            .filter((entry) => entry.classification === classification)
            .map(({ checkId }) => checkId)
        ).size,
        differences: differences.filter(
          (entry) => entry.classification === classification
        ).length,
      },
    ])
  );
  const report = {
    counts,
    differences,
    implementations: implementations.map(
      ({ implementationId, adapter, evidence, summary, selection }) => ({
        adapter,
        evidence,
        implementationId,
        selection,
        summary,
      })
    ),
    interpretation:
      "Uncertified observations and outcomes. Sanctioned variation cites authority; coverage records applicability gaps; disagreement means no authority rule decides the difference. Tagged maps compare by key. Fencing tokens are consistently pseudonymized per trace before hashing.",
    selection: { capabilities: options.capabilities, concurrency: 1 },
  };
  const reportPath = nodePath.resolve(
    ROOT,
    options.output,
    "disagreements.json"
  );
  const text = json(report);
  await writeFile(reportPath, text);
  const replay = [
    "bun",
    "tools/conformance/meta-conformance/disagreements.ts",
    ...options.adapters.flatMap((adapter) => ["--adapter", adapter]),
    ...options.capabilities.flatMap((capability) => [
      "--capability",
      capability,
    ]),
    "--output",
    options.output,
  ]
    .map((arg) => `'${arg.replaceAll("'", "'\\''")}'`)
    .join(" ");
  await writeFile(
    nodePath.resolve(ROOT, options.output, "manifest.json"),
    json({
      inputs: implementations.map(
        ({
          implementationId,
          evidence,
          evidenceDigest,
          observationPath,
          observationDigest,
        }) => ({
          evidence,
          evidenceDigest,
          implementationId,
          observationDigest,
          observationPath,
        })
      ),
      replay,
      report: {
        path: nodePath.relative(ROOT, reportPath),
        sha256: digest(text),
      },
    })
  );
  if (options.summaryOut !== undefined) {
    const rows = differences.map(
      ({ checkId, kind, path, classification, citation }) =>
        `| ${checkId} | ${kind} | ${path} | ${classification} | ${citation ?? "No deciding authority rule"} |`
    );
    await mkdir(nodePath.dirname(options.summaryOut), { recursive: true });
    await writeFile(
      options.summaryOut,
      `# Observation comparison\n\n${json(counts)}\n| Check | Kind | Path | Classification | Citation |\n| --- | --- | --- | --- | --- |\n${rows.join("\n")}\n`
    );
  }
  process.stdout.write(
    `${JSON.stringify(counts)} written to ${nodePath.relative(ROOT, reportPath)}\n`
  );
};

if (import.meta.main) {
  await main();
}
