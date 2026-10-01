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

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runCommand } from "../lib/command-runner.ts";

// ADR-0070 / KRT-BP003: generated JSON is normalized through the repository
// Oxfmt configuration, not Biome. The config is auto-discovered from the
// repository root, so pin the formatter cwd there instead of inheriting an
// arbitrary caller cwd.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

export async function formatGeneratedJson(
  paths: readonly string[]
): Promise<void> {
  if (paths.length === 0) {
    return;
  }

  const result = await runCommand(
    ["bunx", "--bun", "oxfmt", "--write", ...paths],
    { captureOutput: true, cwd: REPO_ROOT }
  );

  if (result.code !== 0) {
    throw new Error(
      result.stderr || result.stdout || "formatting generated JSON failed"
    );
  }
}
