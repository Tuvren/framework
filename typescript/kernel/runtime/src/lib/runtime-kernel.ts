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

import { randomUUID } from "node:crypto";

import {
  TuvrenLineageError,
  TuvrenPersistenceError,
  TuvrenRuntimeError,
  TuvrenValidationError,
} from "@tuvren/core";
import type { EpochMs } from "@tuvren/core";
import { assertTurnTreeSchema } from "@tuvren/kernel-protocol";
import type {
  BranchHeadListEntry,
  KernelThreadListCursor,
  ListThreadsCursorPayload,
  ReclamationOptions,
  ReclamationSummary,
  RuntimeBackend,
  RuntimeKernel,
  RuntimeKernelRunLiveness,
  SetHeadResult,
  StoredBranch,
  StoredTurn,
  ThreadCreateResult,
  TurnTreeManifest,
} from "@tuvren/kernel-protocol";

import { mapSequential } from "./runtime-kernel-async.js";
import {
  allocateArchiveBranchId,
  applyStagedResultsToManifest,
  assertNoActiveBranchRunForForwardHeadMove,
  assertTurnHeadRewritePreservesDependents,
  classifyHeadMovement,
  collectAbandonedSegmentHashes,
  composeModifyVerdict,
  createTurnNode,
  createTurnTree,
  runTouchesSegment,
  turnNodeDescendsFrom,
  validateStagedResultsHaveRules,
  validateTurnParent,
  validateTurnTreeChangeSet,
  walkBack,
} from "./runtime-kernel-lineage.js";
import {
  createRuntimeKernelRunApi,
  createRuntimeKernelRunLivenessApi,
} from "./runtime-kernel-runs.js";
import {
  assertBranchIdAvailable,
  assertThreadCreateIdsAvailable,
  assertTurnIdAvailable,
  createEmptyManifest,
  createStagedResult,
  decodeSchema,
  decodeStoredTurnNode,
  encodeRecord,
  listStagedResults,
  putObject,
  requireBranch,
  requireRun,
  requireSchema,
  requireStoredTurn,
  requireThread,
  requireThreadTurnNode,
  requireTreeManifest,
  requireTurnTree,
  toBranchRecord,
  toStoredStagedResult,
  toTurnRecord,
} from "./runtime-kernel-storage.js";

/**
 * Encodes a `thread.list` cursor payload (ADR-0034) as the opaque
 * {@link KernelThreadListCursor} string callers pass back on the next page
 * request: JSON, then URL-safe base64.
 */
const encodeCursor = (
  payload: ListThreadsCursorPayload
): KernelThreadListCursor =>
  Buffer.from(JSON.stringify(payload), "utf-8").toString("base64url");

/**
 * Inverse of {@link encodeCursor}: decodes and validates an opaque
 * `thread.list` cursor back into its {@link ListThreadsCursorPayload} shape.
 *
 * @throws {TuvrenValidationError} With code `invalid_durable_read_cursor` when
 *   the cursor is not valid base64url, does not decode to JSON, or has an
 *   unexpected shape.
 */
const decodeCursor = (
  cursor: KernelThreadListCursor
): ListThreadsCursorPayload => {
  let raw: string;
  try {
    raw = Buffer.from(cursor, "base64url").toString("utf-8");
  } catch {
    throw new TuvrenValidationError(
      "thread.list cursor is not valid base64url",
      {
        code: "invalid_durable_read_cursor",
      }
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new TuvrenValidationError(
      "thread.list cursor payload is not valid JSON",
      {
        code: "invalid_durable_read_cursor",
      }
    );
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("v" in parsed) ||
    !("kind" in parsed) ||
    !("lastThreadId" in parsed) ||
    !("lastCreatedAtMs" in parsed) ||
    parsed.v !== 1 ||
    parsed.kind !== "list-threads" ||
    typeof parsed.lastThreadId !== "string" ||
    typeof parsed.lastCreatedAtMs !== "number"
  ) {
    throw new TuvrenValidationError(
      "thread.list cursor payload has unexpected shape",
      {
        code: "invalid_durable_read_cursor",
      }
    );
  }
  return {
    kind: parsed.kind,
    lastCreatedAtMs: parsed.lastCreatedAtMs,
    lastThreadId: parsed.lastThreadId,
    v: parsed.v,
  };
};

/**
 * Construction options for {@link createRuntimeKernel}.
 */
export interface RuntimeKernelOptions {
  /** Durable storage backend the kernel drives (kernel spec §8.1). */
  backend: RuntimeBackend;
  /**
   * Generates fencing tokens for leased runs (kernel spec §5.2).
   *
   * Default: `randomUUID` from `node:crypto`.
   */
  createFencingToken?: () => string;
  /**
   * Clock the kernel uses for durable timestamps and lease-expiry
   * comparisons, injectable for deterministic tests.
   *
   * Default: `() => Date.now()`.
   */
  now?: () => EpochMs;
}

/**
 * Builds the reference in-process {@link RuntimeKernel} implementation
 * (with the {@link RuntimeKernelRunLiveness} extension always included) over
 * a caller-supplied {@link RuntimeBackend}.
 *
 * This is the TypeScript binding's sole kernel construction path: every
 * syscall group (`branch`, `maintenance`, `node`, `run`, `runLiveness`,
 * `schema`, `staging`, `store`, `thread`, `tree`, `turn`, `verdicts`) is
 * implemented here or delegated to the sibling `runtime-kernel-*` modules,
 * driving `options.backend` transactionally per kernel spec §7/§8.1. See the
 * {@link RuntimeKernel} and {@link RuntimeKernelRunLiveness} interfaces in
 * `@tuvren/kernel-protocol` for the full per-operation contract.
 */
export const createRuntimeKernel = (
  options: RuntimeKernelOptions
): RuntimeKernel & RuntimeKernelRunLiveness => {
  const now = options.now ?? (() => Date.now());
  const { backend } = options;
  const createFencingToken = options.createFencingToken ?? randomUUID;

  return {
    branch: {
      async create(branchId, threadId, fromTurnNodeHash) {
        return await backend.transact(async (tx) => {
          await assertBranchIdAvailable(tx, branchId);
          const thread = await requireThread(tx, threadId);
          await requireThreadTurnNode(tx, fromTurnNodeHash, thread);
          const record: StoredBranch = {
            branchId,
            createdAtMs: now(),
            headTurnNodeHash: fromTurnNodeHash,
            threadId,
            updatedAtMs: now(),
          };
          await tx.branches.set(record);
          return toBranchRecord(record);
        });
      },

      async get(branchId) {
        return await backend.transact(async (tx) => {
          const branch = await tx.branches.get(branchId);
          return branch === null ? null : toBranchRecord(branch);
        });
      },

      async list(threadId) {
        return await backend.transact(async (tx) => {
          await requireThread(tx, threadId);
          const branches = await tx.branches.listByThread(threadId);
          return branches.map((branch): BranchHeadListEntry => [
            branch.branchId,
            branch.headTurnNodeHash,
          ]);
        });
      },

      async setHead(branchId, turnNodeHash) {
        return await backend.transact(async (tx) => {
          const branch = await requireBranch(tx, branchId);
          const thread = await requireThread(tx, branch.threadId);
          await requireThreadTurnNode(tx, turnNodeHash, thread);

          const currentHead = branch.headTurnNodeHash;

          if (currentHead === turnNodeHash) {
            return { branch: toBranchRecord(branch) } satisfies SetHeadResult;
          }

          const direction = await classifyHeadMovement(
            tx,
            currentHead,
            turnNodeHash
          );

          if (direction === "lateral") {
            throw new TuvrenLineageError(
              `branch.setHead cannot move laterally: "${currentHead}" and "${turnNodeHash}" share no lineage`,
              { code: "kernel_runtime_lateral_head_movement" }
            );
          }

          if (direction === "forward") {
            await assertNoActiveBranchRunForForwardHeadMove(tx, branch);
            const updated: StoredBranch = {
              ...branch,
              headTurnNodeHash: turnNodeHash,
              updatedAtMs: now(),
            };
            await tx.branches.set(updated);
            return { branch: toBranchRecord(updated) } satisfies SetHeadResult;
          }

          // Backward: atomic archival rollback
          const abandonedSegmentHashes = await collectAbandonedSegmentHashes(
            tx,
            currentHead,
            turnNodeHash
          );
          const threadBranches = await tx.branches.listByThread(
            branch.threadId
          );
          const archiveOrdinal =
            threadBranches.filter(
              (candidate) => candidate.archivedFromBranchId === branchId
            ).length + 1;
          const archiveBranchId = await allocateArchiveBranchId(tx, {
            branchId,
            currentHead,
            initialOrdinal: archiveOrdinal,
          });
          const archiveBranch: StoredBranch = {
            archivedFromBranchId: branchId,
            branchId: archiveBranchId,
            createdAtMs: now(),
            headTurnNodeHash: currentHead,
            threadId: branch.threadId,
            updatedAtMs: now(),
          };
          await tx.branches.set(archiveBranch);

          // Fail all running/paused runs on the abandoned segment
          const branchRuns = await tx.runs.listByBranch(branchId);
          for await (const _ of mapSequential(branchRuns, async (storedRun) => {
            if (
              (storedRun.status === "running" ||
                storedRun.status === "paused") &&
              runTouchesSegment(storedRun, abandonedSegmentHashes)
            ) {
              // Backward rollback must leave touched runs terminal and clean in
              // one transaction, or backend invariants reject the rewind.
              await tx.stagedResults.clearRun(storedRun.runId);
              await tx.runs.set({
                ...storedRun,
                status: "failed",
                updatedAtMs: now(),
              });
            }
          })) {
            // All writes for this run settled before processing the next run.
          }

          const updated: StoredBranch = {
            ...branch,
            headTurnNodeHash: turnNodeHash,
            updatedAtMs: now(),
          };
          await tx.branches.set(updated);

          return {
            archiveBranch: toBranchRecord(archiveBranch),
            branch: toBranchRecord(updated),
          } satisfies SetHeadResult;
        });
      },
    },

    maintenance: {
      async reclaim(
        reclamationOptions?: ReclamationOptions
      ): Promise<ReclamationSummary> {
        if (backend.capabilities()["maintenance.reclamation"] !== true) {
          throw new TuvrenPersistenceError(
            "maintenance.reclamation is not supported by this backend",
            { code: "kernel_capability_unsupported" }
          );
        }
        if (backend.reclaim === undefined) {
          throw new TuvrenPersistenceError(
            "backend advertises maintenance.reclamation but does not implement reclaim",
            { code: "kernel_capability_unsupported" }
          );
        }
        return await backend.reclaim({
          nowMs: reclamationOptions?.nowMs ?? now(),
        });
      },
    },

    node: {
      async get(hash) {
        return await backend.transact(async (tx) => {
          const node = await tx.turnNodes.get(hash);
          return node === null ? null : decodeStoredTurnNode(node);
        });
      },

      walkBack(fromHash) {
        return walkBack(backend, fromHash);
      },
    },

    run: createRuntimeKernelRunApi({
      backend,
      createFencingToken,
      now,
    }),

    runLiveness: createRuntimeKernelRunLivenessApi({
      backend,
      createFencingToken,
      now,
    }),

    schema: {
      async get(schemaId) {
        return await backend.transact(async (tx) => {
          const schema = await tx.schemas.get(schemaId);
          return schema === null ? null : decodeSchema(schema.schemaCbor);
        });
      },

      async register(schema) {
        return await backend.transact(async (tx) => {
          assertTurnTreeSchema(schema, "schema");
          const existing = await tx.schemas.get(schema.schemaId);

          if (existing !== null) {
            // The frozen kernel surface treats schema IDs as write-once
            // identities, so even byte-for-byte duplicate registrations must
            // fail instead of becoming an idempotent upsert.
            throw new TuvrenValidationError(
              `schema "${schema.schemaId}" is already registered`,
              { code: "kernel_runtime_duplicate_schema" }
            );
          }

          await tx.schemas.put({
            createdAtMs: now(),
            schemaCbor: encodeRecord(schema),
            schemaId: schema.schemaId,
          });
          return schema.schemaId;
        });
      },
    },

    staging: {
      async current(runId) {
        return await backend.transact(async (tx) => {
          await requireRun(tx, runId);
          return await listStagedResults(tx, runId);
        });
      },

      async stage(runId, blob, taskId, objectType, status, interruptPayload) {
        return await backend.transact(async (tx) => {
          const run = await requireRun(tx, runId);

          if (run.status !== "running") {
            throw new TuvrenRuntimeError(
              `run "${runId}" is not in running state (status: ${run.status})`,
              { code: "kernel_runtime_run_not_running" }
            );
          }

          const objectHash = await putObject(tx, blob, now);
          const stagedResult = createStagedResult({
            interruptPayload,
            objectHash,
            objectType,
            status,
            taskId,
            timestamp: now(),
          });
          await tx.stagedResults.set(toStoredStagedResult(runId, stagedResult));
          return { objectHash, stagedResult };
        });
      },
    },

    store: {
      async get(hash) {
        return await backend.transact(async (tx) => {
          const object = await tx.objects.get(hash);
          return object === null ? null : object.bytes;
        });
      },

      async has(hash) {
        return await backend.transact(async (tx) => await tx.objects.has(hash));
      },

      async put(blob, mediaType) {
        return await backend.transact(
          async (tx) => await putObject(tx, blob, now, mediaType)
        );
      },
    },

    thread: {
      async create(threadId, schemaId, initialBranchId) {
        return await backend.transact(async (tx) => {
          await assertThreadCreateIdsAvailable(tx, threadId, initialBranchId);
          const schema = await requireSchema(tx, schemaId);
          const rootTurnTreeHash = await createTurnTree(tx, {
            changes: createEmptyManifest(schema),
            now,
            schema,
          });
          const rootEventHash = await putObject(
            tx,
            encodeRecord({ threadId, type: "kernel_runtime_thread_bootstrap" }),
            now
          );
          const rootTurnNodeHash = await createTurnNode(tx, {
            consumedStagedResults: [],
            eventHash: rootEventHash,
            now,
            previousTurnNodeHash: null,
            schemaId,
            turnTreeHash: rootTurnTreeHash,
          });
          await tx.threads.put({
            createdAtMs: now(),
            rootTurnNodeHash,
            schemaId,
            threadId,
          });
          await tx.branches.set({
            branchId: initialBranchId,
            createdAtMs: now(),
            headTurnNodeHash: rootTurnNodeHash,
            threadId,
            updatedAtMs: now(),
          });
          return {
            branchId: initialBranchId,
            rootTurnNodeHash,
            rootTurnTreeHash,
            threadId,
          } satisfies ThreadCreateResult;
        });
      },

      async get(threadId) {
        return await backend.transact(async (tx) => {
          const thread = await tx.threads.get(threadId);
          return thread === null
            ? null
            : {
                rootTurnNodeHash: thread.rootTurnNodeHash,
                schemaId: thread.schemaId,
                threadId: thread.threadId,
              };
        });
      },

      async list(listOptions) {
        if (!backend.capabilities()["thread.enumeration"]) {
          throw new TuvrenPersistenceError(
            "thread.list is not supported by this backend",
            { code: "kernel_capability_unsupported" }
          );
        }
        return await backend.transact(async (tx) => {
          if (tx.threads.list === undefined) {
            throw new TuvrenPersistenceError(
              "backend advertises thread.enumeration but does not implement ThreadRepository.list",
              { code: "kernel_capability_unsupported" }
            );
          }
          const decodedCursor =
            listOptions?.cursor === undefined
              ? undefined
              : decodeCursor(listOptions.cursor);
          const result = await tx.threads.list({
            cursor: decodedCursor,
            filter: listOptions?.filter,
            limit: listOptions?.limit,
          });
          return {
            nextCursor:
              result.nextCursor === undefined
                ? undefined
                : encodeCursor(result.nextCursor),
            threads: result.threads,
          };
        });
      },
    },

    tree: {
      async create(schemaId, changes, baseTurnTreeHash) {
        return await backend.transact(async (tx) => {
          const schema = await requireSchema(tx, schemaId);
          validateTurnTreeChangeSet(schema, changes);

          let baseManifest: TurnTreeManifest;

          if (baseTurnTreeHash === undefined) {
            // Base-less create: all schema paths must be provided
            for (const pathDef of schema.paths) {
              if (!Object.hasOwn(changes, pathDef.path)) {
                throw new TuvrenValidationError(
                  `path "${pathDef.path}" is required when creating a tree without a base`,
                  { code: "kernel_runtime_missing_required_tree_path" }
                );
              }
            }
            baseManifest = createEmptyManifest(schema);
          } else {
            const baseTree = await requireTurnTree(tx, baseTurnTreeHash);

            if (baseTree.schemaId !== schemaId) {
              throw new TuvrenValidationError(
                `base tree schema "${baseTree.schemaId}" does not match requested schema "${schemaId}"`,
                { code: "kernel_runtime_tree_schema_mismatch" }
              );
            }

            baseManifest = await requireTreeManifest(tx, baseTurnTreeHash);
          }

          // `changes` is arbitrary caller-supplied input here (validated only
          // by validateTurnTreeChangeSet, not applyStagedResultsToManifest),
          // so it can replace an ordered path's entire array rather than
          // append to it. Deliberately do NOT thread `baseTurnTreeHash`
          // through as `priorTurnTreeHash`: the chunk-aware writer trusts
          // append-only-ness structurally, and this call site has no such
          // guarantee (contrast with `tree.incorporate` below and
          // `createIncorporatedTree`, which both build `changes` via
          // applyStagedResultsToManifest and are safe to thread).
          return await createTurnTree(tx, {
            changes: { ...baseManifest, ...changes },
            now,
            schema,
          });
        });
      },

      async diff(treeHashA, treeHashB) {
        return await backend.transact(async (tx) => {
          const treeA = await requireTurnTree(tx, treeHashA);
          const treeB = await requireTurnTree(tx, treeHashB);

          if (treeA.schemaId !== treeB.schemaId) {
            throw new TuvrenValidationError(
              `cannot diff trees with different schemas: "${treeA.schemaId}" vs "${treeB.schemaId}"`,
              { code: "kernel_runtime_tree_schema_mismatch_diff" }
            );
          }

          const left = await requireTreeManifest(tx, treeHashA);
          const right = await requireTreeManifest(tx, treeHashB);
          return Object.keys({ ...left, ...right }).filter(
            (path) =>
              JSON.stringify(left[path] ?? null) !==
              JSON.stringify(right[path] ?? null)
          );
        });
      },

      async incorporate(baseTurnTreeHash, stagedResults) {
        return await backend.transact(async (tx) => {
          const baseTree = await requireTurnTree(tx, baseTurnTreeHash);
          const schema = await requireSchema(tx, baseTree.schemaId);

          // Reject unmatched staged object types (spec Appendix B)
          validateStagedResultsHaveRules(schema, stagedResults);

          const manifest = await requireTreeManifest(tx, baseTurnTreeHash);
          applyStagedResultsToManifest(schema, manifest, stagedResults);

          return await createTurnTree(tx, {
            changes: manifest,
            now,
            priorTurnTreeHash: baseTurnTreeHash,
            schema,
          });
        });
      },

      async manifest(treeHash) {
        return await backend.transact(
          async (tx) => await requireTreeManifest(tx, treeHash)
        );
      },

      async resolve(treeHash, path) {
        return await backend.transact(async (tx) => {
          const tree = await requireTurnTree(tx, treeHash);
          const schema = await requireSchema(tx, tree.schemaId);
          const isKnownPath = schema.paths.some((p) => p.path === path);

          if (!isKnownPath) {
            throw new TuvrenValidationError(
              `unknown path "${path}" in schema "${tree.schemaId}"`,
              { code: "kernel_runtime_unknown_tree_path" }
            );
          }

          const manifest = await requireTreeManifest(tx, treeHash);
          return manifest[path] ?? null;
        });
      },
    },

    turn: {
      async create(
        turnId,
        threadId,
        branchId,
        parentTurnId,
        startTurnNodeHash
      ) {
        return await backend.transact(async (tx) => {
          await assertTurnIdAvailable(tx, turnId);
          const thread = await requireThread(tx, threadId);
          const branch = await requireBranch(tx, branchId);

          if (branch.threadId !== threadId) {
            throw new TuvrenRuntimeError(
              "turn branch must belong to the requested thread",
              { code: "kernel_runtime_turn_thread_mismatch" }
            );
          }

          await requireThreadTurnNode(tx, startTurnNodeHash, thread);
          await validateTurnParent(
            tx,
            threadId,
            branchId,
            parentTurnId ?? null,
            startTurnNodeHash
          );

          const record: StoredTurn = {
            branchId,
            createdAtMs: now(),
            headTurnNodeHash: startTurnNodeHash,
            parentTurnId: parentTurnId ?? null,
            startTurnNodeHash,
            threadId,
            turnId,
            updatedAtMs: now(),
          };
          await tx.turns.set(record);
          return toTurnRecord(record);
        });
      },

      async get(turnId) {
        return await backend.transact(async (tx) => {
          const turn = await tx.turns.get(turnId);
          return turn === null ? null : toTurnRecord(turn);
        });
      },

      async updateHead(turnId, headTurnNodeHash) {
        await backend.transact(async (tx) => {
          const turn = await requireStoredTurn(tx, turnId);
          const thread = await requireThread(tx, turn.threadId);
          await requireThreadTurnNode(tx, headTurnNodeHash, thread);

          if (
            !(await turnNodeDescendsFrom(
              tx,
              headTurnNodeHash,
              turn.startTurnNodeHash
            ))
          ) {
            throw new TuvrenLineageError(
              `turn head "${headTurnNodeHash}" does not descend from start node "${turn.startTurnNodeHash}"`,
              { code: "kernel_runtime_turn_head_lineage_mismatch" }
            );
          }

          await assertTurnHeadRewritePreservesDependents(
            tx,
            toTurnRecord(turn),
            headTurnNodeHash
          );

          await tx.turns.set({
            ...turn,
            headTurnNodeHash,
            updatedAtMs: now(),
          });
        });
      },
    },

    verdicts: {
      async compose(verdicts) {
        const abort = verdicts.find((verdict) => verdict.kind === "abort");
        if (abort !== undefined) {
          return abort;
        }

        const pause = verdicts.find((verdict) => verdict.kind === "pause");
        if (pause !== undefined) {
          return pause;
        }

        const modify = composeModifyVerdict(verdicts);
        if (modify !== undefined) {
          return modify;
        }

        return await Promise.resolve(
          verdicts.find((verdict) => verdict.kind === "retry") ?? {
            kind: "proceed",
          }
        );
      },
    },
  };
};
