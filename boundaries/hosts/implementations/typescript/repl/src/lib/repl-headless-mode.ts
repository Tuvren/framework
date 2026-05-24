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

import { createInterface } from "node:readline/promises";
import type { TuvrenStreamEvent } from "@tuvren/runtime";
import { type ReplShell, runReplInput } from "./repl-shell.js";
import type {
  ReplTranscriptDurableReadRecord,
  ReplTranscriptWriter,
} from "./repl-transcript.js";

const SHELL_WHITESPACE_PATTERN = /\s+/u;

export interface ReplHeadlessOutputRecord {
  error?: {
    message: string;
  };
  exit?: boolean;
  ordinal: number;
  output: string | null;
  recordedAtMs: number;
  recordKind: "output";
  v: 1;
}

export interface ReplHeadlessStreamEventRecord {
  event: TuvrenStreamEvent;
  ordinal: number;
  recordedAtMs: number;
  recordKind: "stream-event";
  v: 1;
}

export interface ReplHeadlessModeOptions {
  input: NodeJS.ReadableStream;
  now?: () => number;
  output: Pick<NodeJS.WritableStream, "write">;
  shell: ReplShell;
  streamEvents?: boolean;
  transcriptWriter?: ReplTranscriptWriter;
}

export type ReplHeadlessJsonlRecord =
  | ReplHeadlessOutputRecord
  | ReplHeadlessStreamEventRecord;

export async function runReplHeadlessMode(
  options: ReplHeadlessModeOptions
): Promise<void> {
  const rl = createInterface({
    input: options.input,
  });
  const now = options.now ?? Date.now;
  let ordinal = 0;

  try {
    for await (const line of rl) {
      const input = line.trim();

      if (input.length === 0) {
        continue;
      }

      const currentOrdinal = ordinal;
      ordinal += 1;

      try {
        await options.transcriptWriter?.writeEntry({
          input,
          ordinal: currentOrdinal,
          recordKind: "input",
          recordedAtMs: now(),
          v: 1,
        });

        const transcriptWrites: Promise<void>[] = [];
        const canonicalEvents: TuvrenStreamEvent[] = [];
        const result = await runReplInput(options.shell, input, {
          onCanonicalEvent: (event) => {
            canonicalEvents.push(event);

            if (options.streamEvents === true) {
              writeHeadlessOutput(options.output, {
                event,
                ordinal: currentOrdinal,
                recordKind: "stream-event",
                recordedAtMs: now(),
                v: 1,
              });
            }

            if (options.transcriptWriter !== undefined) {
              transcriptWrites.push(
                options.transcriptWriter.writeEntry({
                  event,
                  ordinal: currentOrdinal,
                  recordKind: "stream-event",
                  recordedAtMs: now(),
                  v: 1,
                })
              );
            }
          },
        });
        await Promise.all(transcriptWrites);
        const output =
          result.output ?? readHeadlessStreamOutput(canonicalEvents);
        await options.transcriptWriter?.writeEntry({
          ...(result.exit === true ? { exit: true } : {}),
          ordinal: currentOrdinal,
          output: output ?? null,
          recordKind: "output",
          recordedAtMs: now(),
          v: 1,
        });
        const durableRead = readHeadlessDurableReadRecord(
          input,
          currentOrdinal,
          output,
          now()
        );

        if (durableRead !== undefined) {
          await options.transcriptWriter?.writeEntry(durableRead);
        }

        writeHeadlessOutput(options.output, {
          ...(result.exit === true ? { exit: true } : {}),
          ordinal: currentOrdinal,
          output: output ?? null,
          recordKind: "output",
          recordedAtMs: now(),
          v: 1,
        });

        if (result.exit === true) {
          break;
        }
      } catch (error: unknown) {
        await options.transcriptWriter?.writeEntry({
          ordinal: currentOrdinal,
          output: null,
          recordKind: "output",
          recordedAtMs: now(),
          v: 1,
        });
        writeHeadlessOutput(options.output, {
          error: {
            message: renderHeadlessError(error),
          },
          ordinal: currentOrdinal,
          output: null,
          recordKind: "output",
          recordedAtMs: now(),
          v: 1,
        });
      }
    }
  } finally {
    rl.close();
  }
}

function readHeadlessDurableReadRecord(
  input: string,
  ordinal: number,
  output: string | undefined,
  recordedAtMs: number
): ReplTranscriptDurableReadRecord | undefined {
  if (!isMessagesShowInput(input) || output === undefined) {
    return undefined;
  }

  const result = parseHeadlessDurableReadOutput(output);

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

function isMessagesShowInput(input: string): boolean {
  return (
    input.trim().split(SHELL_WHITESPACE_PATTERN).join(" ") === ".messages show"
  );
}

function parseHeadlessDurableReadOutput(output: string): unknown | undefined {
  try {
    return JSON.parse(output);
  } catch {
    return undefined;
  }
}

function readHeadlessStreamOutput(
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

function writeHeadlessOutput(
  output: Pick<NodeJS.WritableStream, "write">,
  record: ReplHeadlessJsonlRecord
): void {
  output.write(`${JSON.stringify(record)}\n`);
}

function renderHeadlessError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
