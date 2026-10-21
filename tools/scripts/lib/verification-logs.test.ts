/**
 * Copyright 2026 Oscar Yáñez Cisterna (@SkrOYC)
 * Licensed under the Apache License, Version 2.0.
 */

import { afterEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";

import {
  createVerificationLogs,
  pruneVerificationLogs,
  replayVerificationLog,
} from "./verification-logs.js";

const scratch: string[] = [];
const createRoot = async (): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), "verification-logs-test-"));
  scratch.push(root);
  return root;
};

afterEach(async () => {
  for (const directory of scratch.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

test("run logs are unique and successful sessions are removed", async () => {
  const root = await createRoot();
  const first = await createVerificationLogs(root);
  const second = await createVerificationLogs(root);
  expect(first.directory).not.toBe(second.directory);
  const file = await first.create("command header\n");
  expect(await readFile(file, "utf-8")).toBe("command header\n");
  await first.finish(true);
  await second.finish(true);
  expect(await readdir(root)).toEqual([]);
});

test("replay streams a large log in bounded chunks without closing the destination", async () => {
  const root = await createRoot();
  const file = path.join(root, "large.log");
  const content = "ab🙂".repeat(200_000);
  await writeFile(file, content);
  let totalBytes = 0;
  let largestChunk = 0;
  const sink = new Writable({
    highWaterMark: 1024,
    write(chunk: Buffer, _encoding, callback) {
      totalBytes += chunk.length;
      largestChunk = Math.max(largestChunk, chunk.length);
      setTimeout(callback, 1);
    },
  });
  await replayVerificationLog(file, sink);
  expect(totalBytes).toBe(Buffer.byteLength(content));
  expect(largestChunk).toBeLessThanOrEqual(64 * 1024);
  expect(sink.writableEnded).toBe(false);
  sink.end();
});

test("an aborted replay into a stalled destination rejects promptly", async () => {
  const root = await createRoot();
  const file = path.join(root, "stalled.log");
  await writeFile(file, "x".repeat(256 * 1024));
  const stalled = new Writable({
    highWaterMark: 16,
    write() {
      // Never acknowledge the chunk: the consumer is backpressured forever.
    },
  });
  const controller = new AbortController();
  const replay = replayVerificationLog(file, stalled, controller.signal);
  const outcome = replay.then(
    () => "completed",
    (error: unknown) => (error instanceof Error ? error.name : "unknown")
  );
  setTimeout(() => controller.abort(), 50);
  expect(await outcome).toBe("AbortError");
  expect(stalled.listenerCount("error")).toBe(0);
});

test("failed sessions are retained, count bounded, and expired logs pruned", async () => {
  const root = await createRoot();
  for (let index = 0; index < 22; index += 1) {
    const logs = await createVerificationLogs(root);
    await logs.create("failure detail");
    await logs.finish(false);
  }
  expect(await readdir(root)).toHaveLength(20);
  await pruneVerificationLogs(root, Date.now() + 8 * 24 * 60 * 60 * 1000);
  expect(await readdir(root)).toEqual([]);
});

test("replaying repeatedly leaves the shared destination's listeners unchanged", async () => {
  const root = await createRoot();
  const file = path.join(root, "repeat.log");
  await writeFile(file, "log output");
  const sink = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  const events = ["error", "close", "finish", "end"];
  const baseline = events.map((event) => sink.listenerCount(event));
  for (let index = 0; index < 25; index += 1) {
    await replayVerificationLog(file, sink);
    expect(events.map((event) => sink.listenerCount(event))).toEqual(baseline);
  }
  sink.end();
});

test("pruning preserves active sessions, foreign files, and symlinked directories", async () => {
  const root = await createRoot();
  const active = await createVerificationLogs(root);
  await active.create("active command");
  const foreign = path.join(root, "run-123-foreign");
  await mkdir(foreign);
  await writeFile(path.join(foreign, "keep.txt"), "unrelated");
  const target = await createRoot();
  await symlink(target, path.join(root, "run-123-symlink"));
  await pruneVerificationLogs(root, Date.now() + 8 * 24 * 60 * 60 * 1000);
  expect(await readdir(root)).toHaveLength(3);
  expect(await readFile(path.join(foreign, "keep.txt"), "utf-8")).toBe(
    "unrelated"
  );
  expect(await readdir(target)).toEqual([]);
  await active.finish(true);
});
