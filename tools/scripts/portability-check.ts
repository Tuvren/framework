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

// These checks intentionally execute from the implementation roots that own
// each TypeScript package after Epic X. The public package handles stay
// stable, but the filesystem roots moved so portability validation follows the
// actual package manifests rather than the contract or boundary roots.
const PORTABLE_PACKAGE_SURFACES: readonly PortablePackageSurface[] = [
  {
    classification: "Bun-and-Node validated",
    packageName: "@tuvren/kernel-protocol",
    packageRoot: "typescript/kernel/protocol",
  },
  {
    classification: "Bun-and-Node validated",
    packageName: "@tuvren/kernel-testkit",
    packageRoot: "typescript/kernel/testkit",
  },
  {
    classification: "Bun-and-Node validated",
    packageName: "@tuvren/provider-api",
    packageRoot: "typescript/providers/provider-api",
  },
  {
    classification: "Bun-and-Node validated",
    packageName: "@tuvren/provider-testkit",
    packageRoot: "typescript/providers/testkit",
  },
  {
    classification: "Bun-and-Node validated",
    packageName: "@tuvren/framework-testkit",
    packageRoot: "typescript/testkit",
  },
  {
    classification: "Bun-and-Node validated",
    packageName: "@tuvren/runtime",
    packageRoot: "typescript/runtime",
  },
  {
    classification: "Bun-and-Node validated",
    packageName: "@tuvren/runner-react",
    packageRoot: "typescript/runners/react",
  },
  {
    classification: "Bun-and-Node validated",
    packageName: "@tuvren/stream-core",
    packageRoot: "typescript/streaming/core",
  },
  {
    classification: "Bun-and-Node validated",
    packageName: "@tuvren/stream-sse",
    packageRoot: "typescript/streaming/sse",
  },
  {
    classification: "Bun-and-Node validated",
    packageName: "@tuvren/stream-agui",
    packageRoot: "typescript/streaming/agui",
  },
  {
    classification: "Bun-and-Node validated",
    packageName: "@tuvren/telemetry-otel",
    packageRoot: "typescript/telemetry/otel",
  },
  {
    classification: "Bun-and-Node validated",
    packageName: "@tuvren/telemetry-semconv",
    packageRoot: "typescript/telemetry/semconv",
  },
  {
    classification: "Bun-and-Node validated",
    packageName: "@tuvren/provider-bridge-ai-sdk",
    packageRoot: "typescript/providers/bridge-ai-sdk",
  },
  {
    classification: "Bun-and-Node validated",
    packageName: "@tuvren/backend-memory",
    packageRoot: "typescript/kernel/backends/memory",
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
    packageName: "@tuvren/repl-host",
    reason:
      "Bun tests cover the interactive shell plus memory scenarios; Node CLI covers SQLite reload",
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

// One import check per surface × runtime, run through a bounded pool
// instead of one sequential child process at a time (KRT-BM005; audit
// finding [G-01] — this sits on the codegen/verify critical path). The cap
// is deliberately small: import checks are startup-bound, and a modest pool
// keeps CI-runner memory pressure (and the flake risk the ticket's STOP
// condition names) low while still collapsing most of the serial wall-clock.
const IMPORT_CHECK_CONCURRENCY = 4;

interface ImportCheck {
  args: readonly string[];
  executable: string;
  label: string;
  surface: PortablePackageSurface;
}

const checks: ImportCheck[] = PORTABLE_PACKAGE_SURFACES.flatMap((surface) => {
  const importSource = `await import(${JSON.stringify(surface.packageName)});`;

  return [
    {
      args: ["--eval", importSource],
      executable: "bun",
      label: "Bun",
      surface,
    },
    {
      args: ["--input-type=module", "--eval", importSource],
      executable: "node",
      label: "Node",
      surface,
    },
  ];
});

const failures = await runImportChecks(checks);

if (failures.length > 0) {
  console.error("");
  for (const failure of failures) {
    console.error(failure);
  }
  console.error(
    `portability-check: ${failures.length} of ${checks.length} import checks failed`
  );
  process.exit(1);
}

// Every check runs to completion even after one fails — a single run
// surfaces every failing surface at once, and the summary above names each.
async function runImportChecks(
  allChecks: readonly ImportCheck[]
): Promise<string[]> {
  const failed: string[] = [];
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;

      if (index >= allChecks.length) {
        return;
      }

      const check = allChecks[index] as ImportCheck;
      const message = await runImportCheck(check);

      if (message !== undefined) {
        failed.push(message);
      }
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(IMPORT_CHECK_CONCURRENCY, allChecks.length) },
      worker
    )
  );

  return failed;
}

async function runImportCheck(check: ImportCheck): Promise<string | undefined> {
  const { output, code } = await spawnCommandCaptured(
    check.executable,
    check.args,
    check.surface.packageRoot
  );

  // Buffered while the child ran, printed as one atomic block on completion
  // so concurrent checks' output never interleaves mid-line and every line
  // stays attributable to its surface.
  const status = code === 0 ? "ok" : `FAILED (exit ${code})`;
  process.stdout.write(
    `\n==> ${check.label} import check for ${check.surface.packageName}: ${status}\n${output}`
  );

  return code === 0
    ? undefined
    : `${check.label} import check for ${check.surface.packageName} failed with code ${code}`;
}

function spawnCommandCaptured(
  executable: string,
  args: readonly string[],
  cwd: string
): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => chunks.push(chunk));

    child.once("error", reject);
    child.once("close", (code) => {
      resolve({
        code: code ?? 1,
        output: Buffer.concat(chunks).toString("utf8"),
      });
    });
  });
}
