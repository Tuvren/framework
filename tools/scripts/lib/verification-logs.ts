/**
 * Copyright 2026 Oscar Yáñez Cisterna (@SkrOYC)
 * Licensed under the Apache License, Version 2.0.
 */

import { createReadStream } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_RETAINED_RUNS = 20;
const RUN_NAME = /^run-(\d+)-[A-Za-z0-9]+$/u;
const LOG_NAME = /^\d+\.log$/u;
const OWNER_FILE = "owner.json";
const OWNER_KIND = "tuvren-verification-logs-v1";

interface LogOwner {
  createdAt: number;
  finishedAt?: number;
  kind: typeof OWNER_KIND;
  pid: number;
}

interface InactiveRun {
  directory: string;
  timestamp: number;
}

const readOwner = async (directory: string): Promise<LogOwner | undefined> => {
  const ownerPath = path.join(directory, OWNER_FILE);
  try {
    const stat = await lstat(ownerPath);
    if (!stat.isFile() || stat.size > 1024) {
      return undefined;
    }
    const value: unknown = JSON.parse(await readFile(ownerPath, "utf-8"));
    if (
      value === null ||
      typeof value !== "object" ||
      !("kind" in value && value.kind === OWNER_KIND) ||
      !(
        "pid" in value &&
        typeof value.pid === "number" &&
        Number.isSafeInteger(value.pid) &&
        value.pid > 0
      ) ||
      !(
        "createdAt" in value &&
        typeof value.createdAt === "number" &&
        Number.isFinite(value.createdAt)
      )
    ) {
      return undefined;
    }
    if (
      "finishedAt" in value &&
      (typeof value.finishedAt !== "number" ||
        !Number.isFinite(value.finishedAt))
    ) {
      return undefined;
    }
    return {
      createdAt: value.createdAt,
      finishedAt:
        "finishedAt" in value && typeof value.finishedAt === "number"
          ? value.finishedAt
          : undefined,
      kind: OWNER_KIND,
      pid: value.pid,
    };
  } catch {
    // Unknown directories and partially written owner files are never deleted.
    return undefined;
  }
};

const isRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    // Permission errors aren't evidence that a process has stopped.
    return !(
      error instanceof Error &&
      "code" in error &&
      error.code === "ESRCH"
    );
  }
};

/** Prunes only recognized, inactive run directories within this cache. */
export const pruneVerificationLogs = async (
  root: string,
  now = Date.now()
): Promise<void> => {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const inactive: InactiveRun[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const match = RUN_NAME.exec(entry.name);
    if (!entry.isDirectory() || match === null) {
      continue;
    }
    const directory = path.join(root, entry.name);
    const owner = await readOwner(directory);
    if (
      owner === undefined ||
      owner.pid !== Number(match[1]) ||
      (owner.finishedAt === undefined && isRunning(owner.pid))
    ) {
      continue;
    }
    // Another verification process can prune the same inactive directory.
    const files = await readdir(directory, { withFileTypes: true }).catch(
      () => undefined
    );
    if (files === undefined) {
      continue;
    }
    if (
      files.some(
        (file) =>
          !file.isFile() ||
          (file.name !== OWNER_FILE && !LOG_NAME.test(file.name))
      )
    ) {
      continue;
    }
    inactive.push({
      directory,
      timestamp: owner.finishedAt ?? owner.createdAt,
    });
  }
  inactive.sort((left, right) => right.timestamp - left.timestamp);
  for (const [index, run] of inactive.entries()) {
    if (index >= MAX_RETAINED_RUNS || now - run.timestamp > RETENTION_MS) {
      await rm(run.directory, { force: true, recursive: true });
    }
  }
};

/** Streams fixed-size chunks with backpressure; never reads an entire log. */
export const replayVerificationLog = async (
  file: string,
  output: Writable = process.stdout
): Promise<void> => {
  // pipeline retains listeners on its streams. Give each replay a disposable
  // destination instead of accumulating pipeline state on process.stdout.
  const forward = new Writable({
    write(chunk: Buffer, encoding, callback) {
      output.write(chunk, encoding, callback);
    },
  });
  const onError = (error: Error): void => {
    forward.destroy(error);
  };
  output.on("error", onError);
  try {
    await pipeline(createReadStream(file), forward);
  } finally {
    output.removeListener("error", onError);
  }
};

export interface VerificationLogs {
  create: (header: string) => Promise<string>;
  directory: string;
  finish: (success: boolean) => Promise<void>;
}

export const createVerificationLogs = async (
  root = path.resolve(process.env.VERIFY_LOG_DIR ?? ".cache/verification")
): Promise<VerificationLogs> => {
  await pruneVerificationLogs(root);
  const directory = await mkdtemp(path.join(root, `run-${process.pid}-`));
  const owner: LogOwner = {
    createdAt: Date.now(),
    kind: OWNER_KIND,
    pid: process.pid,
  };
  await writeFile(path.join(directory, OWNER_FILE), JSON.stringify(owner), {
    mode: 0o600,
  });
  let nextLog = 0;
  return {
    create: async (header) => {
      const file = path.join(directory, `${nextLog++}.log`);
      await writeFile(file, header, { flag: "wx", mode: 0o600 });
      return file;
    },
    directory,
    finish: async (success) => {
      if (success) {
        await rm(directory, { force: true, recursive: true });
      } else {
        await writeFile(
          path.join(directory, OWNER_FILE),
          JSON.stringify({ ...owner, finishedAt: Date.now() }),
          { mode: 0o600 }
        );
      }
      await pruneVerificationLogs(root);
    },
  };
};
