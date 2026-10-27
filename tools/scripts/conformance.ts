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
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";

import { readClaimedProfiles } from "../conformance/certification/profile.js";
import { readAdapterManifest } from "../conformance/harness/run-plans.js";

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

const cacheRoot = path.join(ROOT, ".cache");
mkdirSync(cacheRoot, { recursive: true });
const directory = mkdtempSync(path.join(cacheRoot, "conformance-controls-"));
let exitCode = run.status ?? 1;
try {
  const report = path.join(directory, "negative-controls.json");
  const negativeControls = spawnSync(
    "bun",
    [
      "tools/conformance/meta-conformance/negative-controls.ts",
      "--report-out",
      report,
    ],
    { cwd: ROOT, stdio: "inherit" }
  );
  if (exitCode === 0) {
    exitCode = negativeControls.status ?? 1;
  }
  const certified =
    "certified" in parsedManifest && Array.isArray(parsedManifest.certified)
      ? parsedManifest.certified
      : [];
  const inventory =
    "inventory" in parsedManifest && Array.isArray(parsedManifest.inventory)
      ? parsedManifest.inventory
      : [];
  if (exitCode === 0) {
    for (const entry of certified) {
      if (
        typeof entry !== "object" ||
        entry === null ||
        !("profile" in entry) ||
        typeof entry.profile !== "string" ||
        !("project" in entry)
      ) {
        continue;
      }
      const match = inventory.find(
        (candidate: unknown) =>
          typeof candidate === "object" &&
          candidate !== null &&
          "project" in candidate &&
          candidate.project === entry.project
      );
      if (
        !(
          typeof match === "object" &&
          match !== null &&
          "adapter" in match &&
          typeof match.adapter === "string"
        )
      ) {
        throw new Error(
          `missing adapter for certified project ${String(entry.project)}`
        );
      }
      const adapterManifest = await readAdapterManifest(
        path.resolve(ROOT, match.adapter)
      );
      const declared = new Set<string>();
      for (const packetPath of adapterManifest.authorityPackets) {
        const packet: unknown = JSON.parse(
          readFileSync(path.resolve(ROOT, packetPath), "utf8")
        );
        if (
          !(
            typeof packet === "object" &&
            packet !== null &&
            "certificationProfiles" in packet &&
            typeof packet.certificationProfiles === "string"
          )
        ) {
          continue;
        }
        const document: unknown = JSON.parse(
          readFileSync(path.resolve(ROOT, packet.certificationProfiles), "utf8")
        );
        if (
          !(
            typeof document === "object" &&
            document !== null &&
            "profiles" in document &&
            Array.isArray(document.profiles)
          )
        ) {
          throw new Error(`${packet.certificationProfiles}: invalid profiles`);
        }
        for (const profile of document.profiles) {
          if (
            !(
              typeof profile === "object" &&
              profile !== null &&
              "profileId" in profile &&
              typeof profile.profileId === "string"
            )
          ) {
            throw new Error(`${packet.certificationProfiles}: invalid profile`);
          }
          declared.add(profile.profileId);
        }
      }
      if (!declared.has(entry.profile)) {
        if (entry.profile !== adapterManifest.suiteId) {
          throw new Error(
            `${entry.profile} is not declared by ${match.adapter}'s authority packets`
          );
        }
        continue;
      }
      const claimed = await readClaimedProfiles(
        adapterManifest,
        adapterManifest.authorityPackets
      );
      if (!claimed.some((profile) => profile.profileId === entry.profile)) {
        throw new Error(
          `${match.adapter} does not claim required profile ${entry.profile}`
        );
      }
      const certificate = spawnSync(
        "bun",
        [
          "tools/conformance/harness/run.ts",
          "--adapter",
          match.adapter,
          "--control-report",
          report,
          "--require-certified",
          "--concurrency",
          "4",
          "--summary-only",
        ],
        { cwd: ROOT, stdio: "inherit" }
      );
      if (certificate.status !== 0) {
        exitCode = certificate.status ?? 1;
        break;
      }
    }
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}
process.exit(exitCode);
