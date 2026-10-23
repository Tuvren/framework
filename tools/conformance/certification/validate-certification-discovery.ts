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

/**
 * Certification-discovery parity gate (GH issue #87 M2.9).
 *
 * Discovers the certification fleet from the repo itself — every Nx project
 * tagged `layer:certification` — and hard-fails unless that discovered
 * set exactly matches the checked-in inventory
 * (`certified-projects.json`), every discovered project actually exposes a
 * `conformance` target, every target that invokes the shared semantic engine
 * belongs to the fleet, and every other `conformance` target is explicitly
 * classified as non-certification (`layer:testkit`). Each inventory entry
 * must name the adapter its engine command drives and the raw status its
 * checked-in compatibility evidence records (ADR-0031, ADR-0081), and each
 * certified entry's profile must be its adapter manifest's suiteId until
 * certification profiles exist.
 *
 * Failure modes this makes loud instead of silent:
 *  - a runner project moved/retired without deliberate manifest maintenance
 *    (discovered ⊂ manifest, or manifest ⊂ discovered);
 *  - a new runner wired to the shared engine but never registered;
 *  - a `conformance` target added without declaring whether it certifies;
 *  - a mutant adapter manifest (ADR-0079 negative control) wired into the
 *    certification fleet.
 *
 * Known residual sliver: the engine back-check matches the engine path as a
 * command-text substring, so a target that reaches the engine INDIRECTLY
 * (a wrapper shell script or intermediate bun script that itself invokes
 * run.ts) escapes it. The conformance-target classification check and the
 * tag/manifest parity still cover such a project if it certifies through a
 * `conformance` target — but if you introduce an engine wrapper script,
 * extend the match here to include the wrapper's path.
 *
 * Discovery reads `project.json` files directly (filesystem walk via the
 * shared tools/scripts/lib/nx-projects.ts index, no Nx daemon) so the gate
 * stays sub-second and sees unstaged working-tree state. Projects declared
 * without a `project.json` would be invisible to it; this repo defines every
 * Nx project through `project.json`, and the manifest cross-check catches a
 * runner disappearing from discovery for any reason.
 */

import { readFileSync } from "node:fs";
import nodePath from "node:path";

import {
  loadNxProjectFiles,
  targetCommandStrings,
} from "../../scripts/lib/nx-projects.js";
import {
  CERTIFICATION_MANIFEST_PATH,
  isMutantAdapterCommand,
  parseCertificationManifest,
} from "./certification-manifest.js";
import type { CertificationManifest } from "./certification-manifest.js";

const ROOT = process.cwd();
const MANIFEST_PATH = nodePath.join(ROOT, CERTIFICATION_MANIFEST_PATH);
const EVIDENCE_DIRECTORY = nodePath.join(
  ROOT,
  "reports/compatibility/evidence"
);
const CERTIFICATION_TAG = "layer:certification";
const NON_CERTIFICATION_TAG = "layer:testkit";
const SHARED_ENGINE_PATH = "tools/conformance/harness/run.ts";

interface ProjectRecord {
  engineCommands: readonly string[];
  /**
   * Names of targets (any target, not just `conformance`) whose command
   * strings — base `options` plus `configurations` overrides, both the
   * single-string and `commands`-array shapes — invoke the shared engine.
   * The back-check must see every shape and every target name, or a
   * runner wired to the engine under a different target name or an
   * alternate command shape silently escapes the certified fleet.
   */
  engineInvokingTargets: readonly string[];
  hasConformanceTarget: boolean;
  name: string;
  path: string;
  tags: readonly string[];
}

const readJsonRecord = (path: string): Record<string, unknown> | undefined => {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf-8"));
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value))
      : undefined;
  } catch {
    return undefined;
  }
};

const WHITESPACE = /\s+/u;

const drivesAdapter = (command: string, adapter: string): boolean => {
  const tokens = command.split(WHITESPACE);
  return tokens.some(
    (token, index) => token === "--adapter" && tokens[index + 1] === adapter
  );
};

const drivenAdapters = (command: string): string[] => {
  const tokens = command.split(WHITESPACE);
  return tokens.flatMap((token, index) => {
    const adapter = tokens[index + 1];
    return token === "--adapter" && adapter !== undefined ? [adapter] : [];
  });
};

const launchesMutant = (adapter: string): boolean => {
  const command = readJsonRecord(nodePath.join(ROOT, adapter))?.command;
  return Array.isArray(command) && isMutantAdapterCommand(command.map(String));
};

const loadProjects = (): ProjectRecord[] =>
  loadNxProjectFiles(ROOT).map((file) => {
    const targets = file.project.targets ?? {};
    const engineInvokingTargets = Object.entries(targets)
      .filter(([, target]) =>
        targetCommandStrings(target).some((command) =>
          command.includes(SHARED_ENGINE_PATH)
        )
      )
      .map(([targetName]) => targetName);
    const engineCommands = Object.values(targets).flatMap((target) =>
      targetCommandStrings(target).filter((command) =>
        command.includes(SHARED_ENGINE_PATH)
      )
    );
    return {
      engineCommands,
      engineInvokingTargets,
      hasConformanceTarget: targets.conformance !== undefined,
      name: file.name,
      path: file.path,
      tags: file.project.tags ?? [],
    };
  });

const fail: (problems: string[]) => never = (problems) => {
  console.error("certification-discovery: FAIL");
  for (const problem of problems) {
    console.error(`  - ${problem}`);
  }
  process.exit(1);
};

const readManifest = (): CertificationManifest => {
  try {
    return parseCertificationManifest(
      JSON.parse(readFileSync(MANIFEST_PATH, "utf-8"))
    );
  } catch (error: unknown) {
    return fail([error instanceof Error ? error.message : String(error)]);
  }
};
const manifest = readManifest();
const manifestSet = new Set(manifest.projects);

const projects = loadProjects();
const byName = new Map(projects.map((p) => [p.name, p]));
if (byName.size !== projects.length) {
  const seen = new Set<string>();
  const dupes: string[] = [];
  for (const p of projects) {
    if (seen.has(p.name)) {
      dupes.push(`${p.name} (${p.path})`);
    }
    seen.add(p.name);
  }
  fail([`duplicate Nx project names in the tree: ${dupes.join(", ")}`]);
}

const discovered = projects.filter((p) => p.tags.includes(CERTIFICATION_TAG));
const discoveredNames = new Set(discovered.map((p) => p.name));
const problems: string[] = [];

for (const project of discovered) {
  if (!project.hasConformanceTarget) {
    problems.push(
      `${project.name} (${project.path}) is tagged ${CERTIFICATION_TAG} but has no conformance target`
    );
  }
}

for (const name of manifest.projects) {
  if (!discoveredNames.has(name)) {
    problems.push(
      `manifest lists ${name} but no project tagged ${CERTIFICATION_TAG} with that name exists — if it was retired or renamed, update ${nodePath.relative(ROOT, MANIFEST_PATH)} deliberately`
    );
  }
}
for (const project of discovered) {
  if (!manifestSet.has(project.name)) {
    problems.push(
      `${project.name} (${project.path}) is tagged ${CERTIFICATION_TAG} but is not registered in ${nodePath.relative(ROOT, MANIFEST_PATH)} — register it so the certification lane runs it`
    );
  }
}

for (const project of projects) {
  // Engine back-check: ANY target invoking the shared engine — whatever the
  // target is named, whichever command shape or configuration override it
  // uses — must belong to the certified fleet or be explicitly classified
  // non-certification.
  if (
    project.engineInvokingTargets.length > 0 &&
    !(
      discoveredNames.has(project.name) ||
      project.tags.includes(NON_CERTIFICATION_TAG)
    )
  ) {
    problems.push(
      `${project.name} (${project.path}) invokes the shared engine (${SHARED_ENGINE_PATH}) from target(s) ${project.engineInvokingTargets.join(", ")} but is neither tagged ${CERTIFICATION_TAG} nor ${NON_CERTIFICATION_TAG}`
    );
  }
  if (
    project.hasConformanceTarget &&
    !(
      discoveredNames.has(project.name) ||
      project.tags.includes(NON_CERTIFICATION_TAG)
    )
  ) {
    problems.push(
      `${project.name} (${project.path}) has a conformance target but is neither tagged ${CERTIFICATION_TAG} (certification fleet) nor ${NON_CERTIFICATION_TAG} (explicitly non-certification) — classify it`
    );
  }
}

for (const project of discovered) {
  for (const adapter of project.engineCommands.flatMap(drivenAdapters)) {
    if (launchesMutant(adapter)) {
      problems.push(
        `${project.name} (${project.path}) drives mutant adapter manifest ${adapter}; negative controls never certify (ADR-0079)`
      );
    }
  }
}

for (const entry of manifest.inventory) {
  if (launchesMutant(entry.adapter)) {
    problems.push(
      `inventory lists mutant adapter manifest ${entry.adapter} for ${entry.project}; negative controls never certify (ADR-0079)`
    );
  }
  const project = byName.get(entry.project);
  if (
    project !== undefined &&
    !project.engineCommands.some((command) =>
      drivesAdapter(command, entry.adapter)
    )
  ) {
    problems.push(
      `inventory lists adapter ${entry.adapter} for ${entry.project}, but no engine command of that project passes --adapter ${entry.adapter}`
    );
  }

  const evidencePath = nodePath.join(
    EVIDENCE_DIRECTORY,
    `certification-harness.${entry.project}.json`
  );
  const recordedState = readJsonRecord(evidencePath)?.status;
  if (recordedState !== entry.state) {
    problems.push(
      `inventory state ${entry.state} for ${entry.project} does not match ${String(recordedState)} recorded in ${nodePath.relative(ROOT, evidencePath)}`
    );
  }
}

for (const entry of manifest.certified) {
  const adapter = manifest.inventory.find(
    (candidate) => candidate.project === entry.project
  )?.adapter;
  const suiteId =
    adapter === undefined
      ? undefined
      : readJsonRecord(nodePath.join(ROOT, adapter))?.suiteId;
  if (suiteId !== entry.profile) {
    problems.push(
      `certified profile ${entry.profile} for ${entry.project} must equal its adapter manifest suiteId (${String(suiteId)}) until certification profiles exist`
    );
  }
}

if (problems.length > 0) {
  fail(problems);
}

console.log(
  `certification-discovery: OK — ${discovered.length} certification runners discovered, inventory in exact parity, ${manifest.certified.length} certified`
);
