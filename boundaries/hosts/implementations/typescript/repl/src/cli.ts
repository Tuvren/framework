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

import process from "node:process";
import { createInterface } from "node:readline/promises";
import {
  createReplShell,
  haveAllChecksPassed,
  loadReplConfig,
  runReplCommand,
  runReplScenario,
} from "./index.js";

const argv = process.argv.slice(2);
const config = loadReplConfig(process.env, argv);

if (hasExplicitScenarioSelection(process.env, argv)) {
  const report = await runReplScenario(config);

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

  if (!haveAllChecksPassed(report.checks)) {
    process.exitCode = 1;
  }
} else {
  await runInteractiveShell(config);
}

async function runInteractiveShell(
  config: Parameters<typeof createReplShell>[0]
) {
  const shell = createReplShell(config);
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  process.stdout.write(
    [
      "Tuvren REPL Host",
      `backend=${config.backend} provider=${config.providerMode}`,
      'Use ".help" to inspect the command tree.',
      "",
    ].join("\n")
  );

  rl.setPrompt("tuvren> ");
  rl.prompt();

  try {
    for await (const line of rl) {
      let shouldPrompt = !process.stdin.readableEnded;

      try {
        const result = await runReplCommand(shell, line);

        if (result.output !== undefined) {
          process.stdout.write(`${result.output}\n`);
        }

        if (result.exit === true) {
          shouldPrompt = false;
          break;
        }
      } catch (error: unknown) {
        process.stderr.write(`${renderError(error)}\n`);
      }

      if (shouldPrompt) {
        rl.prompt();
      }
    }
  } finally {
    rl.close();
  }
}

function hasExplicitScenarioSelection(
  env: Record<string, string | undefined>,
  argv: readonly string[]
): boolean {
  if (env.TUVREN_PLAYGROUND_SCENARIO?.trim().length) {
    return true;
  }

  return argv.includes("--scenario");
}

function renderError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
