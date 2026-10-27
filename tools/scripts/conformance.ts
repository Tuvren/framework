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

// Discovery-driven certification lane (GH issue #87 M2.9). Runs the
// certification-discovery parity gate first, then the `conformance` target of
// exactly the validated fleet. The hardcoded project list this replaces lived
// in package.json's `conformance` script; the fleet is now enumerated by
// tools/conformance/certification/certified-projects.json, whose parity with
// tag-based discovery the gate has just enforced.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();

const gate = spawnSync(
  "bun",
  ["tools/conformance/certification/validate-certification-discovery.ts"],
  { cwd: ROOT, stdio: "inherit" }
);
if (gate.status !== 0) {
  process.exit(gate.status ?? 1);
}

const parsedManifest: unknown = JSON.parse(
  readFileSync(
    path.join(ROOT, "tools/conformance/certification/certified-projects.json"),
    "utf-8"
  )
);
if (!(typeof parsedManifest === "object" && parsedManifest !== null)) {
  throw new TypeError("certified-projects.json must contain string projects");
}
const projectsValue =
  "projects" in parsedManifest ? parsedManifest.projects : undefined;
if (!Array.isArray(projectsValue)) {
  throw new TypeError("certified-projects.json must contain string projects");
}
const projects: string[] = [];
for (const project of projectsValue) {
  if (typeof project !== "string") {
    throw new TypeError("certified-projects.json must contain string projects");
  }
  projects.push(project);
}

const run = spawnSync(
  "bun",
  [
    "./tools/run-nx.mjs",
    "run-many",
    "-t",
    "conformance",
    "-p",
    projects.join(","),
    ...process.argv.slice(2),
  ],
  { cwd: ROOT, stdio: "inherit" }
);

const negativeControls = spawnSync(
  "bun",
  ["tools/conformance/meta-conformance/negative-controls.ts"],
  { cwd: ROOT, stdio: "inherit" }
);
process.exit(
  run.status === 0 ? (negativeControls.status ?? 1) : (run.status ?? 1)
);
