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

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "tsup";

const configDir = dirname(fileURLToPath(import.meta.url));

// Absolute path to SQLite migrations — copied alongside the bundle so that
// import.meta.url-relative resolution inside bundled @tuvren/backend-sqlite
// finds ./migrations next to batteries-included-node-host.mjs.
const MIGRATIONS_SRC = join(
  configDir,
  "../../../../kernel/implementations/typescript/backend-sqlite/migrations"
);
const MIGRATIONS_DEST = join(configDir, "dist/migrations");

export default defineConfig({
  banner: {
    js: 'import { createRequire as createNodeRequire } from "node:module"; const require = createNodeRequire(import.meta.url);',
  },
  clean: false,
  dts: false,
  entry: ["src/batteries-included-node-host.ts"],
  external: ["better-sqlite3"],
  format: ["esm"],
  noExternal: [/^@tuvren\//],
  onSuccess: `rm -rf "${MIGRATIONS_DEST}" && cp -r "${MIGRATIONS_SRC}" "${MIGRATIONS_DEST}"`,
  outDir: "dist",
  platform: "node",
  sourcemap: false,
  target: "esnext",
});
