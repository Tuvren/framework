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

export class CleanupError extends Error {
  readonly result: unknown;
  readonly primaryError: unknown;
  readonly cleanupError: unknown;
  readonly hasResult: boolean;

  constructor(hasResult: boolean, value: unknown, cleanupError: unknown) {
    const describe = (error: unknown): string =>
      error instanceof Error ? error.message : String(error);
    super(
      `cleanup failed: ${describe(cleanupError)}${hasResult ? "" : `; check failed: ${describe(value)}`}`
    );
    this.name = "CleanupError";
    this.hasResult = hasResult;
    this.result = hasResult ? value : undefined;
    this.primaryError = hasResult ? undefined : value;
    this.cleanupError = cleanupError;
  }
}

export const withCleanup = async <T>(
  operation: () => Promise<T>,
  cleanup: () => Promise<void>
): Promise<T> => {
  let outcome: { ok: true; value: T } | { ok: false; error: unknown };
  try {
    outcome = { ok: true, value: await operation() };
  } catch (error: unknown) {
    outcome = { ok: false, error };
  }
  try {
    await cleanup();
  } catch (error: unknown) {
    throw new CleanupError(
      outcome.ok,
      outcome.ok ? outcome.value : outcome.error,
      error
    );
  }
  if (!outcome.ok) {
    throw outcome.error;
  }
  return outcome.value;
};

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
const runStartedAt = Date.now();
const OWNED_DATABASE = /^tuvren_cert_(\d+)_(\d+)_[a-f0-9]+$/u;
const LEGACY_DATABASE = /^tuvren_cert_[a-f0-9]{32}$/u;
let sweep: Promise<void> | undefined;

const processAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return !(
      error instanceof Error &&
      "code" in error &&
      error.code === "ESRCH"
    );
  }
};

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

export const sweepStaleDatabases = async (before: number): Promise<void> => {
  const { stdout } = await exec("psql", [
    "-XAt",
    "-v",
    "ON_ERROR_STOP=1",
    "-d",
    "postgres",
    "-c",
    "SELECT datname FROM pg_database WHERE starts_with(datname, 'tuvren_cert_') AND NOT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datid = pg_database.oid) ORDER BY datname",
  ]);
  for (const name of stdout.trim().split("\n")) {
    const match = OWNED_DATABASE.exec(name);
    if (match !== null) {
      const created = Number(match[1]);
      const owner = Number(match[2]);
      if (
        !(Number.isSafeInteger(created) && Number.isSafeInteger(owner)) ||
        owner <= 0 ||
        created >= before ||
        processAlive(owner)
      ) {
        continue;
      }
    } else if (LEGACY_DATABASE.test(name)) {
      const { stdout: age } = await exec("psql", [
        "-XAt",
        "-v",
        "ON_ERROR_STOP=1",
        "-d",
        "postgres",
        "-c",
        `SELECT extract(epoch FROM (pg_stat_file('base/' || oid || '/PG_VERSION', true)).modification) * 1000 FROM pg_database WHERE datname = '${name}'`,
      ]);
      const modified = Number(age.trim());
      if (
        age.trim() === "" ||
        !Number.isFinite(modified) ||
        modified >= before - 3_600_000
      ) {
        continue;
      }
    } else {
      continue;
    }
    try {
      await databaseCommand(`DROP DATABASE IF EXISTS "${name}"`);
    } catch (error: unknown) {
      if (
        !(
          error instanceof Error &&
          error.message.includes("being accessed by other users")
        )
      ) {
        throw error;
      }
    }
  }
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
    return await withCleanup(
      async () => await check(directory),
      async () =>
        await storageOperation(
          "remove",
          async () => await rm(directory, { recursive: true, force: true })
        )
    );
  }

  sweep ??= storageOperation(
    "sweep",
    async () => await sweepStaleDatabases(runStartedAt)
  );
  await sweep;
  const database = `tuvren_cert_${Date.now()}_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  await storageOperation(
    "provision",
    async () => await databaseCommand(`CREATE DATABASE "${database}"`)
  );
  return await withCleanup(
    async () => await check(database),
    async () =>
      await storageOperation(
        "remove",
        async () =>
          await databaseCommand(
            `DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`
          )
      )
  );
};
