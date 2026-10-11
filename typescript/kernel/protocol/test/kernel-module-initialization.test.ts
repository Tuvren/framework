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

import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

import type * as Protocol from "../src/index.ts";
import { rejectionOf } from "./kernel-contract-test-helpers.ts";

const firstModules = [
  "../src/index.ts",
  "../src/lib/kernel-validation.ts",
  "../src/lib/kernel-validation-records.ts",
  "../src/lib/kernel-validation-runtime.ts",
  "../src/lib/kernel-identity.ts",
  "../src/lib/kernel-validation-stored.ts",
] as const;

const firstModule = process.env.TUVREN_KERNEL_FIRST_MODULE;

if (firstModule === undefined) {
  for (const modulePath of firstModules) {
    test(`preserves public validation and identity when ${modulePath} initializes first`, () => {
      // Each process starts with an empty module cache. Importing the fixtures
      // here would initialize the public entrypoint before the selected module.
      const result = spawnSync(process.execPath, ["test", import.meta.path], {
        cwd: import.meta.dir,
        encoding: "utf-8",
        env: { ...process.env, TUVREN_KERNEL_FIRST_MODULE: modulePath },
        timeout: 10_000,
      });

      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stderr).toContain("1 pass");
      expect(result.stderr).toContain("0 fail");
    });
  }
} else {
  test("validates records and canonical identity after fresh module initialization", async () => {
    await import(firstModule);
    const protocol: typeof Protocol = await import("../src/index.ts");
    const { TuvrenValidationError } = await import("@tuvren/core");
    const { kernelProtocolLogicalFixtures: logical } =
      await import("./kernel-protocol-fixtures.js");
    const { default: deterministic } =
      await import("../../../../spec/conformance/kernel/fixtures/kernel-protocol-deterministic.json");

    expect(protocol.isRunRecord(logical.runRecord)).toBe(true);
    expect(protocol.isStagedResult(logical.stagedResult)).toBe(true);
    expect(protocol.isStepContext(logical.stepContext)).toBe(true);
    expect(protocol.isRecoveryState(logical.recoveryState)).toBe(true);
    protocol.assertRunRecord(logical.runRecord);
    protocol.assertStagedResult(logical.stagedResult);
    protocol.assertStepContext(logical.stepContext);
    protocol.assertRecoveryState(logical.recoveryState);

    // Both fields are invalid: the exact first error also pins validation order
    // across the record-to-runtime validator dependency.
    const invalidRun = {
      ...logical.runRecord,
      currentStepIndex: -1,
      status: "unknown",
    };
    expect(protocol.isRunRecord(invalidRun)).toBe(false);
    let runError: unknown;
    try {
      protocol.assertRunRecord(invalidRun, "run");
    } catch (error: unknown) {
      runError = error;
    }
    expect(runError).toBeInstanceOf(TuvrenValidationError);
    expect(runError).toMatchObject({
      code: "invalid_run_status",
      details: { value: "unknown" },
      message: "run.status must be one of running, paused, completed, failed",
      name: "TuvrenValidationError",
    });

    const invalidContext = {
      ...logical.stepContext,
      schema: { ...logical.stepContext.schema, schemaId: "" },
      step: { ...logical.stepContext.step, id: "" },
    };
    expect(protocol.isStepContext(invalidContext)).toBe(false);
    expect(() => {
      protocol.assertStepContext(invalidContext, "context");
    }).toThrow("context.schema.schemaId must be a non-empty string");

    const identity = deterministic.turnNodeIdentityRecord;
    expect(
      Buffer.from(protocol.encodeDeterministicKernelRecord(identity)).toString(
        "hex"
      )
    ).toBe(deterministic.turnNodeIdentityRecordCborHex);
    const node = {
      ...identity,
      hash: deterministic.turnNodeIdentityRecordSha256Hex,
    };
    expect(protocol.isTurnNode(node)).toBe(true);
    protocol.assertTurnNode(node);
    expect(await protocol.hashTurnNodeIdentity(node)).toBe(
      deterministic.turnNodeIdentityRecordSha256Hex
    );
    await protocol.assertTurnNodeIdentity(node);

    const wrongHash = "0".repeat(64);
    expect(
      await rejectionOf(
        protocol.assertTurnNodeIdentity({ ...node, hash: wrongHash }, "node")
      )
    ).toMatchObject({
      code: "invalid_turn_node_hash",
      details: {
        expectedHash: deterministic.turnNodeIdentityRecordSha256Hex,
        hash: wrongHash,
      },
      message: "node.hash must match the canonical TurnNode identity hash",
      name: "TuvrenValidationError",
    });
  });
}
