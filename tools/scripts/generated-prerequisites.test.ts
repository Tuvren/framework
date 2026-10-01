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
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createCheckPhases } from "./check.js";
import { createCodegenPhases } from "./codegen.js";
import {
  createGeneratedPrerequisitePhase,
  GENERATED_PREREQUISITE_PROJECT,
  prependGeneratedPrerequisitePhase,
} from "./lib/generated-prerequisites.js";
import { createKernelVerificationPhases } from "./verify-kernel.js";
import {
  createVerificationPhases,
  runVerificationPhases,
  type VerificationPhase,
  type VerificationStep,
} from "./verify.js";

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

  test("every executable lane factory prepends the shared cached prerequisite", () => {
    const expected = createGeneratedPrerequisitePhase({ fresh: false });
    const plans: readonly [string, readonly VerificationPhase[]][] = [
      [
        "check",
        createCheckPhases({
          base: "generated-prerequisite-test",
          includeRust: false,
        }),
      ],
      ["codegen", createCodegenPhases()],
      ["verify-kernel", createKernelVerificationPhases({ fresh: false })],
      ["verify", createVerificationPhases()],
    ];

    for (const [lane, phases] of plans) {
      expect(phases[0], lane).toEqual(expected);
    }
  });

  test("the actual kernel lane factory forwards fresh mode to its prerequisite", () => {
    expect(createKernelVerificationPhases({ fresh: true })[0]).toEqual(
      createGeneratedPrerequisitePhase({ fresh: true })
    );
  });

  test("the actual check plan materializes a missing output before validation", async () => {
    const scratch = createScratchDirectory();
    const generatedDirectory = path.join(
      scratch,
      "generated",
      "kernel-interop"
    );
    const phases = createCheckPhases({
      base: "generated-prerequisite-test",
      includeRust: false,
    }).slice(0, 2);
    const executed: string[] = [];
    const results = await runVerificationPhases(phases, {
      executeStep: (step) => {
        executed.push(step.id);
        if (step.id === "kernel interop generated prerequisite") {
          mkdirSync(generatedDirectory, { recursive: true });
          return 0;
        }
        return existsSync(generatedDirectory) ? 0 : 41;
      },
    });

    expect(phases.map((phase) => phase.id)).toEqual([
      "generated prerequisites",
      "inner-loop authority gate",
    ]);
    expect(results.every((result) => result.code === 0)).toBe(true);
    expect(executed[0]).toBe("kernel interop generated prerequisite");
    expect(existsSync(generatedDirectory)).toBe(true);
  });

  test("the actual check plan does not validate after generation fails", async () => {
    const phases = createCheckPhases({
      base: "generated-prerequisite-test",
      includeRust: false,
    }).slice(0, 2);
    const executed: VerificationStep[] = [];
    const results = await runVerificationPhases(phases, {
      executeStep: (step) => {
        executed.push(step);
        return step.id === "kernel interop generated prerequisite" ? 23 : 0;
      },
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.code).toBe(23);
    expect(executed.map((step) => step.id)).toEqual([
      "kernel interop generated prerequisite",
    ]);
  });

  test("the cached prerequisite target declares its generated bindings output", () => {
    const projectPath = path.join(REPO_ROOT, "spec/interop/project.json");
    const parsed: unknown = JSON.parse(readFileSync(projectPath, "utf8"));
    const project = requireObject(parsed, projectPath);
    const targets = requireObject(project.targets, `${projectPath}#targets`);
    const codegen = requireObject(targets.codegen, `${projectPath}#codegen`);

    expect(codegen.outputs).toEqual([
      "{workspaceRoot}/typescript/kernel/grpc-client/src/lib/generated/kernel-interop",
    ]);
  });
});

function createScratchDirectory(): string {
  const directory = mkdtempSync(
    path.join(tmpdir(), "generated-prerequisites-test-")
  );
  scratchDirectories.push(directory);
  return directory;
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!isUnknownRecord(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
