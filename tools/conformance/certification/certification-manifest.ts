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

import { readFile } from "node:fs/promises";
import nodePath from "node:path";

import type { ConformanceRunStatus } from "../../scripts/lib/conformance-contract.js";

export const CERTIFICATION_MANIFEST_PATH =
  "tools/conformance/certification/certified-projects.json";

export interface CertificationInventoryEntry {
  adapter: string;
  project: string;
  state: ConformanceRunStatus;
}

export interface CertifiedEntry {
  profile: string;
  project: string;
}

export interface CertificationManifest {
  certified: readonly CertifiedEntry[];
  inventory: readonly CertificationInventoryEntry[];
  projects: readonly string[];
}

const STATES: ReadonlySet<string> = new Set<ConformanceRunStatus>([
  "fail",
  "not_applicable",
  "pass",
  "unsupported",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readString = (value: unknown, label: string): string => {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }

  return value;
};

const readArray = (value: unknown, label: string): unknown[] => {
  if (!Array.isArray(value)) {
    throw new TypeError(`${label} must be an array`);
  }

  const entries: unknown[] = value;
  return entries;
};

const isState = (value: string): value is ConformanceRunStatus =>
  STATES.has(value);

const readInventoryEntry = (
  value: unknown,
  label: string
): CertificationInventoryEntry => {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object`);
  }

  const state = readString(value.state, `${label}.state`);

  if (!isState(state)) {
    throw new Error(
      `${label}.state must be one of ${[...STATES].toSorted().join(", ")}`
    );
  }

  return {
    adapter: readString(value.adapter, `${label}.adapter`),
    project: readString(value.project, `${label}.project`),
    state,
  };
};

const readCertifiedEntry = (value: unknown, label: string): CertifiedEntry => {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object`);
  }

  return {
    profile: readString(value.profile, `${label}.profile`),
    project: readString(value.project, `${label}.project`),
  };
};

const assertUnique = (values: readonly string[], label: string): void => {
  const seen = new Set<string>();

  for (const value of values) {
    if (seen.has(value)) {
      throw new Error(`${label} lists a duplicate entry ${value}`);
    }
    seen.add(value);
  }
};

export const parseCertificationManifest = (
  value: unknown
): CertificationManifest => {
  if (!isRecord(value)) {
    throw new Error("certification manifest must be an object");
  }

  const projects = readArray(value.projects, "projects").map((entry, index) =>
    readString(entry, `projects[${index}]`)
  );
  const inventory = readArray(value.inventory, "inventory").map(
    (entry, index) => readInventoryEntry(entry, `inventory[${index}]`)
  );
  const certified = readArray(value.certified, "certified").map(
    (entry, index) => readCertifiedEntry(entry, `certified[${index}]`)
  );

  assertUnique(projects, "projects");
  assertUnique(
    inventory.map((entry) => entry.project),
    "inventory"
  );
  assertUnique(
    certified.map((entry) => `${entry.project} (profile ${entry.profile})`),
    "certified"
  );

  const inventoryProjects = inventory.map((entry) => entry.project);
  const divergent = [
    ...projects.filter((project) => !inventoryProjects.includes(project)),
    ...inventoryProjects.filter((project) => !projects.includes(project)),
  ];

  if (divergent.length > 0) {
    throw new Error(
      `inventory and projects must list the same projects; divergent: ${divergent.join(", ")}`
    );
  }

  for (const entry of certified) {
    const state = inventory.find(
      (candidate) => candidate.project === entry.project
    )?.state;

    if (state !== "pass") {
      throw new Error(
        `certified project ${entry.project} must have inventory state pass, found ${state ?? "no inventory entry"}`
      );
    }
  }

  return { certified, inventory, projects };
};

const MUTANT_FLAGS: ReadonlySet<string> = new Set([
  "--mutant",
  "--mutant-from-env",
]);

/**
 * A mutant adapter manifest launches a test-only defective implementation
 * (ADR-0079); it is a negative control and never a certification target.
 */
export const isMutantAdapterCommand = (command: readonly string[]): boolean =>
  command.some((token) => MUTANT_FLAGS.has(token));

export const readCertificationManifest = async (
  path: string
): Promise<CertificationManifest> =>
  parseCertificationManifest(JSON.parse(await readFile(path, "utf-8")));

export const findCertifiedEntriesForAdapter = (
  manifest: CertificationManifest,
  adapterPath: string,
  root: string
): CertifiedEntry[] => {
  const resolvedAdapter = nodePath.resolve(root, adapterPath);
  const projects = new Set(
    manifest.inventory
      .filter(
        (entry) => nodePath.resolve(root, entry.adapter) === resolvedAdapter
      )
      .map((entry) => entry.project)
  );

  return manifest.certified.filter((entry) => projects.has(entry.project));
};
