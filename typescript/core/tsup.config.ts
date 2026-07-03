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

import { defineConfig } from "tsup";

export default defineConfig({
  clean: true,
  dts: false,
  entry: [
    "src/index.ts",
    "src/errors/index.ts",
    "src/messages/index.ts",
    "src/events/index.ts",
    "src/execution/index.ts",
    "src/tools/index.ts",
    "src/runner/index.ts",
    "src/provider/index.ts",
    "src/extensions/index.ts",
    "src/telemetry/index.ts",
    "src/capabilities/index.ts",
    "src/lifecycle/index.ts",
  ],
  format: ["esm"],
  outDir: "dist",
  sourcemap: false,
  tsconfig: "tsconfig.tsup.json",
  target: "esnext",
});
