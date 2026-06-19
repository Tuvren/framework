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

import { createReadStream, createWriteStream } from "node:fs";
import { createInterface } from "node:readline/promises";
import type { TuvrenStreamEvent } from "@tuvren/runtime";

export type ReplTranscriptBackendKind = "memory" | "postgres" | "sqlite";

export interface ReplTranscriptBackendConfig {
  kind: ReplTranscriptBackendKind;
  options?: unknown;
}

export interface ReplTranscriptHeader {
  config: {
    backend: ReplTranscriptBackendConfig;
    modelId?: string;
    providerMode: string;
    scenario?: string;
    /**
     * Host-bound tenancy partition identity the session ran under (ADR-048,
     * KRT-BE008). Recorded as correlation context only — never a credential and
     * never a kernel argument. Optional so transcripts authored before scope
     * correlation existed remain readable and replayable.
     */
    scope?: string;
    systemPrompt?: string;
  };
  recordedAtMs: number;
  recordKind: "header";
  runtimeVersion: string;
  v: 1;
}

export interface ReplTranscriptInputRecord {
  input: string;
  ordinal: number;
  recordedAtMs: number;
  recordKind: "input";
  v: 1;
}

export interface ReplTranscriptOutputRecord {
  exit?: boolean;
  ordinal: number;
  output: string | null;
  recordedAtMs: number;
  recordKind: "output";
  v: 1;
}

export interface ReplTranscriptStreamEventRecord {
  event: TuvrenStreamEvent;
  ordinal: number;
  recordedAtMs: number;
  recordKind: "stream-event";
  v: 1;
}

export interface ReplTranscriptDurableReadRecord {
  operation:
    | "getTurnHistory"
    | "getTurnState"
    | "listBranches"
    | "listThreads"
    | "readBranchMessages";
  ordinal: number;
  recordedAtMs: number;
  recordKind: "durable-read";
  result: unknown;
  v: 1;
}

export type ReplTranscriptEntry =
  | ReplTranscriptDurableReadRecord
  | ReplTranscriptInputRecord
  | ReplTranscriptOutputRecord
  | ReplTranscriptStreamEventRecord;

export type ReplTranscriptRecord = ReplTranscriptEntry | ReplTranscriptHeader;

export interface ReplTranscriptWriter {
  close(): Promise<void>;
  writeEntry(entry: ReplTranscriptEntry): Promise<void>;
}

export interface ReplTranscriptReadable {
  entries(): AsyncIterable<ReplTranscriptEntry>;
  header: ReplTranscriptHeader;
}

const TRANSCRIPT_DURABLE_READ_OPERATIONS = new Set([
  "getTurnHistory",
  "getTurnState",
  "listBranches",
  "listThreads",
  "readBranchMessages",
]);

// §3.9 transcript-format constraint (ADR-044, KRT-BD002): the transcript header's
// config.backend.options is a credential-free zone. Backend options are masked
// to a non-secret backend identity descriptor (kind plus replay-topology fields
// such as database / schemaName / databasePath) sufficient for replay but not
// for authentication; replay supplies credentials from the environment.
const TRANSCRIPT_REDACTION_PLACEHOLDER = "***";
const CREDENTIAL_OPTION_KEY_PATTERN =
  /(?:access[-_]?key|api[-_]?key|authorization|bearer|client[-_]?secret|connection[-_]?string|credential|passphrase|passwd|password|private[-_]?key|pwd|secret|token)/iu;
// A string carrying embedded URL credentials (e.g. postgres://user:pass@host/db)
// is masked even when it appears under an unexpected option key.
const URL_CREDENTIAL_VALUE_PATTERN = /\/\/[^/\s:@]+:[^/\s@]+@/u;

/**
 * Recursively mask credential-shaped backend option keys and embedded-credential
 * string values, leaving non-secret topology fields intact.
 */
export function redactReplTranscriptBackendOptions(options: unknown): unknown {
  if (Array.isArray(options)) {
    return options.map((entry) => redactReplTranscriptBackendOptions(entry));
  }

  if (!isRecord(options)) {
    return typeof options === "string" &&
      URL_CREDENTIAL_VALUE_PATTERN.test(options)
      ? TRANSCRIPT_REDACTION_PLACEHOLDER
      : options;
  }

  const redacted: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(options)) {
    redacted[key] = CREDENTIAL_OPTION_KEY_PATTERN.test(key)
      ? TRANSCRIPT_REDACTION_PLACEHOLDER
      : redactReplTranscriptBackendOptions(value);
  }

  return redacted;
}

/** Mask credential-shaped backend options while preserving the backend kind. */
export function redactReplTranscriptBackendConfig(
  backend: ReplTranscriptBackendConfig
): ReplTranscriptBackendConfig {
  return {
    kind: backend.kind,
    ...(backend.options === undefined
      ? {}
      : { options: redactReplTranscriptBackendOptions(backend.options) }),
  };
}

/** Return a copy of the header with its backend options redacted (§3.9). */
export function redactReplTranscriptHeader(
  header: ReplTranscriptHeader
): ReplTranscriptHeader {
  return {
    ...header,
    config: {
      ...header.config,
      backend: redactReplTranscriptBackendConfig(header.config.backend),
    },
  };
}

export function serializeReplTranscriptRecord(
  record: ReplTranscriptRecord
): string {
  validateTranscriptRecord(record);
  return stableStringify(record);
}

export function parseReplTranscriptRecord(line: string): ReplTranscriptRecord {
  let parsed: unknown;

  try {
    parsed = JSON.parse(line);
  } catch (error: unknown) {
    throw new Error(`invalid transcript JSON: ${renderError(error)}`);
  }

  validateTranscriptRecord(parsed);
  return parsed;
}

export async function createReplTranscriptWriter(input: {
  header: ReplTranscriptHeader;
  write: (line: string) => void | Promise<void>;
}): Promise<ReplTranscriptWriter> {
  // Mask credential-shaped backend options at the write seam so no transcript
  // header ever persists a secret, regardless of caller. (§3.9, KRT-BD002)
  const header = redactReplTranscriptHeader(input.header);
  validateTranscriptHeader(header);
  await input.write(`${serializeReplTranscriptRecord(header)}\n`);

  return {
    async close(): Promise<void> {
      await Promise.resolve();
    },
    async writeEntry(entry): Promise<void> {
      validateTranscriptEntry(entry);
      await input.write(`${serializeReplTranscriptRecord(entry)}\n`);
    },
  };
}

export async function createReplTranscriptFileWriter(input: {
  header: ReplTranscriptHeader;
  path: string;
}): Promise<ReplTranscriptWriter> {
  const stream = createWriteStream(input.path, {
    encoding: "utf8",
    flags: "w",
  });
  await waitForWriteStreamOpen(stream);
  const writer = await createReplTranscriptWriter({
    header: input.header,
    write(line) {
      return writeLine(stream, line);
    },
  });

  return {
    async close(): Promise<void> {
      await writer.close();
      await closeWritable(stream);
    },
    async writeEntry(entry): Promise<void> {
      await writer.writeEntry(entry);
    },
  };
}

async function waitForWriteStreamOpen(
  stream: ReturnType<typeof createWriteStream>
): Promise<void> {
  if (stream.pending === false) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    stream.once("open", () => {
      resolve();
    });
    stream.once("error", reject);
  });
}

export async function readReplTranscriptFromLines(
  lines: AsyncIterable<string> | Iterable<string>
): Promise<ReplTranscriptReadable> {
  const iterator = createAsyncLineIterator(lines);
  const first = await iterator.next();

  if (first.done === true) {
    throw new Error("transcript is empty");
  }

  const headerRecord = parseReplTranscriptRecord(first.value);

  if (headerRecord.recordKind !== "header") {
    throw new Error("transcript first record must be a header");
  }

  return {
    async *entries(): AsyncIterable<ReplTranscriptEntry> {
      let next = await iterator.next();

      while (next.done !== true) {
        if (next.value.trim().length > 0) {
          const record = parseReplTranscriptRecord(next.value);

          if (record.recordKind === "header") {
            throw new Error("transcript header must appear only once");
          }

          yield record;
        }

        next = await iterator.next();
      }
    },
    header: headerRecord,
  };
}

export async function readReplTranscriptFile(
  path: string
): Promise<ReplTranscriptReadable> {
  const stream = createReadStream(path, { encoding: "utf8" });
  const rl = createInterface({ input: stream });
  const readable = await readReplTranscriptFromLines(rl);
  const sourceEntries = readable.entries;

  return {
    async *entries(): AsyncIterable<ReplTranscriptEntry> {
      try {
        yield* sourceEntries();
      } finally {
        rl.close();
        stream.destroy();
      }
    },
    header: readable.header,
  };
}

function validateTranscriptRecord(
  value: unknown
): asserts value is ReplTranscriptRecord {
  if (!isRecord(value)) {
    throw new Error("transcript record must be an object");
  }

  switch (value.recordKind) {
    case "durable-read":
      validateTranscriptDurableRead(value);
      return;
    case "header":
      validateTranscriptHeader(value);
      return;
    case "input":
      validateTranscriptInput(value);
      return;
    case "output":
      validateTranscriptOutput(value);
      return;
    case "stream-event":
      validateTranscriptStreamEvent(value);
      return;
    default:
      throw new Error("unsupported transcript record kind");
  }
}

function validateTranscriptEntry(
  value: unknown
): asserts value is ReplTranscriptEntry {
  validateTranscriptRecord(value);

  if (value.recordKind === "header") {
    throw new Error("transcript entries cannot be header records");
  }
}

function validateTranscriptHeader(
  value: unknown
): asserts value is ReplTranscriptHeader {
  if (!isRecord(value)) {
    throw new Error("transcript header must be an object");
  }

  requireRecordKind(value, "header");
  requireVersion(value);
  requireSafeInteger(value.recordedAtMs, "header.recordedAtMs");
  requireString(value.runtimeVersion, "header.runtimeVersion");

  if (!isRecord(value.config)) {
    throw new Error("header.config must be an object");
  }

  if (!isRecord(value.config.backend)) {
    throw new Error("header.config.backend must be an object");
  }

  if (
    value.config.backend.kind !== "memory" &&
    value.config.backend.kind !== "postgres" &&
    value.config.backend.kind !== "sqlite"
  ) {
    throw new Error("header.config.backend.kind is unsupported");
  }

  requireString(value.config.providerMode, "header.config.providerMode");
  requireOptionalString(value.config.modelId, "header.config.modelId");
  requireOptionalString(value.config.scenario, "header.config.scenario");
  requireOptionalString(value.config.scope, "header.config.scope");
  requireOptionalString(
    value.config.systemPrompt,
    "header.config.systemPrompt"
  );
}

function validateTranscriptInput(
  value: Record<string, unknown>
): asserts value is ReplTranscriptInputRecord & Record<string, unknown> {
  requireRecordKind(value, "input");
  requireVersion(value);
  requireSafeInteger(value.ordinal, "input.ordinal");
  requireSafeInteger(value.recordedAtMs, "input.recordedAtMs");
  requireString(value.input, "input.input");
}

function validateTranscriptOutput(
  value: Record<string, unknown>
): asserts value is ReplTranscriptOutputRecord & Record<string, unknown> {
  requireRecordKind(value, "output");
  requireVersion(value);
  requireSafeInteger(value.ordinal, "output.ordinal");
  requireSafeInteger(value.recordedAtMs, "output.recordedAtMs");

  if (value.output !== null && typeof value.output !== "string") {
    throw new Error("output.output must be a string or null");
  }

  if (value.exit !== undefined && typeof value.exit !== "boolean") {
    throw new Error("output.exit must be a boolean when present");
  }
}

function validateTranscriptStreamEvent(
  value: Record<string, unknown>
): asserts value is ReplTranscriptStreamEventRecord & Record<string, unknown> {
  requireRecordKind(value, "stream-event");
  requireVersion(value);
  requireSafeInteger(value.ordinal, "stream-event.ordinal");
  requireSafeInteger(value.recordedAtMs, "stream-event.recordedAtMs");

  if (!isRecord(value.event)) {
    throw new Error("stream-event.event must be an object");
  }
}

function validateTranscriptDurableRead(
  value: Record<string, unknown>
): asserts value is ReplTranscriptDurableReadRecord & Record<string, unknown> {
  requireRecordKind(value, "durable-read");
  requireVersion(value);
  requireSafeInteger(value.ordinal, "durable-read.ordinal");
  requireSafeInteger(value.recordedAtMs, "durable-read.recordedAtMs");

  if (
    typeof value.operation !== "string" ||
    !TRANSCRIPT_DURABLE_READ_OPERATIONS.has(value.operation)
  ) {
    throw new Error("durable-read.operation is unsupported");
  }

  if (!Object.hasOwn(value, "result")) {
    throw new Error("durable-read.result is required");
  }
}

function requireRecordKind(
  value: Record<string, unknown>,
  expected: ReplTranscriptRecord["recordKind"]
): void {
  if (value.recordKind !== expected) {
    throw new Error(`transcript recordKind must be ${expected}`);
  }
}

function requireVersion(value: Record<string, unknown>): void {
  if (value.v !== 1) {
    throw new Error("transcript record version must be 1");
  }
}

function requireSafeInteger(value: unknown, path: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${path} must be a safe integer`);
  }
}

function requireString(value: unknown, path: string): void {
  if (typeof value !== "string") {
    throw new Error(`${path} must be a string`);
  }
}

function requireOptionalString(value: unknown, path: string): void {
  if (value !== undefined) {
    requireString(value, path);
  }
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sortJsonValue(entry));
  }

  if (isRecord(value)) {
    const sorted: Record<string, unknown> = {};

    for (const key of Object.keys(value).sort()) {
      const property = value[key];

      if (property !== undefined) {
        sorted[key] = sortJsonValue(property);
      }
    }

    return sorted;
  }

  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function createAsyncLineIterator(
  lines: AsyncIterable<string> | Iterable<string>
): AsyncIterator<string> {
  if (isAsyncIterable(lines)) {
    return lines[Symbol.asyncIterator]();
  }

  const iterator = lines[Symbol.iterator]();

  return {
    next() {
      return Promise.resolve(iterator.next());
    },
  };
}

function isAsyncIterable(
  value: AsyncIterable<string> | Iterable<string>
): value is AsyncIterable<string> {
  return Symbol.asyncIterator in value;
}

async function writeLine(
  stream: NodeJS.WritableStream,
  line: string
): Promise<void> {
  if (stream.write(line)) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    stream.once("drain", resolve);
    stream.once("error", reject);
  });
}

async function closeWritable(stream: NodeJS.WritableStream): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    stream.end((error?: Error | null) => {
      if (error != null) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

function renderError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
