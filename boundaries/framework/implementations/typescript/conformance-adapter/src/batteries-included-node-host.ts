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

// Entry point compiled and run with node to support backends that require
// native Node.js addons (e.g. better-sqlite3 for the SQLite backend).
import type { AdapterCapabilities } from "../../../../../../tools/conformance/adapter-protocol/index.js";
import { serveStdioAdapter } from "../../../../../../tools/conformance/adapter-protocol/stdio-host.js";
import { TypeScriptFrameworkAdapter } from "./framework-adapter.ts";

class BatteriesIncludedAdapter extends TypeScriptFrameworkAdapter {
  override async initialize(
    packetId: string,
    planVersion: string
  ): Promise<AdapterCapabilities> {
    await super.initialize(packetId, planVersion);
    return {
      adapterId: "typescript-framework-batteries-included",
      capabilities: ["framework.batteries-included"],
      packetId,
      planVersion,
    };
  }
}

await serveStdioAdapter(new BatteriesIncludedAdapter());
