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

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  createGeneratedPrerequisitePhase,
  GENERATED_PREREQUISITE_PROJECT,
  prependGeneratedPrerequisitePhase,
} from "./lib/generated-prerequisites.js";
import { runVerificationPhases, type VerificationPhase } from "./verify.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const scratchDirectories: string[] = [];

afterEach(() => {
  for (const directory of scratchDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("generated prerequisite phase", () => {
  test("uses the cache by default and bypasses it for a fresh lane", () => {
    expect(GENERATED_PREREQUISITE_PROJECT).toBe("kernel-interop-grpc");
    expect(createGeneratedPrerequisitePhase({ fresh: false }).steps).toEqual([
      {
        command: ["bun", "run", "nx", "run", "kernel-interop-grpc:codegen"],
        id: "kernel interop generated prerequisite",
      },
    ]);
    expect(createGeneratedPrerequisitePhase({ fresh: true }).steps).toEqual([
      {
        command: [
          "bun",
          "run",
          "nx",
          "run",
          "kernel-interop-grpc:codegen",
          "--skipNxCache",
        ],
        id: "kernel interop generated prerequisite",
      },
    ]);
  });

  test("places generation before authority validation", () => {
    const authorityPhase: VerificationPhase = {
      id: "authority validation",
      steps: [],
    };

    const phases = prependGeneratedPrerequisitePhase([authorityPhase], {
      fresh: false,
    });

    expect(phases.map((phase) => phase.id)).toEqual([
      "generated prerequisites",
      "authority validation",
    ]);
  });

  test("every documented lane prepends the shared prerequisite", () => {
    for (const relative of [
      "tools/scripts/codegen.ts",
      "tools/scripts/check.ts",
      "tools/scripts/verify-kernel.ts",
      "tools/scripts/verify.ts",
    ]) {
      const source = readFileSync(path.join(REPO_ROOT, relative), "utf8");
      expect(source, relative).toContain("prependGeneratedPrerequisitePhase(");
    }
  });

  test("materializes a missing output before validation", async () => {
    const scratch = createScratchDirectory();
    const generatedDirectory = path.join(
      scratch,
      "generated",
      "kernel-interop"
    );
    const generationScript = `import { mkdirSync } from "node:fs"; mkdirSync(${JSON.stringify(generatedDirectory)}, { recursive: true })`;
    const validationScript = `import { existsSync } from "node:fs"; process.exit(existsSync(${JSON.stringify(generatedDirectory)}) ? 0 : 41)`;

    const results = await runVerificationPhases([
      executablePhase("generated prerequisites", generationScript),
      executablePhase("authority validation", validationScript),
    ]);

    expect(results.map((result) => result.code)).toEqual([0, 0]);
    expect(existsSync(generatedDirectory)).toBe(true);
  });

  test("does not run authority validation after generation fails", async () => {
    const scratch = createScratchDirectory();
    const marker = path.join(scratch, "authority-ran");
    const markerScript = `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "ran")`;

    const results = await runVerificationPhases([
      executablePhase("generated prerequisites", "process.exit(23)"),
      executablePhase("authority validation", markerScript),
    ]);

    expect(results).toHaveLength(1);
    expect(results[0]?.code).toBe(23);
    expect(existsSync(marker)).toBe(false);
  });
});

function createScratchDirectory(): string {
  const directory = mkdtempSync(
    path.join(tmpdir(), "generated-prerequisites-test-")
  );
  scratchDirectories.push(directory);
  return directory;
}

function executablePhase(id: string, script: string): VerificationPhase {
  return {
    concurrency: 1,
    id,
    // The test commands write only under the explicitly scoped scratch root.
    // Skipping the repository purity snapshot keeps this unit test focused on
    // phase ordering and failure propagation.
    mutatesWorktree: true,
    steps: [
      {
        command: [process.execPath, "-e", script],
        id,
      },
    ],
  };
}
