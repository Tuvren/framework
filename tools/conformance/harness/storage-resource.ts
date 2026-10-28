import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

export type DurableStorageKind = "sqlite-directory" | "postgres-database";

export class StorageResourceError extends Error {
  constructor(action: string, cause: unknown) {
    super(`failed to ${action} check storage`, { cause });
    this.name = "StorageResourceError";
  }
}

const storageOperation = async <T>(
  action: string,
  operation: () => Promise<T>
): Promise<T> => {
  try {
    return await operation();
  } catch (error: unknown) {
    throw new StorageResourceError(action, error);
  }
};

const exec = promisify(execFile);

const databaseCommand = async (sql: string): Promise<void> => {
  await exec("psql", [
    "-Xq",
    "-v",
    "ON_ERROR_STOP=1",
    "-d",
    "postgres",
    "-c",
    sql,
  ]);
};

export const withCheckStorage = async <T>(
  kind: DurableStorageKind,
  check: (storageRef: string) => Promise<T>
): Promise<T> => {
  if (kind === "sqlite-directory") {
    const directory = await storageOperation(
      "provision",
      async () => await mkdtemp(path.join(tmpdir(), "tuvren-conformance-"))
    );
    try {
      return await check(directory);
    } finally {
      await storageOperation(
        "remove",
        async () => await rm(directory, { recursive: true, force: true })
      );
    }
  }

  const database = `tuvren_cert_${randomUUID().replaceAll("-", "")}`;
  await storageOperation(
    "provision",
    async () => await databaseCommand(`CREATE DATABASE "${database}"`)
  );
  try {
    return await check(database);
  } finally {
    await storageOperation(
      "remove",
      async () =>
        await databaseCommand(
          `DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`
        )
    );
  }
};
