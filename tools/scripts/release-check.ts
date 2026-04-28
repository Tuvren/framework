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
import process from "node:process";
import {
  hasVerificationFailure,
  printVerificationSummary,
  runVerification,
} from "./verify.js";

interface RuntimeVersionReport {
  declaredBunVersion?: string;
  observedBunVersion?: string;
  observedNodeVersion: string;
}

const PACKAGE_JSON_PATH = new URL("../../package.json", import.meta.url);

const runtimeReport = await readRuntimeVersionReport();

console.log("Epic Q release check");
console.log(`- declared Bun: ${runtimeReport.declaredBunVersion ?? "unknown"}`);
console.log(`- observed Bun: ${runtimeReport.observedBunVersion ?? "unknown"}`);
console.log(`- observed Node: ${runtimeReport.observedNodeVersion}`);

if (
  runtimeReport.declaredBunVersion !== undefined &&
  runtimeReport.observedBunVersion !== undefined &&
  runtimeReport.declaredBunVersion !== runtimeReport.observedBunVersion
) {
  console.log(
    "- runtime drift: observed Bun differs from packageManager declaration; reported but not treated as a release gate"
  );
}

const results = await runVerification();
printVerificationSummary(results);

if (hasVerificationFailure(results)) {
  process.exitCode = 1;
} else {
  console.log("");
  console.log("Epic Q release check completed successfully.");
}

async function readRuntimeVersionReport(): Promise<RuntimeVersionReport> {
  const packageJsonText = await readFile(PACKAGE_JSON_PATH, "utf8");
  const packageJson = JSON.parse(packageJsonText);
  const packageManager = readStringProperty(packageJson, "packageManager");

  return {
    declaredBunVersion: parseDeclaredBunVersion(packageManager),
    observedBunVersion: process.versions.bun,
    observedNodeVersion: process.version,
  };
}

function parseDeclaredBunVersion(
  packageManager: string | undefined
): string | undefined {
  if (packageManager === undefined) {
    return undefined;
  }

  const [manager, version] = packageManager.split("@");

  if (manager !== "bun" || version === undefined || version.length === 0) {
    return undefined;
  }

  return version;
}

function readStringProperty(
  value: unknown,
  propertyName: string
): string | undefined {
  if (typeof value !== "object" || value === null || !(propertyName in value)) {
    return undefined;
  }

  const propertyValue = value[propertyName];
  return typeof propertyValue === "string" ? propertyValue : undefined;
}
