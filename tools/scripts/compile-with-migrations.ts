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

// Shared compile + stage-migrations pipeline for SQL-backed packages
// (KRT-BM007). backend-sqlite's build/bench/retention-dry-run/test targets
// previously each inlined the same `tsc --project <tsconfig> && mkdir -p
// <dir>/migrations && cp migrations/*.sql <dir>/migrations/` shell snippet
// in project.json; per the repo rule that shared command logic lives in
// scripts, this helper is the single home for that pipeline.
//
// Runs from the package directory (Nx target cwd):
//   bun <repo>/tools/scripts/compile-with-migrations.ts \
//     --tsconfig <tsconfig.json> --out <dir> [--clean <dir>]
//
// --clean removes the given directory first (the .tmp-* staging roots);
// --out receives the compiled tree and gets migrations/*.sql copied into
// <out>/migrations/.

import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

function readFlag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);

  if (index === -1) {
    return undefined;
  }

  const value = process.argv[index + 1];

  if (value === undefined || value.startsWith("--")) {
    throw new Error(`compile-with-migrations: --${name} requires a value`);
  }

  return value;
}

const tsconfig = readFlag("tsconfig");
const outDir = readFlag("out");
const cleanDir = readFlag("clean");

if (tsconfig === undefined || outDir === undefined) {
  throw new Error(
    "usage: bun tools/scripts/compile-with-migrations.ts --tsconfig <path> --out <dir> [--clean <dir>]"
  );
}

if (cleanDir !== undefined) {
  rmSync(cleanDir, { force: true, recursive: true });
}

const code = await new Promise<number>((resolve, reject) => {
  const child = spawn(
    "bunx",
    ["--bun", "tsc", "--project", tsconfig, "--pretty", "false"],
    { env: process.env, stdio: "inherit" }
  );

  child.once("error", reject);
  child.once("close", (exitCode) => resolve(exitCode ?? 1));
});

if (code !== 0) {
  process.exit(code);
}

const migrations = readdirSync("migrations").filter((name) =>
  name.endsWith(".sql")
);

if (migrations.length === 0) {
  throw new Error(
    "compile-with-migrations: found no migrations/*.sql files to stage — refusing to produce an empty migrations dir"
  );
}

const target = join(outDir, "migrations");
mkdirSync(target, { recursive: true });

for (const name of migrations) {
  copyFileSync(join("migrations", name), join(target, name));
}
