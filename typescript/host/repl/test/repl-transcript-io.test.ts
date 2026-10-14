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

import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import { createReplShell } from "@tuvren/repl-host";

import { runReplHeadlessMode } from "../src/lib/repl-headless-mode.js";
import { replayReplTranscript } from "../src/lib/repl-replay.js";
import {
  createReplTranscriptFileWriter,
  createReplTranscriptWriter,
  readReplTranscriptFile,
  readReplTranscriptFromLines,
  serializeReplTranscriptRecord,
} from "../src/lib/repl-transcript.js";
import type {
  ReplTranscriptEntry,
  ReplTranscriptHeader,
} from "../src/lib/repl-transcript.js";

const header: ReplTranscriptHeader = {
  config: {
    backend: { kind: "memory" },
    providerMode: "fixture",
  },
  recordKind: "header",
  recordedAtMs: 1,
  runtimeVersion: "@tuvren/runtime@0.0.0",
  v: 1,
};

const inputRecord = (ordinal: number): ReplTranscriptEntry => ({
  input: ".status",
  ordinal,
  recordKind: "input",
  recordedAtMs: ordinal + 2,
  v: 1,
});

test("file transcript writes survive backpressure and close with complete ordered bytes", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "tuvren-transcript-io-"));
  try {
    const filePath = path.join(directory, "session.jsonl");
    const writer = await createReplTranscriptFileWriter({
      header,
      path: filePath,
    });
    const input: ReplTranscriptEntry = {
      ...inputRecord(0),
      input: "x".repeat(200_000),
      recordKind: "input",
    };
    const output: ReplTranscriptEntry = {
      ordinal: 0,
      output: "persisted",
      recordKind: "output",
      recordedAtMs: 3,
      v: 1,
    };
    await writer.writeEntry(input);
    await writer.writeEntry(output);
    await writer.close();
    expect(writer.close()).rejects.toMatchObject({
      code: "ERR_STREAM_ALREADY_FINISHED",
    });
    const bytes = await readFile(filePath, "utf-8");
    expect(bytes).toBe(
      [header, input, output]
        .map((record) => `${serializeReplTranscriptRecord(record)}\n`)
        .join("")
    );
    const reader = await readReplTranscriptFile(filePath);
    const entries = await Array.fromAsync(reader.entries());
    expect(reader.header).toEqual(header);
    expect(entries).toEqual([input, output]);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("file transcript open failures reject with the original filesystem error", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "tuvren-transcript-open-")
  );
  try {
    expect(
      createReplTranscriptFileWriter({
        header,
        path: path.join(directory, "missing", "session.jsonl"),
      })
    ).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("transcript reads await the original pending line without reading ahead or closing its owner", async () => {
  const trace: string[] = [];
  const pending = Promise.withResolvers<string>();
  const lines = async function* lines() {
    try {
      trace.push("header");
      yield serializeReplTranscriptRecord(header);
      trace.push("request-input");
      yield await pending.promise;
      trace.push("read-ahead");
      yield serializeReplTranscriptRecord(inputRecord(1));
    } finally {
      trace.push("owner-closed");
    }
  };
  const reader = await readReplTranscriptFromLines(lines());
  expect(trace).toEqual(["header"]);
  const entries = reader.entries()[Symbol.asyncIterator]();
  const next = entries.next();
  expect(trace).toEqual(["header", "request-input"]);
  pending.resolve(serializeReplTranscriptRecord(inputRecord(0)));
  expect(await next).toEqual({ done: false, value: inputRecord(0) });
  await entries.return?.();
  expect(trace).toEqual(["header", "request-input"]);
});

test("transcript readers preserve the original iterator rejection and stop reading", async () => {
  const failure = new Error("source read failed");
  const lines = function* lines() {
    yield serializeReplTranscriptRecord(header);
    throw failure;
  };
  const reader = await readReplTranscriptFromLines(lines());
  const entries = reader.entries()[Symbol.asyncIterator]();
  expect(entries.next()).rejects.toBe(failure);
});

test("headless recording replays sequential turns and durable reads against a fresh runtime", async () => {
  const lines: string[] = [];
  const writer = await createReplTranscriptWriter({
    header,
    write(line) {
      lines.push(line);
    },
  });
  await runReplHeadlessMode({
    input: Readable.from([
      ".thread new\nHello first\n.messages show\nHello second\n.messages show\n.exit\n",
    ]),
    now: () => 10,
    output: { write: () => true },
    shell: createReplShell({
      backend: "memory",
      providerMode: "fixture",
      scenario: "streaming",
    }),
    streamEvents: true,
    transcriptWriter: writer,
  });
  await writer.close();
  const transcript = await readReplTranscriptFromLines(lines);
  const report = await replayReplTranscript(transcript);
  expect(report).toMatchObject({
    deterministicAsserted: true,
    inputCount: 6,
    mismatches: [],
    status: "passed",
  });
});
