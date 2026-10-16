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

const firstModules = [
  "../src/lib/memory-backend-buffer-isolation.ts",
  "../src/lib/memory-backend-lineage.ts",
  "../src/lib/memory-backend-reclamation.ts",
  "../src/lib/memory-backend-scope-store.ts",
  "../src/lib/memory-backend-state.ts",
  "../src/lib/memory-backend-turn-tree.ts",
  "../src/lib/memory-backend.ts",
  "../src/index.ts",
] as const;

const firstModule = process.env.TUVREN_BACKEND_MEMORY_FIRST_MODULE;

if (firstModule === undefined) {
  for (const modulePath of firstModules) {
    test(`preserves memory behavior when ${modulePath} initializes first`, () => {
      const result = spawnSync(process.execPath, ["test", import.meta.path], {
        cwd: import.meta.dir,
        encoding: "utf-8",
        env: {
          ...process.env,
          TUVREN_BACKEND_MEMORY_FIRST_MODULE: modulePath,
        },
      });

      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stderr).toContain("1 pass");
      expect(result.stderr).toContain("0 fail");
    });
  }
} else {
  test("keeps canonical exports, durable behavior, and first errors", async () => {
    await import(firstModule);

    const publicApi = await import("../src/index.ts");
    const backendModule = await import("../src/lib/memory-backend.ts");
    const bufferModule =
      await import("../src/lib/memory-backend-buffer-isolation.ts");
    const lineageModule = await import("../src/lib/memory-backend-lineage.ts");
    const reclamationModule =
      await import("../src/lib/memory-backend-reclamation.ts");
    const scopeStoreModule =
      await import("../src/lib/memory-backend-scope-store.ts");
    const stateModule = await import("../src/lib/memory-backend-state.ts");
    const turnTreeModule =
      await import("../src/lib/memory-backend-turn-tree.ts");

    expect(publicApi.createMemoryBackend).toBe(
      backendModule.createMemoryBackend
    );
    expect(publicApi.createMemoryScopeStore).toBe(
      scopeStoreModule.createMemoryScopeStore
    );

    const callerBytes = Uint8Array.of(1, 2, 3);
    const isolatedBytes = bufferModule.isolateBytes(callerBytes);
    expect(isolatedBytes).toEqual(callerBytes);
    expect(isolatedBytes).not.toBe(callerBytes);

    const isolatedRecord = bufferModule.isolateRecordBuffers({
      bytes: callerBytes,
      label: "proof",
    });
    expect(isolatedRecord).toEqual({
      bytes: Uint8Array.of(1, 2, 3),
      label: "proof",
    });
    if (
      isolatedRecord === null ||
      typeof isolatedRecord !== "object" ||
      !("bytes" in isolatedRecord) ||
      !(isolatedRecord.bytes instanceof Uint8Array)
    ) {
      throw new TypeError("expected the isolated record to retain its bytes");
    }
    expect(isolatedRecord.bytes).not.toBe(callerBytes);

    const hash = "a".repeat(64);
    const encodedHashes = turnTreeModule.encodeHashStringArray([hash]);
    expect(
      turnTreeModule.decodeHashStringArray(encodedHashes, "proof.hashes")
    ).toEqual([hash]);

    const emptyState = stateModule.createEmptyState();
    expect(reclamationModule.reclaimBackendState(emptyState, 0)).toEqual({
      releasedArchivedBranchCount: 0,
      releasedObjectCount: 0,
      releasedOrderedPathChunkCount: 0,
      releasedRunCount: 0,
      releasedTurnCount: 0,
      releasedTurnNodeCount: 0,
      releasedTurnTreeCount: 0,
      retainedObjectCount: 0,
    });

    let lineageError: unknown;
    try {
      lineageModule.classifyTurnNodeRelationship(
        emptyState,
        "source_node",
        "target_node"
      );
    } catch (error: unknown) {
      lineageError = error;
    }
    expect(lineageError).toMatchObject({
      code: "memory_backend_missing_turn_node_reference",
      details: { hash: "target_node", label: "turnNodeHash" },
      message: "turnNodeHash must reference an existing turn node",
    });
    if (!(lineageError instanceof TuvrenPersistenceError)) {
      throw new TypeError("expected a lineage persistence error");
    }
    if (
      typeof lineageError.details !== "object" ||
      lineageError.details === null ||
      Array.isArray(lineageError.details)
    ) {
      throw new TypeError("expected object-shaped lineage error details");
    }
    expect(Object.keys(lineageError.details)).toEqual(["hash", "label"]);

    const invalidState = stateModule.createEmptyState();
    invalidState.branches.set("branch_1", {
      branchId: "branch_1",
      createdAtMs: 1,
      headTurnNodeHash: hash,
      threadId: "missing_thread",
      updatedAtMs: 1,
    });
    let validationError: unknown;
    try {
      stateModule.validateCommittedState(invalidState, emptyState);
    } catch (error: unknown) {
      validationError = error;
    }
    expect(validationError).toMatchObject({
      code: "memory_backend_missing_thread_reference",
      details: { label: "branch.threadId", threadId: "missing_thread" },
      message: "branch.threadId must reference an existing thread",
    });
    if (!(validationError instanceof TuvrenPersistenceError)) {
      throw new TypeError("expected a committed-state persistence error");
    }
    if (
      typeof validationError.details !== "object" ||
      validationError.details === null ||
      Array.isArray(validationError.details)
    ) {
      throw new TypeError("expected object-shaped validation error details");
    }
    expect(Object.keys(validationError.details)).toEqual(["label", "threadId"]);

    const backend = publicApi.createMemoryBackend();
    expect(await backend.health()).toEqual({ ok: true });
    expect(
      await backend.transact(async () => await Promise.resolve("committed"))
    ).toBe("committed");
  });
}
