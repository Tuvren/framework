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

import type { TuvrenStreamEvent } from "@tuvren/runtime";
import { createReplHostUsingCreateTuvren } from "./repl-host.js";
import {
  createReplShellFromHost,
  type ReplShell,
  runReplInput,
} from "./repl-shell.js";
import {
  type ReplTranscriptEntry,
  type ReplTranscriptHeader,
  type ReplTranscriptInputRecord,
  type ReplTranscriptOutputRecord,
  type ReplTranscriptReadable,
  type ReplTranscriptStreamEventRecord,
  serializeReplTranscriptRecord,
} from "./repl-transcript.js";
import type { ReplConfig, ReplProviderMode } from "./repl-types.js";

export interface ReplReplayMismatch {
  actual: string;
  expected: string;
  ordinal: number;
  recordKind: "output" | "stream-event";
}

export interface ReplReplayReport {
  backend: ReplTranscriptHeader["config"]["backend"];
  deterministicAsserted: boolean;
  inputCount: number;
  mismatches: ReplReplayMismatch[];
  nonDeterministicRecorded: boolean;
  providerMode: string;
  status: "failed" | "passed";
}

export async function replayReplTranscript(
  transcript: ReplTranscriptReadable
): Promise<ReplReplayReport> {
  const deterministic = isDeterministicProviderMode(
    transcript.header.config.providerMode
  );
  const groups = await collectReplayGroups(transcript.entries());
  const replayConfig = createReplayConfig(transcript.header);
  const host = await createReplHostUsingCreateTuvren(replayConfig);
  const shell = createReplShellFromHost(replayConfig, host);
  const mismatches: ReplReplayMismatch[] = [];

  try {
    for (const group of groups) {
      const liveEvents: TuvrenStreamEvent[] = [];
      const result = await runReplayInput(shell, group.input.input, liveEvents);
      const liveOutput = {
        ...(result.exit === true ? { exit: true } : {}),
        ordinal: group.input.ordinal,
        output: result.output ?? null,
        recordKind: "output",
        recordedAtMs: group.output?.recordedAtMs ?? group.input.recordedAtMs,
        v: 1,
      } satisfies ReplTranscriptOutputRecord;

      if (deterministic) {
        compareRecordedOutput(group, liveOutput, mismatches);
        compareRecordedStreamEvents(group, liveEvents, mismatches);
      }
    }
  } finally {
    await host.dispose?.();
  }

  return {
    backend: transcript.header.config.backend,
    deterministicAsserted: deterministic,
    inputCount: groups.length,
    mismatches,
    nonDeterministicRecorded: !deterministic,
    providerMode: transcript.header.config.providerMode,
    status: mismatches.length === 0 ? "passed" : "failed",
  };
}

async function runReplayInput(
  shell: ReplShell,
  input: string,
  liveEvents: TuvrenStreamEvent[]
) {
  return await runReplInput(shell, input, {
    onCanonicalEvent(event) {
      liveEvents.push(event);
    },
  });
}

interface ReplayGroup {
  input: ReplTranscriptInputRecord;
  output?: ReplTranscriptOutputRecord;
  streamEvents: ReplTranscriptStreamEventRecord[];
}

async function collectReplayGroups(
  entries: AsyncIterable<ReplTranscriptEntry>
): Promise<ReplayGroup[]> {
  const groups = new Map<number, ReplayGroup>();

  for await (const entry of entries) {
    if (entry.recordKind === "input") {
      if (groups.has(entry.ordinal)) {
        throw new Error(`duplicate transcript input ordinal ${entry.ordinal}`);
      }

      groups.set(entry.ordinal, { input: entry, streamEvents: [] });
      continue;
    }

    const group = groups.get(entry.ordinal);

    if (group === undefined) {
      throw new Error(
        `transcript entry ordinal ${entry.ordinal} has no preceding input`
      );
    }

    if (entry.recordKind === "output") {
      group.output = entry;
    } else if (entry.recordKind === "stream-event") {
      group.streamEvents.push(entry);
    }
  }

  return [...groups.values()].sort(
    (left, right) => left.input.ordinal - right.input.ordinal
  );
}

function compareRecordedOutput(
  group: ReplayGroup,
  liveOutput: ReplTranscriptOutputRecord,
  mismatches: ReplReplayMismatch[]
): void {
  const recorded = group.output;

  if (recorded === undefined) {
    mismatches.push({
      actual: serializeReplTranscriptRecord(liveOutput),
      expected: "<missing output record>",
      ordinal: group.input.ordinal,
      recordKind: "output",
    });
    return;
  }

  const normalizedRecorded = {
    ...recorded,
    recordedAtMs: liveOutput.recordedAtMs,
  } satisfies ReplTranscriptOutputRecord;
  const expected = serializeReplTranscriptRecord(normalizedRecorded);
  const actual = serializeReplTranscriptRecord(liveOutput);

  if (expected !== actual) {
    mismatches.push({
      actual,
      expected,
      ordinal: group.input.ordinal,
      recordKind: "output",
    });
  }
}

function compareRecordedStreamEvents(
  group: ReplayGroup,
  liveEvents: readonly TuvrenStreamEvent[],
  mismatches: ReplReplayMismatch[]
): void {
  if (group.streamEvents.length === 0) {
    return;
  }

  const recordedEvents = group.streamEvents.map((record) =>
    serializeReplTranscriptRecord({
      ...record,
      recordedAtMs: 0,
    })
  );
  const actualEvents = liveEvents.map((event) =>
    serializeReplTranscriptRecord({
      event,
      ordinal: group.input.ordinal,
      recordedAtMs: 0,
      recordKind: "stream-event",
      v: 1,
    })
  );
  const expected = JSON.stringify(recordedEvents);
  const actual = JSON.stringify(actualEvents);

  if (expected !== actual) {
    mismatches.push({
      actual,
      expected,
      ordinal: group.input.ordinal,
      recordKind: "stream-event",
    });
  }
}

function createReplayConfig(header: ReplTranscriptHeader): ReplConfig {
  const backend = header.config.backend;

  return {
    backend: backend.kind,
    modelId: header.config.modelId,
    providerMode: readProviderMode(header.config.providerMode),
    scenario: "streaming",
    sqlitePath: readSqlitePath(backend.options),
    systemPrompt: header.config.systemPrompt,
    ...readPostgresOptions(backend.options),
  };
}

function readSqlitePath(options: unknown): string | undefined {
  if (!isRecord(options)) {
    return undefined;
  }

  if (typeof options.databasePath === "string") {
    return options.databasePath;
  }

  return typeof options.path === "string" ? options.path : undefined;
}

function readPostgresOptions(options: unknown): {
  postgresDatabase?: string;
  postgresSchemaName?: string;
} {
  if (!isRecord(options)) {
    return {};
  }

  return {
    postgresDatabase:
      typeof options.database === "string" ? options.database : undefined,
    postgresSchemaName:
      typeof options.schemaName === "string" ? options.schemaName : undefined,
  };
}

function readProviderMode(value: string): ReplProviderMode {
  switch (value) {
    case "aimock-anthropic":
    case "aimock-google":
    case "aimock-openai":
    case "ai-sdk-google":
    case "ai-sdk-mock":
    case "fixture":
      return value;
    default:
      throw new Error(`unsupported transcript provider mode "${value}"`);
  }
}

function isDeterministicProviderMode(value: string): boolean {
  return value === "fixture" || value.startsWith("aimock-");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
