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

import { describe, expect, test } from "bun:test";
import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type {
  RuntimeBackend,
  RuntimeBackendTx,
  StoredBranch,
  StoredObject,
  StoredObserveAnnotation,
  StoredOrderedPathChunk,
  StoredRun,
  StoredStagedResult,
  StoredThread,
  StoredTurn,
  StoredTurnNode,
  StoredTurnTree,
  StoredTurnTreePath,
} from "@tuvren/kernel-protocol";
import { encodeDeterministicKernelRecord } from "@tuvren/kernel-protocol";
import {
  createCanonicalKernelTestSchema,
  createCanonicalTurnTreePaths,
  createFaultInjectingBackend,
  createHashFromIndex,
  createStoredObjectRecord,
  createStoredSchemaRecord,
  createStoredTurnNodeRecord,
  createStoredTurnTreeRecord,
  registerBackendConformanceSuite,
  registerBackendInvariantSuite,
  registerBackendRecoverySuite,
} from "../src/index.ts";

describe("@tuvren/kernel-testkit fixtures", () => {
  test("creates the canonical kernel test schema", () => {
    deepStrictEqual(createCanonicalKernelTestSchema(), {
      incorporationRules: [
        {
          objectType: "message",
          targetPath: "messages",
        },
        {
          objectType: "context_manifest",
          targetPath: "context.manifest",
        },
      ],
      paths: [
        {
          collection: "ordered",
          path: "messages",
        },
        {
          collection: "single",
          path: "context.manifest",
        },
      ],
      schemaId: "schema_main",
    });
  });

  test("creates deterministic stored records for canonical fixtures", async () => {
    const schema = createCanonicalKernelTestSchema();
    const storedSchema = createStoredSchemaRecord(schema, 1);
    const storedObject = await createStoredObjectRecord(
      new Uint8Array([1, 2]),
      2
    );
    const storedTurnTree = await createStoredTurnTreeRecord(
      schema,
      {
        "context.manifest": null,
        messages: [storedObject.hash],
      },
      3
    );
    const storedTurnNode = await createStoredTurnNodeRecord({
      consumedStagedResults: [],
      createdAtMs: 4,
      eventHash: null,
      previousTurnNodeHash: null,
      schemaId: schema.schemaId,
      turnTreeHash: storedTurnTree.hash,
    });

    strictEqual(storedSchema.schemaId, schema.schemaId);
    strictEqual(storedObject.byteLength, 2);
    strictEqual(storedTurnTree.schemaId, schema.schemaId);
    strictEqual(storedTurnNode.previousTurnNodeHash, null);
  });

  test("creates canonical path rows for ordered and single paths", async () => {
    const schema = createCanonicalKernelTestSchema();
    const storedTurnTree = await createStoredTurnTreeRecord(
      schema,
      {
        "context.manifest": null,
        messages: [createHashFromIndex(1)],
      },
      1
    );

    deepStrictEqual(
      createCanonicalTurnTreePaths(storedTurnTree, {
        "context.manifest": null,
        messages: [createHashFromIndex(1)],
      }),
      [
        {
          collectionKind: "single",
          path: "context.manifest",
          singleHash: null,
          turnTreeHash: storedTurnTree.hash,
        },
        {
          collectionKind: "ordered",
          orderedCount: 1,
          orderedEncoding: "flat",
          orderedInlineCbor: encodeDeterministicKernelRecord([
            createHashFromIndex(1),
          ]),
          path: "messages",
          turnTreeHash: storedTurnTree.hash,
        },
      ]
    );
  });

  test("registers the shared suite entrypoints without executing them eagerly", () => {
    const registrations: Array<{ kind: "describe" | "test"; name: string }> =
      [];
    const testApi = {
      describe(name: string, register: () => void) {
        registrations.push({ kind: "describe", name });
        register();
      },
      test(name: string) {
        registrations.push({ kind: "test", name });
      },
    };

    registerBackendConformanceSuite({
      createBackend: () => {
        throw new Error("should not be called during registration");
      },
      suiteName: "conformance smoke",
      testApi,
    });
    registerBackendInvariantSuite({
      createBackend: () => {
        throw new Error("should not be called during registration");
      },
      suiteName: "invariant smoke",
      testApi,
    });
    registerBackendRecoverySuite({
      createBackend: () => {
        throw new Error("should not be called during registration");
      },
      suiteName: "recovery smoke",
      testApi,
    });

    expect(
      registrations.some((entry) => entry.name === "conformance smoke")
    ).toBe(true);
    expect(
      registrations.some((entry) => entry.name === "invariant smoke")
    ).toBe(true);
    expect(registrations.some((entry) => entry.name === "recovery smoke")).toBe(
      true
    );
    expect(registrations.some((entry) => entry.kind === "test")).toBe(true);
  });

  test("exports the fault injection seam and keeps it out of production paths", () => {
    expect(typeof createFaultInjectingBackend).toBe("function");

    const repositoryRoot = fileURLToPath(
      new URL("../../../../../../", import.meta.url)
    );
    const search = spawnSync(
      "rg",
      [
        "-n",
        "@tuvren/kernel-testkit|createFaultInjectingBackend|FaultPlan",
        "boundaries",
        "-g",
        "!**/dist/**",
      ],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
      }
    );

    if (search.error !== undefined) {
      throw search.error;
    }

    const unexpectedMatches = search.stdout
      .split("\n")
      .filter((line) => line.length > 0)
      .filter(
        (line) =>
          !(
            line.includes("/testkit/") ||
            line.includes("/conformance-adapter/") ||
            line.includes("/test/") ||
            line.includes("/bench/") ||
            line.includes("package.json:")
          )
      );

    expect(unexpectedMatches).toEqual([]);
  });

  test("injects once for the matching checkpoint branch and lets the retry commit", async () => {
    const backend = createTestBackend();
    const seeded = await seedFaultInjectionBranch(backend, "branch_once");
    const faultBackend = createFaultInjectingBackend(backend, {
      match: {
        branchId: seeded.branch.branchId,
        operation: "checkpoint",
      },
      point: "before-commit",
      policy: "once",
    });

    const writeChildHead = async (target: RuntimeBackend): Promise<void> => {
      await target.transact(async (tx) => {
        await tx.turnNodes.put(seeded.childNode);
        await tx.branches.set({
          ...seeded.branch,
          headTurnNodeHash: seeded.childNode.hash,
          updatedAtMs: seeded.branch.updatedAtMs + 1,
        });
      });
    };

    await expect(writeChildHead(faultBackend)).rejects.toMatchObject({
      code: "kernel_persistence_fault_injected",
    });
    await writeChildHead(faultBackend);

    const branchHead = await readBranchHeadHash(
      backend,
      seeded.branch.branchId
    );
    expect(branchHead).toBe(seeded.childNode.hash);
  });

  test("repeats matching injections when the policy is always", async () => {
    const backend = createTestBackend();
    const seeded = await seedFaultInjectionBranch(backend, "branch_always");
    const faultBackend = createFaultInjectingBackend(backend, {
      match: {
        branchId: seeded.branch.branchId,
        operation: "checkpoint",
      },
      point: "before-commit",
      policy: "always",
    });

    const writeChildHead = async (): Promise<void> => {
      await faultBackend.transact(async (tx) => {
        await tx.turnNodes.put(seeded.childNode);
        await tx.branches.set({
          ...seeded.branch,
          headTurnNodeHash: seeded.childNode.hash,
          updatedAtMs: seeded.branch.updatedAtMs + 1,
        });
      });
    };

    await expect(writeChildHead()).rejects.toMatchObject({
      code: "kernel_persistence_fault_injected",
    });
    await expect(writeChildHead()).rejects.toMatchObject({
      code: "kernel_persistence_fault_injected",
    });

    const branchHead = await readBranchHeadHash(
      backend,
      seeded.branch.branchId
    );
    expect(branchHead).toBe(seeded.branch.headTurnNodeHash);
  });

  test("skips injection when the branch match does not apply", async () => {
    const backend = createTestBackend();
    const seeded = await seedFaultInjectionBranch(backend, "branch_match_skip");
    const faultBackend = createFaultInjectingBackend(backend, {
      match: {
        branchId: "branch_other",
        operation: "checkpoint",
      },
      point: "before-commit",
      policy: "once",
    });

    await faultBackend.transact(async (tx) => {
      await tx.turnNodes.put(seeded.childNode);
      await tx.branches.set({
        ...seeded.branch,
        headTurnNodeHash: seeded.childNode.hash,
        updatedAtMs: seeded.branch.updatedAtMs + 1,
      });
    });

    const branchHead = await readBranchHeadHash(
      backend,
      seeded.branch.branchId
    );
    expect(branchHead).toBe(seeded.childNode.hash);
  });

  test("simulates the configured concurrent writer when the wrapped commit aborts", async () => {
    const backend = createTestBackend();
    const seeded = await seedFaultInjectionBranch(
      backend,
      "branch_concurrent_writer"
    );
    const faultBackend = createFaultInjectingBackend(backend, {
      concurrentWriter: {
        branchId: seeded.branch.branchId,
      },
      match: {
        branchId: seeded.branch.branchId,
        operation: "checkpoint",
      },
      point: "before-commit",
      policy: "once",
    });

    await expect(
      faultBackend.transact(async (tx) => {
        await tx.turnNodes.put(seeded.childNode);
        await tx.branches.set({
          ...seeded.branch,
          headTurnNodeHash: seeded.childNode.hash,
          updatedAtMs: seeded.branch.updatedAtMs + 1,
        });
      })
    ).rejects.toMatchObject({
      code: "kernel_persistence_fault_injected",
    });

    const finalBranch = await readBranch(backend, seeded.branch.branchId);

    if (finalBranch === null) {
      throw new Error("expected seeded branch after concurrent writer run");
    }

    const finalHead = await readTurnNode(backend, finalBranch.headTurnNodeHash);

    if (finalHead === null) {
      throw new Error("expected concurrent writer head turn node");
    }

    expect(finalBranch.headTurnNodeHash).not.toBe(
      seeded.branch.headTurnNodeHash
    );
    expect(finalBranch.headTurnNodeHash).not.toBe(seeded.childNode.hash);
    expect(finalHead.previousTurnNodeHash).toBe(seeded.rootNode.hash);
  });

  test("preserves the injected fault when the concurrent writer also fails", async () => {
    const backend = createTestBackend();
    const seeded = await seedFaultInjectionBranch(
      backend,
      "branch_concurrent_writer_mid_commit"
    );
    const faultBackend = createFaultInjectingBackend(backend, {
      concurrentWriter: {
        branchId: seeded.branch.branchId,
      },
      match: {
        branchId: seeded.branch.branchId,
        operation: "checkpoint",
      },
      point: "mid-commit",
      policy: "once",
    });

    await expect(
      faultBackend.transact(async (tx) => {
        await tx.turnNodes.put(seeded.childNode);
        await tx.branches.set({
          ...seeded.branch,
          headTurnNodeHash: seeded.childNode.hash,
          updatedAtMs: seeded.branch.updatedAtMs + 1,
        });
      })
    ).rejects.toMatchObject({
      code: "kernel_persistence_fault_injected",
    });

    const finalBranch = await readBranch(backend, seeded.branch.branchId);

    if (finalBranch === null) {
      throw new Error("expected branch after preserved mid-commit fault");
    }

    expect(finalBranch.headTurnNodeHash).toBe(seeded.childNode.hash);
  });
});

async function seedFaultInjectionBranch(
  backend: RuntimeBackend,
  branchId: string
): Promise<{
  branch: StoredBranch;
  childNode: StoredTurnNode;
  rootNode: StoredTurnNode;
}> {
  const rootNode = await createStoredTurnNodeRecord({
    consumedStagedResults: [],
    createdAtMs: 12,
    eventHash: null,
    previousTurnNodeHash: null,
    schemaId: "schema_fault_injection",
    turnTreeHash: createHashFromIndex(99),
  });
  const childNode = await createStoredTurnNodeRecord({
    consumedStagedResults: [],
    createdAtMs: 13,
    eventHash: null,
    previousTurnNodeHash: rootNode.hash,
    schemaId: rootNode.schemaId,
    turnTreeHash: rootNode.turnTreeHash,
  });
  const branch: StoredBranch = {
    branchId,
    createdAtMs: 15,
    headTurnNodeHash: rootNode.hash,
    threadId: `${branchId}_thread`,
    updatedAtMs: 15,
  };

  await backend.transact(async (tx) => {
    await tx.turnNodes.put(rootNode);
    await tx.branches.set(branch);
  });

  return {
    branch,
    childNode,
    rootNode,
  };
}

async function readBranch(
  backend: RuntimeBackend,
  branchId: string
): Promise<StoredBranch | null> {
  return await backend.transact(async (tx) => await tx.branches.get(branchId));
}

async function readBranchHeadHash(
  backend: RuntimeBackend,
  branchId: string
): Promise<string | null> {
  const branch = await readBranch(backend, branchId);
  return branch?.headTurnNodeHash ?? null;
}

async function readTurnNode(
  backend: RuntimeBackend,
  turnNodeHash: string
): Promise<StoredTurnNode | null> {
  return await backend.transact(
    async (tx) => await tx.turnNodes.get(turnNodeHash)
  );
}

function createTestBackend(): RuntimeBackend {
  const faultControl = Symbol("fault-control");
  const state = {
    branches: new Map<string, StoredBranch>(),
    objects: new Map<string, StoredObject>(),
    turnNodes: new Map<string, StoredTurnNode>(),
  };
  let hooks: {
    afterCommitBeforeAck?(): Promise<void>;
    beforeCommit?(): Promise<void>;
    midCommit?(commit: () => Promise<void>): Promise<void>;
  } | null = null;
  let transactionQueue = Promise.resolve();

  const backend: RuntimeBackend & Record<PropertyKey, unknown> = {
    [faultControl]: {
      setFaultHooks(nextHooks: typeof hooks) {
        hooks = nextHooks;
      },
      supportsFaultPoint() {
        return true;
      },
    },
    capabilities() {
      return { "thread.enumeration": false };
    },
    health() {
      return Promise.resolve({ ok: true });
    },
    async transact<T>(work: (tx: RuntimeBackendTx) => Promise<T>): Promise<T> {
      const priorTransaction = transactionQueue;
      let releaseQueue: (() => void) | undefined;

      transactionQueue = new Promise<void>((resolve) => {
        releaseQueue = resolve;
      });

      await priorTransaction;

      const draft = {
        branches: new Map(state.branches),
        objects: new Map(state.objects),
        turnNodes: new Map(state.turnNodes),
      };
      const tx = createTestTransaction(draft);

      try {
        const result = await work(tx);
        await hooks?.beforeCommit?.();

        let committed = false;
        const commit = (): Promise<void> => {
          if (committed) {
            throw new Error("test backend commit hook attempted double commit");
          }

          state.branches = draft.branches;
          state.objects = draft.objects;
          state.turnNodes = draft.turnNodes;
          committed = true;
          return Promise.resolve();
        };

        if (hooks?.midCommit === undefined) {
          await commit();
        } else {
          await hooks.midCommit(commit);

          if (!committed) {
            throw new Error("test backend mid-commit hook must commit once");
          }
        }

        await hooks?.afterCommitBeforeAck?.();
        return result;
      } finally {
        releaseQueue?.();
      }
    },
  };

  return backend;
}

function createTestTransaction(state: {
  branches: Map<string, StoredBranch>;
  objects: Map<string, StoredObject>;
  turnNodes: Map<string, StoredTurnNode>;
}): RuntimeBackendTx {
  return {
    branches: {
      get(branchId) {
        return Promise.resolve(state.branches.get(branchId) ?? null);
      },
      listByThread() {
        return Promise.resolve([]);
      },
      set(record) {
        const existing = state.branches.get(record.branchId);

        if (
          existing !== undefined &&
          classifyTurnNodeRelationship(
            state.turnNodes,
            existing.headTurnNodeHash,
            record.headTurnNodeHash
          ) === "lateral"
        ) {
          throw createBranchHeadLateralMoveError(
            existing.headTurnNodeHash,
            record.headTurnNodeHash
          );
        }

        state.branches.set(record.branchId, structuredClone(record));
        return Promise.resolve();
      },
    },
    objects: {
      get(hash) {
        return Promise.resolve(state.objects.get(hash) ?? null);
      },
      has(hash) {
        return Promise.resolve(state.objects.has(hash));
      },
      put(record) {
        state.objects.set(record.hash, structuredClone(record));
        return Promise.resolve();
      },
    },
    observeAnnotations: {
      listByRun() {
        return Promise.resolve<StoredObserveAnnotation[]>([]);
      },
      set() {
        return Promise.resolve();
      },
    },
    orderedPathChunks: {
      get() {
        return Promise.resolve<StoredOrderedPathChunk | null>(null);
      },
      put() {
        return Promise.resolve();
      },
    },
    stagedResults: {
      clearRun() {
        return Promise.resolve();
      },
      get() {
        return Promise.resolve<StoredStagedResult | null>(null);
      },
      listByRun() {
        return Promise.resolve<StoredStagedResult[]>([]);
      },
      set() {
        return Promise.resolve();
      },
    },
    turnNodes: {
      get(hash) {
        return Promise.resolve(state.turnNodes.get(hash) ?? null);
      },
      put(record) {
        state.turnNodes.set(record.hash, structuredClone(record));
        return Promise.resolve();
      },
    },
    turns: {
      get() {
        return Promise.resolve<StoredTurn | null>(null);
      },
      listByThread() {
        return Promise.resolve<StoredTurn[]>([]);
      },
      set() {
        return Promise.resolve();
      },
    },
    threads: {
      get() {
        return Promise.resolve<StoredThread | null>(null);
      },
      list() {
        return Promise.resolve({ threads: [] });
      },
      put() {
        return Promise.resolve();
      },
    },
    turnTrees: {
      get() {
        return Promise.resolve<StoredTurnTree | null>(null);
      },
      put() {
        return Promise.resolve();
      },
    },
    turnTreePaths: {
      get() {
        return Promise.resolve<StoredTurnTreePath | null>(null);
      },
      listByTurnTree() {
        return Promise.resolve<StoredTurnTreePath[]>([]);
      },
      putMany() {
        return Promise.resolve();
      },
    },
    schemas: {
      get() {
        return Promise.resolve(null);
      },
      put() {
        return Promise.resolve();
      },
    },
    runs: {
      get() {
        return Promise.resolve<StoredRun | null>(null);
      },
      listByBranch() {
        return Promise.resolve<StoredRun[]>([]);
      },
      listExpired() {
        return Promise.resolve<StoredRun[]>([]);
      },
      set() {
        return Promise.resolve();
      },
    },
  };
}

function classifyTurnNodeRelationship(
  turnNodes: Map<string, StoredTurnNode>,
  sourceHash: string,
  targetHash: string
): "ancestor" | "descendant" | "lateral" | "same" {
  if (sourceHash === targetHash) {
    return "same";
  }

  if (hasAncestor(turnNodes, targetHash, sourceHash)) {
    return "descendant";
  }

  if (hasAncestor(turnNodes, sourceHash, targetHash)) {
    return "ancestor";
  }

  return "lateral";
}

function hasAncestor(
  turnNodes: Map<string, StoredTurnNode>,
  startHash: string,
  ancestorHash: string
): boolean {
  let current = turnNodes.get(startHash);

  while (current !== undefined && current.previousTurnNodeHash !== null) {
    if (current.previousTurnNodeHash === ancestorHash) {
      return true;
    }

    current = turnNodes.get(current.previousTurnNodeHash);
  }

  return false;
}

function createBranchHeadLateralMoveError(
  previousHeadTurnNodeHash: string,
  nextHeadTurnNodeHash: string
): Error & { code: string } {
  return Object.assign(
    new Error(
      "record.headTurnNodeHash must remain on the same thread lineage as the current branch head"
    ),
    {
      code: "test_backend_branch_head_lateral_move",
      details: {
        nextHeadTurnNodeHash,
        previousHeadTurnNodeHash,
      },
    }
  );
}
