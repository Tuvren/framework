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
 * Workspace test-lane coverage gate (GH issue #87 M3.1).
 *
 * `verify`'s "transition-line targeted tests" step runs the curated
 * WORKSPACE_TEST_PROJECTS list, and curated lists rot: the M2.5 review found
 * `sdk` and `shared-core` unit tests running in no verify lane at all. This
 * gate makes that class of drift loud: every Nx project that declares a
 * `test` target must either be registered in WORKSPACE_TEST_PROJECTS or
 * carry an explicit exclusion here with a reason that is itself checked.
 *
 * Current exclusions are the cargo-based projects, whose tests run in
 * verify's dedicated "Rust workspace tests" step (`cargo test --workspace`);
 * the gate asserts each excluded project's test command still invokes cargo,
 * so an exclusion cannot silently outlive its justification.
 */

import { loadNxProjectFiles, targetCommandStrings } from "./lib/nx-projects.js";
import { WORKSPACE_TEST_PROJECTS } from "./verify.js";

// Token match, not substring: "cargo" must appear as a standalone command
// word so e.g. a wrapper named cargo-shim.ts cannot satisfy the check.
const CARGO_COMMAND_TOKEN = /(^|\s)cargo(\s|$)/;

const EXCLUDED_TEST_PROJECTS: ReadonlyMap<string, string> = new Map([
  [
    "kernel-rust-kernel",
    "covered by verify's Rust workspace tests step (cargo test --workspace)",
  ],
  [
    "kernel-rust-grpc-service",
    "covered by verify's Rust workspace tests step (cargo test --workspace)",
  ],
  [
    "kernel-rust-certification",
    "covered by verify's Rust workspace tests step (cargo test --workspace)",
  ],
  [
    "framework-rust-certification",
    "covered by verify's Rust workspace tests step (cargo test --workspace)",
  ],
]);

function fail(problems: string[]): never {
  console.error("workspace-test-coverage: FAIL");
  for (const problem of problems) {
    console.error(`  - ${problem}`);
  }
  process.exit(1);
}

const projects = loadNxProjectFiles(process.cwd());
const byName = new Map(projects.map((p) => [p.name, p]));
const registered = new Set(WORKSPACE_TEST_PROJECTS);
const problems: string[] = [];

if (registered.size !== WORKSPACE_TEST_PROJECTS.length) {
  problems.push("WORKSPACE_TEST_PROJECTS lists a duplicate project id");
}

const withTestTarget = projects.filter(
  (p) => p.project.targets?.test !== undefined
);
const withTestTargetNames = new Set(withTestTarget.map((p) => p.name));

for (const project of withTestTarget) {
  const isRegistered = registered.has(project.name);
  const isExcluded = EXCLUDED_TEST_PROJECTS.has(project.name);
  if (isRegistered && isExcluded) {
    problems.push(
      `${project.name} (${project.path}) is both in WORKSPACE_TEST_PROJECTS and excluded — pick one`
    );
  }
  if (!(isRegistered || isExcluded)) {
    problems.push(
      `${project.name} (${project.path}) declares a test target but runs in no verify lane — add it to WORKSPACE_TEST_PROJECTS in tools/scripts/verify.ts or record an exclusion with a reason in tools/scripts/validate-workspace-test-coverage.ts`
    );
  }
}

for (const name of WORKSPACE_TEST_PROJECTS) {
  if (!withTestTargetNames.has(name)) {
    problems.push(
      `WORKSPACE_TEST_PROJECTS lists ${name} but no Nx project with that name declares a test target — if it moved or was retired, update tools/scripts/verify.ts deliberately`
    );
  }
}

for (const [name, reason] of EXCLUDED_TEST_PROJECTS) {
  const project = byName.get(name);
  if (project === undefined || project.project.targets?.test === undefined) {
    problems.push(
      `exclusion for ${name} is stale — no Nx project with that name declares a test target`
    );
    continue;
  }
  const commands = targetCommandStrings(project.project.targets.test);
  if (!commands.some((command) => CARGO_COMMAND_TOKEN.test(command))) {
    problems.push(
      `exclusion for ${name} (${project.path}) claims "${reason}" but its test command no longer invokes cargo: "${commands.join("; ")}"`
    );
  }
}

if (problems.length > 0) {
  fail(problems);
}

console.log(
  `workspace-test-coverage: OK — ${withTestTargetNames.size} test-target projects: ${registered.size} in the verify test lane, ${EXCLUDED_TEST_PROJECTS.size} cargo-covered exclusions`
);
