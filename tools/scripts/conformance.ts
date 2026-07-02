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

import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();

const gate = Bun.spawnSync(
  [
    "bun",
    "tools/conformance/certification/validate-certification-discovery.ts",
  ],
  { cwd: ROOT, stderr: "inherit", stdout: "inherit" }
);
if (gate.exitCode !== 0) {
  process.exit(gate.exitCode ?? 1);
}

const manifest: { projects: string[] } = JSON.parse(
  readFileSync(
    join(ROOT, "tools/conformance/certification/certified-projects.json"),
    "utf8"
  )
);

const run = Bun.spawnSync(
  [
    "bun",
    "./tools/run-nx.mjs",
    "run-many",
    "-t",
    "conformance",
    "-p",
    manifest.projects.join(","),
  ],
  { cwd: ROOT, stderr: "inherit", stdout: "inherit" }
);
process.exit(run.exitCode ?? 1);
