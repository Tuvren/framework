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

import { TuvrenPersistenceError } from "@tuvren/core";
import type { StoredObject, StoredRun } from "@tuvren/kernel-protocol";

import type { BackendState } from "../src/index.ts";

const firstModules = [
  "../src/lib/backend-invariant-record-utils.ts",
  "../src/lib/backend-invariant-run-logic.ts",
  "../src/index.ts",
] as const;

const firstModule = process.env.TUVREN_BACKEND_SHARED_FACTORY_FIRST_MODULE;

if (firstModule === undefined) {
  for (const modulePath of firstModules) {
    test(`preserves factory behavior when ${modulePath} initializes first`, () => {
      const result = spawnSync(process.execPath, ["test", import.meta.path], {
        cwd: import.meta.dir,
        encoding: "utf-8",
        env: {
          ...process.env,
          TUVREN_BACKEND_SHARED_FACTORY_FIRST_MODULE: modulePath,
        },
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
  test("keeps canonical factories, durable clones, and first validation failure", async () => {
    await import(firstModule);
    const publicApi = await import("../src/index.ts");
    const recordModule =
      await import("../src/lib/backend-invariant-record-utils.ts");
    const runModule = await import("../src/lib/backend-invariant-run-logic.ts");

    expect(publicApi.createBackendInvariantRecordUtils).toBe(
      recordModule.createBackendInvariantRecordUtils
    );
    expect(publicApi.createBackendInvariantRunLogic).toBe(
      runModule.createBackendInvariantRunLogic
    );

    const recordUtils = publicApi.createBackendInvariantRecordUtils({
      errorPrefix: "proof",
    });
    const sourceBytes = Uint8Array.of(1, 2, 3);
    const storedObject: StoredObject = {
      byteLength: sourceBytes.byteLength,
      bytes: sourceBytes,
      createdAtMs: 1,
      hash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      mediaType: "application/octet-stream",
    };
    const objects = new Map<string, StoredObject>();

    recordUtils.putImmutableRecord(
      objects,
      storedObject.hash,
      storedObject,
      (record) => recordUtils.cloneStoredObject(record),
      (left, right) => recordUtils.areStoredObjectsEqual(left, right),
      "object"
    );
    sourceBytes[0] = 9;

    expect(objects.get(storedObject.hash)?.bytes).toEqual(
      Uint8Array.of(1, 2, 3)
    );

    let missingObjectError: unknown;
    const state: BackendState = {
      branches: new Map(),
      objects,
      observeAnnotations: new Map(),
      orderedPathChunks: new Map(),
      runs: new Map(),
      schemas: new Map(),
      stagedResults: new Map(),
      threads: new Map(),
      turnNodes: new Map(),
      turnTreePaths: new Map(),
      turnTrees: new Map(),
      turns: new Map(),
    };
    try {
      recordUtils.ensureObjectExists(state, "missing", "run.startObjectHash");
    } catch (error: unknown) {
      missingObjectError = error;
    }

    expect(missingObjectError).toMatchObject({
      code: "proof_backend_missing_object_reference",
      details: { hash: "missing", label: "run.startObjectHash" },
      message: "run.startObjectHash must reference an existing object",
    });
    if (!(missingObjectError instanceof TuvrenPersistenceError)) {
      throw new TypeError("expected a TuvrenPersistenceError");
    }
    if (
      typeof missingObjectError.details !== "object" ||
      missingObjectError.details === null ||
      Array.isArray(missingObjectError.details)
    ) {
      throw new TypeError("expected object-shaped persistence error details");
    }
    expect(Object.keys(missingObjectError.details)).toEqual(["hash", "label"]);

    const runLogic = publicApi.createBackendInvariantRunLogic({
      decodeRunCreatedTurnNodeHashes: (_run: StoredRun) => [],
      errorPrefix: "proof",
    });
    const existingRun: StoredRun = {
      branchId: "branch_1",
      createdAtMs: 1,
      createdTurnNodesCbor: new Uint8Array(),
      currentStepIndex: 0,
      runId: "run_1",
      schemaId: "schema_1",
      startTurnNodeHash: "hash_1",
      status: "running",
      stepSequenceCbor: new Uint8Array(),
      turnId: "turn_1",
      updatedAtMs: 1,
    };
    const invalidRun: StoredRun = {
      ...existingRun,
      branchId: "branch_2",
      turnId: "turn_2",
    };
    let runError: unknown;

    try {
      runLogic.assertRunUpdateIsLegal(existingRun, invalidRun);
    } catch (error: unknown) {
      runError = error;
    }

    expect(runError).toMatchObject({
      code: "proof_backend_run_branch_immutable",
      details: { nextValue: "branch_2", previousValue: "branch_1" },
      message: "record.branchId must remain immutable",
    });
    if (!(runError instanceof TuvrenPersistenceError)) {
      throw new TypeError("expected a TuvrenPersistenceError");
    }
    if (
      typeof runError.details !== "object" ||
      runError.details === null ||
      Array.isArray(runError.details)
    ) {
      throw new TypeError("expected object-shaped persistence error details");
    }
    expect(Object.keys(runError.details)).toEqual([
      "nextValue",
      "previousValue",
    ]);
  });
}
