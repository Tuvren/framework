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
import type { TuvrenStreamEvent } from "@tuvren/runtime";
import {
  createReplShell,
  haveAllChecksPassed,
  loadReplConfig,
  readReplEnv,
  runReplInput,
  runReplScenario,
} from "./index.js";
import { runReplHeadlessMode } from "./lib/repl-headless-mode.js";
import { createLiveTurnWriter } from "./lib/repl-live-output.js";
import { replayReplTranscript } from "./lib/repl-replay.js";
import {
  createReplTranscriptFileWriter,
  type ReplTranscriptBackendConfig,
  type ReplTranscriptDurableReadRecord,
  type ReplTranscriptHeader,
  type ReplTranscriptWriter,
  readReplTranscriptFile,
} from "./lib/repl-transcript.js";
import type { ReplConfig } from "./lib/repl-types.js";

const argv = process.argv.slice(2);
const SHELL_WHITESPACE_PATTERN = /\s+/u;

await main(argv);

async function main(argv: readonly string[]): Promise<void> {
  try {
    const options = parseCliOptions(argv);

    if (options.replayPath !== undefined) {
      const report = await replayReplTranscript(
        await readReplTranscriptFile(options.replayPath)
      );

      process.stdout.write(`${JSON.stringify(report)}\n`);

      if (report.status === "failed") {
        process.exitCode = 1;
      }

      return;
    }

    const config = loadReplConfig(process.env, options.configArgv);
    const headless = options.headless || isHeadlessMode(process.env);

    if (
      !headless &&
      hasExplicitScenarioSelection(process.env, options.configArgv)
    ) {
      const report = await runReplScenario(config);

      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

      if (!haveAllChecksPassed(report.checks)) {
        process.exitCode = 1;
      }

      return;
    }

    const transcriptWriter =
      options.recordPath === undefined
        ? undefined
        : await createReplTranscriptFileWriter({
            header: createTranscriptHeader(config),
            path: options.recordPath,
          });

    try {
      if (headless) {
        await runReplHeadlessMode({
          input: process.stdin,
          output: process.stdout,
          shell: createReplShell(config),
          streamEvents: options.streamJsonl,
          transcriptWriter,
        });
        return;
      }

      await runInteractiveShell(config, transcriptWriter);
    } finally {
      await transcriptWriter?.close();
    }
  } catch (error: unknown) {
    if (isHeadlessFailureJsonl(argv, process.env)) {
      process.stdout.write(
        `${JSON.stringify({
          error: {
            message: renderError(error),
          },
          ordinal: 0,
          output: null,
          recordKind: "output",
          recordedAtMs: Date.now(),
          v: 1,
        })}\n`
      );
    } else {
      process.stderr.write(`${renderError(error)}\n`);
    }

    process.exitCode = 1;
  }
}

interface CliOptions {
  configArgv: string[];
  headless: boolean;
  recordPath?: string;
  replayPath?: string;
  streamJsonl: boolean;
}

function parseCliOptions(argv: readonly string[]): CliOptions {
  const configArgv: string[] = [];
  let headless = false;
  let recordPath: string | undefined;
  let replayPath: string | undefined;
  let streamJsonl = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--headless") {
      headless = true;
      continue;
    }

    if (arg === "--stream-jsonl") {
      streamJsonl = true;
      continue;
    }

    if (arg === "--no-stream-jsonl") {
      streamJsonl = false;
      continue;
    }

    if (arg === "--record") {
      recordPath = readRequiredCliValue(argv, index, "--record");
      index += 1;
      continue;
    }

    if (arg === "--replay") {
      replayPath = readRequiredCliValue(argv, index, "--replay");
      index += 1;
      continue;
    }

    configArgv.push(arg);
  }

  return { configArgv, headless, recordPath, replayPath, streamJsonl };
}

async function runInteractiveShell(
  config: Parameters<typeof createReplShell>[0],
  transcriptWriter?: ReplTranscriptWriter
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
    let ordinal = 0;

    for await (const line of rl) {
      const input = line.trim();
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
        await writeTranscriptInput(input, ordinal, transcriptWriter);
        const transcriptEventRecorder = createTranscriptEventRecorder(
          input,
          ordinal,
          transcriptWriter
        );
        const canonicalEvents: TuvrenStreamEvent[] = [];
        const result = await runReplInput(shell, input, {
          onCanonicalEvent: (event) => {
            canonicalEvents.push(event);
            liveOutput.observe(event);
            transcriptEventRecorder.observe(event);
          },
        });
        await transcriptEventRecorder.flush();

        liveOutput.finish();

        const output = result.output ?? readStreamOutput(canonicalEvents);

        if (
          await writeTranscriptOutput(
            input,
            ordinal,
            output,
            result.exit === true,
            transcriptWriter
          )
        ) {
          ordinal += 1;
        }

        if (result.output !== undefined) {
          process.stdout.write(`${result.output}\n`);
        }

        if (result.exit === true) {
          shouldPrompt = false;
          break;
        }
      } catch (error: unknown) {
        liveOutput.finish();
        if (
          await writeTranscriptErrorOutput(input, ordinal, transcriptWriter)
        ) {
          ordinal += 1;
        }
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

async function writeTranscriptInput(
  input: string,
  ordinal: number,
  transcriptWriter: ReplTranscriptWriter | undefined
): Promise<void> {
  if (input.length === 0) {
    return;
  }

  await transcriptWriter?.writeEntry({
    input,
    ordinal,
    recordKind: "input",
    recordedAtMs: Date.now(),
    v: 1,
  });
}

function createTranscriptEventRecorder(
  input: string,
  ordinal: number,
  transcriptWriter: ReplTranscriptWriter | undefined
): {
  flush(): Promise<void>;
  observe(event: TuvrenStreamEvent): void;
} {
  const writes: Promise<void>[] = [];

  return {
    async flush(): Promise<void> {
      await Promise.all(writes);
    },
    observe(event): void {
      if (transcriptWriter === undefined || input.length === 0) {
        return;
      }

      writes.push(
        transcriptWriter.writeEntry({
          event,
          ordinal,
          recordKind: "stream-event",
          recordedAtMs: Date.now(),
          v: 1,
        })
      );
    },
  };
}

async function writeTranscriptOutput(
  input: string,
  ordinal: number,
  output: string | undefined,
  exit: boolean,
  transcriptWriter: ReplTranscriptWriter | undefined
): Promise<boolean> {
  if (input.length === 0) {
    return false;
  }

  await transcriptWriter?.writeEntry({
    ...(exit ? { exit: true } : {}),
    ordinal,
    output: output ?? null,
    recordKind: "output",
    recordedAtMs: Date.now(),
    v: 1,
  });
  const durableRead = readTranscriptDurableReadRecord(
    input,
    ordinal,
    output,
    Date.now()
  );

  if (durableRead !== undefined) {
    await transcriptWriter?.writeEntry(durableRead);
  }

  return true;
}

function readTranscriptDurableReadRecord(
  input: string,
  ordinal: number,
  output: string | undefined,
  recordedAtMs: number
): ReplTranscriptDurableReadRecord | undefined {
  if (!isMessagesShowInput(input) || output === undefined) {
    return undefined;
  }

  const result = parseDurableReadOutput(output);

  if (result === undefined) {
    return undefined;
  }

  return {
    operation: "readBranchMessages",
    ordinal,
    recordKind: "durable-read",
    recordedAtMs,
    result,
    v: 1,
  };
}

function parseDurableReadOutput(output: string): unknown | undefined {
  try {
    return JSON.parse(output);
  } catch {
    return undefined;
  }
}

function isMessagesShowInput(input: string): boolean {
  return (
    input.trim().split(SHELL_WHITESPACE_PATTERN).join(" ") === ".messages show"
  );
}

function readStreamOutput(
  events: readonly TuvrenStreamEvent[]
): string | undefined {
  const structuredDone = [...events]
    .reverse()
    .find(
      (
        event
      ): event is Extract<TuvrenStreamEvent, { type: "structured.done" }> =>
        event.type === "structured.done"
    );

  if (structuredDone !== undefined) {
    return JSON.stringify(structuredDone.data);
  }

  const textDone = [...events]
    .reverse()
    .find(
      (event): event is Extract<TuvrenStreamEvent, { type: "text.done" }> =>
        event.type === "text.done"
    );

  if (typeof textDone?.text === "string") {
    return textDone.text;
  }

  const text = events
    .filter(
      (event): event is Extract<TuvrenStreamEvent, { type: "text.delta" }> =>
        event.type === "text.delta"
    )
    .map((event) => event.delta)
    .join("");

  return text.length > 0 ? text : undefined;
}

async function writeTranscriptErrorOutput(
  input: string,
  ordinal: number,
  transcriptWriter: ReplTranscriptWriter | undefined
): Promise<boolean> {
  if (input.length === 0) {
    return false;
  }

  await transcriptWriter?.writeEntry({
    ordinal,
    output: null,
    recordKind: "output",
    recordedAtMs: Date.now(),
    v: 1,
  });

  return true;
}

function createTranscriptHeader(config: ReplConfig): ReplTranscriptHeader {
  return {
    config: {
      backend: createTranscriptBackendConfig(config),
      modelId: config.modelId,
      providerMode: config.providerMode,
      scenario: config.scenario,
      systemPrompt: config.systemPrompt,
    },
    recordedAtMs: Date.now(),
    recordKind: "header",
    runtimeVersion: "@tuvren/runtime@0.0.0",
    v: 1,
  };
}

function createTranscriptBackendConfig(
  config: ReplConfig
): ReplTranscriptBackendConfig {
  switch (config.backend) {
    case "memory":
      return { kind: "memory" };
    case "postgres":
      return {
        kind: "postgres",
        options: {
          database: config.postgresDatabase,
          schemaName: config.postgresSchemaName,
        },
      };
    case "sqlite":
      return {
        kind: "sqlite",
        options: {
          databasePath: config.sqlitePath,
        },
      };
    default:
      throw new Error(`unsupported transcript backend "${config.backend}"`);
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

function readRequiredCliValue(
  argv: readonly string[],
  index: number,
  flag: string
): string {
  const value = argv[index + 1];

  if (value === undefined || value.startsWith("--")) {
    throw new Error(`missing value for ${flag}`);
  }

  return value;
}

function isHeadlessMode(env: Record<string, string | undefined>): boolean {
  return env.TUVREN_REPL_MODE?.trim().toLowerCase() === "headless";
}

function isHeadlessFailureJsonl(
  argv: readonly string[],
  env: Record<string, string | undefined>
): boolean {
  return (
    argv.includes("--headless") ||
    argv.includes("--replay") ||
    isHeadlessMode(env)
  );
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
