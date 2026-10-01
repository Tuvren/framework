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

import path from "node:path";
import process from "node:process";

import oxfmtConfig from "../../oxfmt.config.js";
import { runCommand } from "./lib/command-runner.js";
import {
  discoverJsonInventory,
  validateJsonSources,
  type JsonDiscoveryDependencies,
  type JsonIntegrityIssue,
} from "./lib/json-source-integrity.js";

export interface JsonSourceCheckResult {
  files: string[];
  issues: JsonIntegrityIssue[];
  protectedFiles: string[];
}

export interface JsonSourceCheckDependencies extends Omit<
  JsonDiscoveryDependencies,
  "scopes"
> {
  scopes: readonly string[];
}

export async function runJsonSourceCheck(
  deps: JsonSourceCheckDependencies
): Promise<JsonSourceCheckResult> {
  const inventory = await discoverJsonInventory(deps);
  if (inventory.jsonFiles.length === 0) {
    throw new Error(
      `no JSON or JSONC files matched requested scope(s): ${deps.scopes.join(", ")}`
    );
  }
  const absoluteFiles = inventory.jsonFiles.map((file) =>
    path.join(deps.repoRoot, file)
  );
  const validation = await validateJsonSources(absoluteFiles);
  return {
    files: inventory.jsonFiles,
    issues: validation.issues,
    protectedFiles: inventory.protectedFiles,
  };
}

export function reportJsonIssues(issues: readonly JsonIntegrityIssue[]): void {
  for (const issue of issues) {
    console.error(`json-source-check: ${issue.file}: ${issue.message}`);
  }
}

if (import.meta.main) {
  const repoRoot = path.resolve(import.meta.dirname, "../..");
  try {
    const result = await runJsonSourceCheck({
      ignorePatterns: oxfmtConfig.ignorePatterns ?? [],
      repoRoot,
      runCommand,
      scopes: process.argv.slice(2),
    });
    if (result.issues.length > 0) {
      reportJsonIssues(result.issues);
      process.exitCode = 1;
    }
  } catch (error: unknown) {
    console.error(
      `json-source-check: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exitCode = 1;
  }
}
