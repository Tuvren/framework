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
import { reportJsonIssues } from "./json-source-check.js";
import { runCommand as runCommandProcess } from "./lib/command-runner.js";
import {
  discoverJsonInventory,
  JSON_SOURCE_INTEGRITY_EXCLUSIONS,
  validateJsonSources,
  type JsonDiscoveryDependencies,
  type JsonIntegrityIssue,
  type JsonProtectedFile,
} from "./lib/json-source-integrity.js";

const JSON_ONLY_FLAG = "--json-only";
const OXFMT_BIN_RELATIVE = "node_modules/oxfmt/bin/oxfmt";

export interface JsonCheckRun {
  code: number;
  files: string[];
}

export interface JsonCheckResult {
  codeFiles: string[];
  formatFiles: string[];
  formatRun: JsonCheckRun | undefined;
  issues: JsonIntegrityIssue[];
  jsonFiles: string[];
  protectedFiles: string[];
  protectedReasons: JsonProtectedFile[];
}

export interface JsonCheckDependencies extends JsonDiscoveryDependencies {
  jsonOnly: boolean;
}

export async function runJsonCheck(
  deps: JsonCheckDependencies
): Promise<JsonCheckResult> {
  const inventory = await discoverJsonInventory(deps);
  if (inventory.jsonFiles.length === 0) {
    throw new Error(
      `no JSON or JSONC files matched requested scope(s): ${deps.scopes.join(", ")}`
    );
  }
  const codeFiles = inventory.codeFiles;
  if (deps.jsonOnly && codeFiles.length > 0) {
    throw new Error(`JSON-only scope contains code: ${codeFiles.join(", ")}`);
  }

  const absoluteFiles = inventory.jsonFiles.map((file) =>
    path.join(deps.repoRoot, file)
  );
  const validation = await validateJsonSources(absoluteFiles);
  let formatRun: JsonCheckRun | undefined;
  if (validation.issues.length === 0 && inventory.formatFiles.length > 0) {
    const format = await deps.runCommand(
      [
        process.execPath,
        OXFMT_BIN_RELATIVE,
        "--check",
        ...inventory.formatFiles,
      ],
      { cwd: deps.repoRoot }
    );
    formatRun = { code: format.code, files: inventory.formatFiles };
  }
  return {
    codeFiles,
    formatFiles: inventory.formatFiles,
    formatRun,
    issues: validation.issues,
    jsonFiles: inventory.jsonFiles,
    protectedFiles: inventory.protectedFiles,
    protectedReasons: inventory.protectedReasons,
  };
}

interface JsonCheckArguments {
  jsonOnly: boolean;
  scopes: string[];
}

export function parseJsonCheckArguments(
  args: readonly string[]
): JsonCheckArguments {
  const jsonOnly = args[0] === JSON_ONLY_FLAG;
  const scopes = args.slice(jsonOnly ? 1 : 0);
  if (scopes.some((scope) => scope.startsWith("--"))) {
    throw new Error(
      `unknown option: ${scopes.find((scope) => scope.startsWith("--"))}`
    );
  }
  return { jsonOnly, scopes };
}

if (import.meta.main) {
  const repoRoot = path.resolve(import.meta.dirname, "../..");
  try {
    const args = parseJsonCheckArguments(process.argv.slice(2));
    const result = await runJsonCheck({
      formatIgnorePatterns: oxfmtConfig.ignorePatterns ?? [],
      jsonOnly: args.jsonOnly,
      repoRoot,
      runCommand: runCommandProcess,
      scopes: args.scopes,
      sourceIgnorePatterns: JSON_SOURCE_INTEGRITY_EXCLUSIONS,
    });
    if (result.issues.length > 0) {
      reportJsonIssues(result.issues);
      process.exitCode = 1;
    } else if (result.formatRun?.code !== 0) {
      process.exitCode = 1;
    }
  } catch (error: unknown) {
    console.error(
      `json-check: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exitCode = 1;
  }
}
