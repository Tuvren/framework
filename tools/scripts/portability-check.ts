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

import { spawn } from "node:child_process";
import process from "node:process";

interface PortablePackageSurface {
  classification: "Bun-and-Node validated";
  packageName: string;
  packageRoot: string;
}

interface DocumentedPackageSurface {
  classification: "mixed-runtime validated" | "Node-only" | "deferred";
  packageName: string;
  reason: string;
}

const PORTABLE_PACKAGE_SURFACES: readonly PortablePackageSurface[] = [
  {
    classification: "Bun-and-Node validated",
    packageName: "@tuvren/core-types",
    packageRoot: "boundaries/shared/contracts/core-types",
  },
  {
    classification: "Bun-and-Node validated",
    packageName: "@tuvren/kernel-protocol",
    packageRoot: "boundaries/kernel/contracts/protocol",
  },
  {
    classification: "Bun-and-Node validated",
    packageName: "@tuvren/kernel-testkit",
    packageRoot: "boundaries/kernel/testkit",
  },
  {
    classification: "Bun-and-Node validated",
    packageName: "@tuvren/provider-api",
    packageRoot: "boundaries/providers/contracts/provider-api",
  },
  {
    classification: "Bun-and-Node validated",
    packageName: "@tuvren/provider-testkit",
    packageRoot: "boundaries/providers/testkit",
  },
  {
    classification: "Bun-and-Node validated",
    packageName: "@tuvren/runtime-api",
    packageRoot: "boundaries/framework/contracts/runtime-api",
  },
  {
    classification: "Bun-and-Node validated",
    packageName: "@tuvren/driver-api",
    packageRoot: "boundaries/framework/contracts/driver-api",
  },
  {
    classification: "Bun-and-Node validated",
    packageName: "@tuvren/event-stream",
    packageRoot: "boundaries/framework/contracts/event-stream",
  },
  {
    classification: "Bun-and-Node validated",
    packageName: "@tuvren/tool-contracts",
    packageRoot: "boundaries/framework/contracts/tool-contracts",
  },
  {
    classification: "Bun-and-Node validated",
    packageName: "@tuvren/framework-testkit",
    packageRoot: "boundaries/framework/testkit",
  },
  {
    classification: "Bun-and-Node validated",
    packageName: "@tuvren/runtime-core",
    packageRoot: "boundaries/framework/implementations/typescript/runtime-core",
  },
  {
    classification: "Bun-and-Node validated",
    packageName: "@tuvren/driver-react",
    packageRoot:
      "boundaries/framework/implementations/typescript/drivers/react",
  },
  {
    classification: "Bun-and-Node validated",
    packageName: "@tuvren/stream-core",
    packageRoot: "boundaries/framework/implementations/typescript/stream-core",
  },
  {
    classification: "Bun-and-Node validated",
    packageName: "@tuvren/stream-sse",
    packageRoot: "boundaries/framework/implementations/typescript/stream-sse",
  },
  {
    classification: "Bun-and-Node validated",
    packageName: "@tuvren/stream-agui",
    packageRoot: "boundaries/framework/implementations/typescript/stream-agui",
  },
  {
    classification: "Bun-and-Node validated",
    packageName: "@tuvren/provider-bridge-ai-sdk",
    packageRoot:
      "boundaries/providers/implementations/typescript/bridge-ai-sdk",
  },
  {
    classification: "Bun-and-Node validated",
    packageName: "@tuvren/backend-memory",
    packageRoot: "boundaries/kernel/implementations/typescript/backend-memory",
  },
];

const DOCUMENTED_PACKAGE_SURFACES: readonly DocumentedPackageSurface[] = [
  {
    classification: "Node-only",
    packageName: "@tuvren/backend-sqlite",
    reason:
      "uses better-sqlite3 native addon behavior and is validated through Node-backed targets",
  },
  {
    classification: "mixed-runtime validated",
    packageName: "@tuvren/playground-host",
    reason:
      "Bun unit tests cover non-reload scenarios; Node CLI covers SQLite reload",
  },
  {
    classification: "deferred",
    packageName: "Deno package surface",
    reason: "Deno checks remain deferred until package surfaces stabilize",
  },
];

console.log("Epic Q portability matrix");

for (const surface of PORTABLE_PACKAGE_SURFACES) {
  console.log(`- ${surface.packageName}: ${surface.classification}`);
}

for (const surface of DOCUMENTED_PACKAGE_SURFACES) {
  console.log(
    `- ${surface.packageName}: ${surface.classification} (${surface.reason})`
  );
}

for (const surface of PORTABLE_PACKAGE_SURFACES) {
  const importSource = `await import(${JSON.stringify(surface.packageName)});`;

  await runImportCheck("Bun", "bun", ["--eval", importSource], surface);
  await runImportCheck(
    "Node",
    "node",
    ["--input-type=module", "--eval", importSource],
    surface
  );
}

async function runImportCheck(
  label: string,
  executable: string,
  args: readonly string[],
  surface: PortablePackageSurface
): Promise<void> {
  console.log("");
  console.log(`==> ${label} import check for ${surface.packageName}`);

  const code = await spawnCommand(executable, args, surface.packageRoot);

  if (code !== 0) {
    throw new Error(
      `${label} import check for ${surface.packageName} failed with code ${code}`
    );
  }
}

function spawnCommand(
  executable: string,
  args: readonly string[],
  cwd: string
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      env: process.env,
      stdio: "inherit",
    });

    child.once("error", reject);
    child.once("close", (code) => {
      resolve(code ?? 1);
    });
  });
}
