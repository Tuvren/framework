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

import type { TuvrenStreamEvent } from "@tuvren/sdk";

import { readReplEnv } from "./repl-config.js";
import { createReplHostUsingCreateTuvren } from "./repl-host.js";
import { createReplShellFromHost, runReplInput } from "./repl-shell.js";
import type { ReplShell } from "./repl-shell.js";
import { serializeReplTranscriptRecord } from "./repl-transcript.js";
import type {
  ReplTranscriptDurableReadRecord,
  ReplTranscriptEntry,
  ReplTranscriptHeader,
  ReplTranscriptInputRecord,
  ReplTranscriptOutputRecord,
  ReplTranscriptReadable,
  ReplTranscriptStreamEventRecord,
} from "./repl-transcript.js";
import type {
  ReplConfig,
  ReplProviderMode,
  ReplScenarioName,
} from "./repl-types.js";

export interface ReplReplayMismatch {
  actual: string;
  expected: string;
  ordinal: number;
  recordKind: "durable-read" | "output" | "stream-event";
}

export interface ReplReplayReport {
  backend: ReplTranscriptHeader["config"]["backend"];
  deterministicAsserted: boolean;
  inputCount: number;
  mismatches: ReplReplayMismatch[];
  nonDeterministicRecorded: boolean;
  providerMode: string;
  status: "failed" | "passed";
  warnings: string[];
}

interface ReplayGroup {
  durableReads: ReplTranscriptDurableReadRecord[];
  input: ReplTranscriptInputRecord;
  output?: ReplTranscriptOutputRecord;
  streamEvents: ReplTranscriptStreamEventRecord[];
}

const SHELL_WHITESPACE_PATTERN = /\s+/u;

const isDeterministicProviderMode = (value: string): boolean =>
  value === "fixture" || value.startsWith("aimock-");

const appendReplayInputGroup = (
  groups: Map<number, ReplayGroup>,
  entry: ReplTranscriptInputRecord,
  expectedOrdinal: number
): void => {
  if (groups.has(entry.ordinal)) {
    throw new Error(`duplicate transcript input ordinal ${entry.ordinal}`);
  }

  if (entry.ordinal !== expectedOrdinal) {
    throw new Error(
      `transcript input ordinal ${entry.ordinal} must be ${expectedOrdinal}`
    );
  }

  groups.set(entry.ordinal, {
    durableReads: [],
    input: entry,
    streamEvents: [],
  });
};

const appendReplayDurableRead = (
  group: ReplayGroup,
  entry: ReplTranscriptDurableReadRecord
): void => {
  if (group.output === undefined) {
    throw new Error(
      `transcript durable-read ordinal ${entry.ordinal} must follow output`
    );
  }

  group.durableReads.push(entry);
};

const appendReplayOutput = (
  group: ReplayGroup,
  entry: ReplTranscriptOutputRecord
): void => {
  if (group.output !== undefined) {
    throw new Error(`duplicate transcript output ordinal ${entry.ordinal}`);
  }

  group.output = entry;
};

const appendReplayStreamEvent = (
  group: ReplayGroup,
  entry: ReplTranscriptStreamEventRecord
): void => {
  if (group.output !== undefined) {
    throw new Error(
      `transcript stream-event ordinal ${entry.ordinal} must precede output`
    );
  }

  group.streamEvents.push(entry);
};

const appendReplayGroupEntry = (
  group: ReplayGroup,
  entry: Exclude<ReplTranscriptEntry, ReplTranscriptInputRecord>
): void => {
  switch (entry.recordKind) {
    case "durable-read": {
      appendReplayDurableRead(group, entry);
      return;
    }
    case "output": {
      appendReplayOutput(group, entry);
      return;
    }
    case "stream-event": {
      appendReplayStreamEvent(group, entry);
      return;
    }
    default: {
      throw new Error("unsupported transcript replay entry");
    }
  }
};

const readReplayGroup = (
  groups: Map<number, ReplayGroup>,
  entry: Exclude<ReplTranscriptEntry, ReplTranscriptInputRecord>
): ReplayGroup => {
  const group = groups.get(entry.ordinal);

  if (group === undefined) {
    throw new Error(
      `transcript entry ordinal ${entry.ordinal} has no preceding input`
    );
  }

  return group;
};

const collectReplayGroups = async (
  entries: AsyncIterable<ReplTranscriptEntry>
): Promise<ReplayGroup[]> => {
  const groups = new Map<number, ReplayGroup>();
  let expectedInputOrdinal = 0;

  for await (const entry of entries) {
    if (entry.recordKind === "input") {
      appendReplayInputGroup(groups, entry, expectedInputOrdinal);
      expectedInputOrdinal += 1;
      continue;
    }

    appendReplayGroupEntry(readReplayGroup(groups, entry), entry);
  }

  return [...groups.values()];
};

const readProviderMode = (value: string): ReplProviderMode => {
  switch (value) {
    case "aimock-anthropic":
    case "aimock-google":
    case "aimock-openai":
    case "ai-sdk-google":
    case "ai-sdk-mock":
    case "fixture": {
      return value;
    }
    default: {
      throw new Error(`unsupported transcript provider mode "${value}"`);
    }
  }
};

const readScenarioName = (value: string | undefined): ReplScenarioName => {
  const scenario = value ?? "streaming";

  switch (scenario) {
    case "approval":
    case "branching":
    case "cancel":
    case "extension":
    case "metadata":
    case "orchestration":
    case "reload":
    case "steering":
    case "streaming":
    case "structured":
    case "tools": {
      return scenario;
    }
    default: {
      throw new Error(`unsupported transcript scenario "${value}"`);
    }
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readSqlitePath = (options: unknown): string | undefined => {
  if (!isRecord(options)) {
    return undefined;
  }

  if (typeof options.databasePath === "string") {
    return options.databasePath;
  }

  return typeof options.path === "string" ? options.path : undefined;
};

const readPostgresOptions = (
  options: unknown
): {
  postgresDatabase?: string;
  postgresSchemaName?: string;
} => {
  if (!isRecord(options)) {
    return {};
  }

  return {
    postgresDatabase:
      typeof options.database === "string" ? options.database : undefined,
    postgresSchemaName:
      typeof options.schemaName === "string" ? options.schemaName : undefined,
  };
};

const createReplayConfig = (header: ReplTranscriptHeader): ReplConfig => {
  const { backend } = header.config;

  return {
    aimockBaseUrl: header.config.providerMode.startsWith("aimock-")
      ? readReplEnv(process.env, "AIMOCK_BASE_URL")
      : undefined,
    backend: backend.kind,
    modelId: header.config.modelId,
    providerMode: readProviderMode(header.config.providerMode),
    scenario: readScenarioName(header.config.scenario),
    // Re-bind the recorded Scope so replay reconstructs the same scope-bound
    // backend and telemetry correlation the original session used (KRT-BE008).
    scope: header.config.scope,
    sqlitePath: readSqlitePath(backend.options),
    systemPrompt: header.config.systemPrompt,
    ...readPostgresOptions(backend.options),
  };
};

const normalizeReplayInput = (input: string): string =>
  input.trim().split(SHELL_WHITESPACE_PATTERN).join(" ");

const isDeterministicReplayInput = (input: string): boolean => {
  const normalizedInput = normalizeReplayInput(input);

  return (
    normalizedInput === ".events show" ||
    normalizedInput === ".help" ||
    normalizedInput === ".messages show" ||
    normalizedInput === ".status" ||
    normalizedInput === ".thread new" ||
    normalizedInput === ".thread show" ||
    normalizedInput === ".exit"
  );
};

const runReplayInput = async (
  shell: ReplShell,
  input: string,
  liveEvents: TuvrenStreamEvent[]
) =>
  await runReplInput(shell, input, {
    onCanonicalEvent(event) {
      liveEvents.push(event);
    },
  });

const readReplayStreamText = (
  events: readonly TuvrenStreamEvent[]
): string | undefined => {
  const structuredDone = events
    .toReversed()
    .find(
      (
        event
      ): event is Extract<TuvrenStreamEvent, { type: "structured.done" }> =>
        event.type === "structured.done"
    );

  if (structuredDone !== undefined) {
    return JSON.stringify(structuredDone.data);
  }

  const textDone = events
    .toReversed()
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
};

const parseJsonOutput = (output: string): unknown => {
  try {
    return JSON.parse(output);
  } catch {
    return undefined;
  }
};

const isVolatileReplayEventKey = (key: string): boolean =>
  key === "branchId" ||
  key === "headTurnNodeHash" ||
  key === "messageId" ||
  key === "rootTurnNodeHash" ||
  key === "rootTurnTreeHash" ||
  key === "threadId" ||
  key === "timestamp" ||
  key === "turnId" ||
  key === "turnNodeHash";

const normalizeReplayEvent = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeReplayEvent(entry));
  }

  if (!isRecord(value)) {
    return value;
  }

  const normalized: Record<string, unknown> = {};

  for (const [key, entry] of Object.entries(value).toSorted(([left], [right]) =>
    left.localeCompare(right)
  )) {
    if (isVolatileReplayEventKey(key)) {
      continue;
    }

    normalized[key] = normalizeReplayEvent(entry);
  }

  return normalized;
};

const normalizeReplayOutputText = (output: string): string => {
  const parsed = parseJsonOutput(output);

  return parsed === undefined
    ? output
    : JSON.stringify(normalizeReplayEvent(parsed));
};

const serializeReplayComparableOutput = (
  output: ReplTranscriptOutputRecord
): string =>
  serializeReplTranscriptRecord({
    ...output,
    output:
      output.output === null ? null : normalizeReplayOutputText(output.output),
  });

const compareRecordedOutput = (
  group: ReplayGroup,
  liveOutput: ReplTranscriptOutputRecord,
  mismatches: ReplReplayMismatch[]
): void => {
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
  const expected = serializeReplayComparableOutput(normalizedRecorded);
  const actual = serializeReplayComparableOutput(liveOutput);

  if (expected !== actual) {
    mismatches.push({
      actual,
      expected,
      ordinal: group.input.ordinal,
      recordKind: "output",
    });
  }
};

const serializeReplayComparableStreamEvent = (
  event: TuvrenStreamEvent
): string => JSON.stringify(normalizeReplayEvent(event));

const compareRecordedStreamEvents = (
  group: ReplayGroup,
  liveEvents: readonly TuvrenStreamEvent[],
  mismatches: ReplReplayMismatch[]
): void => {
  const recordedEvents = group.streamEvents.map((record) =>
    serializeReplayComparableStreamEvent(record.event)
  );
  const actualEvents = liveEvents.map((event) =>
    serializeReplayComparableStreamEvent(event)
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
};

const isMessagesShowInput = (input: string): boolean =>
  normalizeReplayInput(input) === ".messages show";

const parseReplayDurableReadOutput = (output: string): unknown => {
  try {
    return JSON.parse(output);
  } catch {
    return undefined;
  }
};

const readReplayDurableReads = (
  group: ReplayGroup,
  output: string | undefined
): ReplTranscriptDurableReadRecord[] => {
  if (!isMessagesShowInput(group.input.input) || output === undefined) {
    return [];
  }

  const result = parseReplayDurableReadOutput(output);

  return result === undefined
    ? []
    : [
        {
          operation: "readBranchMessages",
          ordinal: group.input.ordinal,
          recordKind: "durable-read",
          recordedAtMs: 0,
          result,
          v: 1,
        },
      ];
};

const compareRecordedDurableReads = (
  group: ReplayGroup,
  output: string | undefined,
  mismatches: ReplReplayMismatch[]
): void => {
  const recordedReads = group.durableReads.map((record) =>
    serializeReplTranscriptRecord({
      ...record,
      recordedAtMs: 0,
    })
  );
  const actualReads = readReplayDurableReads(group, output).map((record) =>
    serializeReplTranscriptRecord({
      ...record,
      recordedAtMs: 0,
    })
  );
  const expected = JSON.stringify(recordedReads);
  const actual = JSON.stringify(actualReads);

  if (expected !== actual) {
    mismatches.push({
      actual,
      expected,
      ordinal: group.input.ordinal,
      recordKind: "durable-read",
    });
  }
};

const compareRecordedOutputPresence = (
  group: ReplayGroup,
  liveOutput: ReplTranscriptOutputRecord,
  mismatches: ReplReplayMismatch[]
): void => {
  if (group.output !== undefined) {
    return;
  }

  mismatches.push({
    actual: serializeReplTranscriptRecord(liveOutput),
    expected: "<missing output record>",
    ordinal: group.input.ordinal,
    recordKind: "output",
  });
};

const readReplayWarnings = (header: ReplTranscriptHeader): string[] =>
  header.runtimeVersion === "@tuvren/runtime@0.0.0"
    ? []
    : [
        `transcript runtimeVersion ${header.runtimeVersion} differs from @tuvren/runtime@0.0.0`,
      ];

export const replayReplTranscript = async (
  transcript: ReplTranscriptReadable
): Promise<ReplReplayReport> => {
  const deterministic = isDeterministicProviderMode(
    transcript.header.config.providerMode
  );
  const groups = await collectReplayGroups(transcript.entries());
  const replayConfig = createReplayConfig(transcript.header);
  const host = await createReplHostUsingCreateTuvren(replayConfig);
  const shell = createReplShellFromHost(replayConfig, host);
  const mismatches: ReplReplayMismatch[] = [];
  let deterministicAsserted = false;
  let nonDeterministicRecorded = false;

  try {
    // Array.fromAsync awaits each callback before dispatching the next input.
    await Array.fromAsync(groups, async (group) => {
      const assertDeterministic =
        deterministic || isDeterministicReplayInput(group.input.input);
      const liveEvents: TuvrenStreamEvent[] = [];
      const result = await runReplayInput(shell, group.input.input, liveEvents);
      const output = result.output ?? readReplayStreamText(liveEvents);
      const liveOutput = {
        ...(result.exit === true ? { exit: true } : {}),
        ordinal: group.input.ordinal,
        output: output ?? null,
        recordKind: "output",
        recordedAtMs: group.output?.recordedAtMs ?? group.input.recordedAtMs,
        v: 1,
      } satisfies ReplTranscriptOutputRecord;

      if (assertDeterministic) {
        deterministicAsserted = true;
        compareRecordedOutput(group, liveOutput, mismatches);
        compareRecordedStreamEvents(group, liveEvents, mismatches);
        compareRecordedDurableReads(group, result.output, mismatches);
      } else {
        nonDeterministicRecorded = true;
        compareRecordedOutputPresence(group, liveOutput, mismatches);
      }
    });
  } finally {
    await host.dispose?.();
  }

  return {
    backend: transcript.header.config.backend,
    deterministicAsserted,
    inputCount: groups.length,
    mismatches,
    nonDeterministicRecorded,
    providerMode: transcript.header.config.providerMode,
    status: mismatches.length === 0 ? "passed" : "failed",
    warnings: readReplayWarnings(transcript.header),
  };
};
