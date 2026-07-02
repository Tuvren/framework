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
 * tagged `layer:conformance-runner` — and hard-fails unless that discovered
 * set exactly matches the checked-in manifest
 * (`certified-projects.json`), every discovered project actually exposes a
 * `conformance` target, every target that invokes the shared semantic engine
 * belongs to the fleet, and every other `conformance` target is explicitly
 * classified as non-certification (`layer:testkit`).
 *
 * Failure modes this makes loud instead of silent:
 *  - a runner project moved/retired without deliberate manifest maintenance
 *    (discovered ⊂ manifest, or manifest ⊂ discovered);
 *  - a new runner wired to the shared engine but never registered;
 *  - a `conformance` target added without declaring whether it certifies.
 *
 * Discovery reads `project.json` files directly (filesystem walk, no Nx
 * daemon) so the gate stays sub-second and sees unstaged working-tree state.
 * Projects declared without a `project.json` would be invisible to it; this
 * repo defines every Nx project through `project.json`, and the manifest
 * cross-check catches a runner disappearing from discovery for any reason.
 */

import { readFileSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const MANIFEST_PATH = join(
  ROOT,
  "tools/conformance/certification/certified-projects.json"
);
const CERTIFICATION_TAG = "layer:conformance-runner";
const NON_CERTIFICATION_TAG = "layer:testkit";
const SHARED_ENGINE_PATH = "tools/conformance/runner/run.ts";

interface ProjectRecord {
  conformanceCommand: string | undefined;
  hasConformanceTarget: boolean;
  name: string;
  path: string;
  tags: readonly string[];
}

function loadProjects(): ProjectRecord[] {
  const glob = new Bun.Glob("**/project.json");
  const records: ProjectRecord[] = [];
  for (const match of glob.scanSync({ cwd: ROOT, dot: false })) {
    if (match.includes("node_modules/") || match.includes("dist/")) {
      continue;
    }
    const absolute = join(ROOT, match);
    let parsed: {
      name?: string;
      tags?: string[];
      targets?: Record<string, { options?: { command?: string } }>;
    };
    try {
      parsed = JSON.parse(readFileSync(absolute, "utf8"));
    } catch (error) {
      throw new Error(`unparseable project.json at ${match}: ${error}`);
    }
    if (typeof parsed.name !== "string") {
      continue;
    }
    const conformance = parsed.targets?.conformance;
    records.push({
      conformanceCommand: conformance?.options?.command,
      hasConformanceTarget: conformance !== undefined,
      name: parsed.name,
      path: relative(ROOT, absolute),
      tags: parsed.tags ?? [],
    });
  }
  return records;
}

function fail(problems: string[]): never {
  console.error("certification-discovery: FAIL");
  for (const problem of problems) {
    console.error(`  - ${problem}`);
  }
  process.exit(1);
}

const manifest: { projects: string[] } = JSON.parse(
  readFileSync(MANIFEST_PATH, "utf8")
);
const manifestSet = new Set(manifest.projects);
if (manifestSet.size !== manifest.projects.length) {
  fail(["manifest lists a duplicate project id"]);
}

const projects = loadProjects();
const byName = new Map(projects.map((p) => [p.name, p]));
if (byName.size !== projects.length) {
  const seen = new Set<string>();
  const dupes = projects
    .filter((p) => (seen.has(p.name) ? true : (seen.add(p.name), false)))
    .map((p) => `${p.name} (${p.path})`);
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
      `manifest lists ${name} but no project tagged ${CERTIFICATION_TAG} with that name exists — if it was retired or renamed, update ${relative(ROOT, MANIFEST_PATH)} deliberately`
    );
  }
}
for (const project of discovered) {
  if (!manifestSet.has(project.name)) {
    problems.push(
      `${project.name} (${project.path}) is tagged ${CERTIFICATION_TAG} but is not registered in ${relative(ROOT, MANIFEST_PATH)} — register it so the certification lane runs it`
    );
  }
}

for (const project of projects) {
  if (!project.hasConformanceTarget) {
    continue;
  }
  const invokesEngine =
    project.conformanceCommand?.includes(SHARED_ENGINE_PATH) === true;
  if (invokesEngine && !discoveredNames.has(project.name)) {
    problems.push(
      `${project.name} (${project.path}) invokes the shared engine (${SHARED_ENGINE_PATH}) but is not tagged ${CERTIFICATION_TAG}`
    );
  }
  if (
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

if (problems.length > 0) {
  fail(problems);
}

console.log(
  `certification-discovery: OK — ${discovered.length} certification runners discovered, manifest in exact parity`
);
