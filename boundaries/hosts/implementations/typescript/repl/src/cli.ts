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
  readReplEnv,
  runReplInput,
  runReplScenario,
} from "./index.js";
import { createLiveTurnWriter } from "./lib/repl-live-output.js";

const argv = process.argv.slice(2);
await main(argv);

async function main(argv: readonly string[]): Promise<void> {
  try {
    const config = loadReplConfig(process.env, argv);

    if (hasExplicitScenarioSelection(process.env, argv)) {
      const report = await runReplScenario(config);

      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

      if (!haveAllChecksPassed(report.checks)) {
        process.exitCode = 1;
      }

      return;
    }

    await runInteractiveShell(config);
  } catch (error: unknown) {
    process.stderr.write(`${renderError(error)}\n`);
    process.exitCode = 1;
  }
}

async function runInteractiveShell(
  config: Parameters<typeof createReplShell>[0]
) {
  const shell = createReplShell(config);
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  let interfaceClosed = false;

  rl.on("close", () => {
    interfaceClosed = true;
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
      const liveOutput = createLiveTurnWriter(
        (chunk) => {
          process.stdout.write(chunk);
        },
        {
          useAnsiColors: shouldUseAnsiColors(process.stdout, process.env),
        }
      );

      try {
        const result = await runReplInput(shell, line, {
          onCanonicalEvent: (event) => {
            liveOutput.observe(event);
          },
        });

        liveOutput.finish();

        if (result.output !== undefined) {
          process.stdout.write(`${result.output}\n`);
        }

        if (result.exit === true) {
          shouldPrompt = false;
          break;
        }
      } catch (error: unknown) {
        liveOutput.finish();
        process.stderr.write(`${renderError(error)}\n`);
      }

      if (shouldPrompt && !interfaceClosed) {
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
  if (readReplEnv(env, "SCENARIO")?.trim().length) {
    return true;
  }

  return argv.includes("--scenario");
}

function renderError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function shouldUseAnsiColors(
  stream: Pick<NodeJS.WriteStream, "isTTY">,
  env: Record<string, string | undefined>
): boolean {
  if (env.NO_COLOR !== undefined) {
    return false;
  }

  const forceColor = env.FORCE_COLOR?.trim().toLowerCase();

  if (forceColor !== undefined) {
    return forceColor !== "0" && forceColor !== "false";
  }

  return stream.isTTY === true;
}
