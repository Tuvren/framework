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

import { access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { runCommand } from "./lib/command-runner.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_CONFIG = "tsconfig.typecheck.json";

const [projectRoot, ...requestedConfigs] = process.argv.slice(2);

if (projectRoot === undefined || projectRoot.length === 0) {
  throw new Error(
    "usage: bun tools/scripts/typecheck-project.ts <project-root> [tsconfig...]"
  );
}

const configs =
  requestedConfigs.length > 0
    ? requestedConfigs
    : await readDefaultTypecheckConfigs(projectRoot);

for (const config of configs) {
  const code = await runTypeScript(projectRoot, config);

  if (code !== 0) {
    process.exitCode = code;
    break;
  }
}

async function readDefaultTypecheckConfigs(
  projectRootPath: string
): Promise<string[]> {
  const defaultConfigPath = resolve(REPO_ROOT, projectRootPath, DEFAULT_CONFIG);

  try {
    await access(defaultConfigPath);
    return [DEFAULT_CONFIG];
  } catch {
    // Declaration configs in this repo validate package output during build:
    // many of them intentionally resolve dependencies through built dist
    // declarations, so the read-only typecheck lane stays on source configs.
    return ["tsconfig.lib.json"];
  }
}

async function runTypeScript(
  projectRootPath: string,
  config: string
): Promise<number> {
  const result = await runCommand(
    [
      "bunx",
      "--bun",
      "tsc",
      "--project",
      resolve(REPO_ROOT, projectRootPath, config),
      "--noEmit",
      "--pretty",
      "false",
    ],
    {
      cwd: REPO_ROOT,
    }
  );

  return result.code;
}
