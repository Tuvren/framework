import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { withCheckStorage } from "../storage-resource.js";

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
