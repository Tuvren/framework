import { expect, test } from "bun:test";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import {
  access,
  chmod,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { which } from "bun";

import {
  CleanupError,
  sweepStaleDatabases,
  withCheckStorage,
  withCleanup,
} from "../storage-resource.js";

const exec = promisify(execFile);

const databaseExists = async (name: string): Promise<boolean> => {
  const { stdout } = await exec("psql", [
    "-XAt",
    "-v",
    "ON_ERROR_STOP=1",
    "-d",
    "postgres",
    "-c",
    `SELECT count(*) FROM pg_database WHERE datname = '${name}'`,
  ]);
  return stdout.trim() === "1";
};

test("SQLite resources are distinct, keep sidecars, and are removed after success and failure", async () => {
  const refs: string[] = [];
  await withCheckStorage("sqlite-directory", async (ref) => {
    refs.push(ref);
    await writeFile(path.join(ref, "kernel.sqlite-wal"), "retained");
    expect(await readFile(path.join(ref, "kernel.sqlite-wal"), "utf8")).toBe(
      "retained"
    );
  });
  await expect(
    withCheckStorage("sqlite-directory", async (ref) => {
      refs.push(ref);
      await access(ref);
      throw new Error("check failed");
    })
  ).rejects.toThrow("check failed");
  expect(refs).toHaveLength(2);
  expect(refs[0]).not.toBe(refs[1]);
  for (const ref of refs) {
    await expect(access(ref)).rejects.toThrow();
  }
});

test("PostgreSQL databases are distinct and dropped after success and failure", async () => {
  const refs: string[] = [];
  await withCheckStorage("postgres-database", async (ref) => {
    refs.push(ref);
    expect(await databaseExists(ref)).toBe(true);
  });
  await expect(
    withCheckStorage("postgres-database", async (ref) => {
      refs.push(ref);
      expect(await databaseExists(ref)).toBe(true);
      throw new Error("check failed");
    })
  ).rejects.toThrow("check failed");
  expect(refs).toHaveLength(2);
  expect(refs[0]).not.toBe(refs[1]);
  for (const ref of refs) {
    expect(await databaseExists(ref)).toBe(false);
  }
}, 30_000);

test("a stale database sweep error is logged without blocking provisioning", async () => {
  const psql = which("psql");
  if (psql === null) {
    throw new Error("psql is required");
  }
  const directory = await mkdtemp(path.join(tmpdir(), "tuvren-sweep-error-"));
  try {
    const fakePsql = path.join(directory, "psql");
    await writeFile(
      fakePsql,
      `#!/usr/bin/env bun\nif (process.argv.some((arg) => arg.includes("starts_with(datname"))) { console.error("simulated sweep failure"); process.exit(1); }\nconst child = Bun.spawnSync([${JSON.stringify(psql)}, ...process.argv.slice(2)], { stdin: "inherit", stdout: "inherit", stderr: "inherit" }); process.exit(child.exitCode);\n`
    );
    await chmod(fakePsql, 0o755);
    const child = spawn(
      process.execPath,
      [
        "--eval",
        `import { withCheckStorage } from "./tools/conformance/harness/storage-resource.ts"; await withCheckStorage("postgres-database", async () => {});`,
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, PATH: `${directory}:${process.env.PATH ?? ""}` },
        stdio: ["ignore", "ignore", "pipe"],
      }
    );
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const [code] = await once(child, "close");
    expect(code).toBe(0);
    expect(stderr).toContain("stale certification database sweep failed");
    expect(stderr).toContain("simulated sweep failure");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

test("cleanup failure retains both the check result and its own error", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "tuvren-cleanup-"));
  const previousTmp = process.env.TMPDIR;
  process.env.TMPDIR = root;
  try {
    let failure: unknown;
    try {
      await withCheckStorage("sqlite-directory", async () => {
        await chmod(root, 0o500);
        return { status: "fail", message: "semantic failure" };
      });
    } catch (error: unknown) {
      failure = error;
    } finally {
      await chmod(root, 0o700);
    }
    expect(failure).toBeInstanceOf(CleanupError);
    if (!(failure instanceof CleanupError)) {
      throw new Error("missing cleanup failure");
    }
    expect(failure.result).toEqual({
      status: "fail",
      message: "semantic failure",
    });
    expect(failure.cleanupError).toBeInstanceOf(Error);
  } finally {
    if (previousTmp === undefined) {
      delete process.env.TMPDIR;
    } else {
      process.env.TMPDIR = previousTmp;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("cleanup failure retains the original thrown error", async () => {
  const primary = new Error("check failed");
  let failure: unknown;
  try {
    await withCleanup(
      () => Promise.reject(primary),
      () => Promise.reject(new Error("cleanup failed"))
    );
  } catch (error: unknown) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(CleanupError);
  if (!(failure instanceof CleanupError)) {
    throw new Error("missing cleanup failure");
  }
  expect(failure.primaryError).toBe(primary);
  expect(failure.message).toContain("check failed");
  expect(failure.message).toContain("cleanup failed");
  try {
    await withCleanup(
      () => Promise.reject(failure),
      () => Promise.reject(new Error("second cleanup failed"))
    );
    throw new Error("expected a nested cleanup failure");
  } catch (nested: unknown) {
    expect(nested).toBeInstanceOf(CleanupError);
    if (!(nested instanceof CleanupError)) {
      throw new Error("missing nested cleanup failure");
    }
    expect(nested.primaryError).toBe(failure);
    expect(nested.message).toContain("check failed");
    expect(nested.message).toContain("cleanup failed");
    expect(nested.message).toContain("second cleanup failed");
  }
});

test("stale database sweep only removes old unowned certification databases", async () => {
  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
  const stale = `tuvren_cert_1_99999999_${suffix}`;
  const live = `tuvren_cert_1_${process.pid}_${suffix}`;
  const active = `tuvren_cert_1_99999999_${suffix}a`;
  const newer = `tuvren_cert_${Date.now() + 60_000}_99999999_${suffix}`;
  const other = `tuvren_other_${suffix}`;
  let stopActive: (() => Promise<void>) | undefined;
  try {
    for (const name of [stale, live, active, newer, other]) {
      await exec("psql", [
        "-Xq",
        "-v",
        "ON_ERROR_STOP=1",
        "-d",
        "postgres",
        "-c",
        `CREATE DATABASE "${name}"`,
      ]);
    }
    const connection = spawn(
      "psql",
      ["-Xq", "-d", active, "-c", "SELECT pg_sleep(30)"],
      { stdio: "ignore" }
    );
    const closed = once(connection, "close");
    stopActive = async () => {
      connection.kill("SIGTERM");
      await closed;
    };
    const deadline = Date.now() + 5000;
    let connected = false;
    while (!connected && Date.now() < deadline) {
      const { stdout } = await exec("psql", [
        "-XAt",
        "-d",
        "postgres",
        "-c",
        `SELECT count(*) FROM pg_stat_activity WHERE datname = '${active}'`,
      ]);
      connected = Number(stdout.trim()) > 0;
      if (!connected) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    expect(connected).toBe(true);
    await sweepStaleDatabases(Date.now());
    expect(await databaseExists(stale)).toBe(false);
    expect(await databaseExists(live)).toBe(true);
    expect(await databaseExists(active)).toBe(true);
    expect(await databaseExists(newer)).toBe(true);
    expect(await databaseExists(other)).toBe(true);
  } finally {
    await stopActive?.();
    for (const name of [stale, live, active, newer, other]) {
      await exec("psql", [
        "-Xq",
        "-v",
        "ON_ERROR_STOP=1",
        "-d",
        "postgres",
        "-c",
        `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`,
      ]);
    }
  }
}, 30_000);
