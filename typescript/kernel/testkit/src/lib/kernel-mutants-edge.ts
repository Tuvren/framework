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

import {
  assertHashString,
  TuvrenRuntimeError,
  TuvrenValidationError,
} from "@tuvren/core";
import type { EpochMs, HashString, KernelRecord } from "@tuvren/core";
import {
  assertPathValueForCollectionKind,
  assertStepDeclaration,
  assertTurnTreeSchema,
  decodeDeterministicKernelRecord,
  encodeDeterministicKernelRecord,
  hashTurnTreeIdentity,
} from "@tuvren/kernel-protocol";
import type {
  PathValue,
  RunRecord,
  RuntimeBackend,
  RuntimeBackendTx,
  StepDeclaration,
  StoredRun,
  StoredTurnTreePath,
  TurnTreeManifest,
  TurnTreeSchema,
} from "@tuvren/kernel-protocol";

import { readErrorCode } from "./kernel-mutant-backend.js";
import type {
  KernelMutantActivate,
  KernelMutantDefinition,
  KernelMutantKernel,
} from "./kernel-mutant-types.js";

// Every edge-validation mutant shares one shape: run the real kernel call,
// and only when it rejects with the code the rule requires does the mutant
// activate and replay the operation's success path with that guard skipped —
// the forbidden operation is what actually happens. The bypass either reaches
// committed state through the backend (which may enforce its own copy of the
// invariant and reject with its native code) or drives the real kernel with
// the guarded input removed; it never fakes a result.
const acceptOnRejection = async <T>(
  rejected: string,
  activate: KernelMutantActivate,
  call: () => Promise<T>,
  bypass: (error: unknown) => Promise<T>
): Promise<T> => {
  try {
    return await call();
  } catch (error: unknown) {
    if (readErrorCode(error) !== rejected) {
      throw error;
    }
    activate();
    return await bypass(error);
  }
};

const txNow = (tx: RuntimeBackendTx): EpochMs => tx.now?.() ?? Date.now();

// The runtime's single CBOR write path (encodeRecord over toKernelRecord); the
// bypassed writes only ever carry already-validated kernel-record data.
const encodeRecord = (value: unknown): Uint8Array =>
  encodeDeterministicKernelRecord(value as KernelRecord);

const decodeKernelRecord = (
  bytes: Uint8Array,
  label: string
): KernelRecord => {
  const decoded = decodeDeterministicKernelRecord(bytes);
  if (decoded === undefined) {
    throw new TuvrenRuntimeError(`${label} could not be decoded`, {
      code: "kernel_runtime_invalid_record",
    });
  }
  return decoded;
};

const decodeRecordArray = (
  bytes: Uint8Array,
  label: string
): KernelRecord[] => {
  const decoded = decodeKernelRecord(bytes, label);
  if (!Array.isArray(decoded)) {
    throw new TuvrenRuntimeError(`${label} must decode to an array`, {
      code: "kernel_runtime_invalid_record",
    });
  }
  return decoded;
};

const decodeHashArray = (bytes: Uint8Array): HashString[] => {
  const decoded = decodeRecordArray(bytes, "hash array");
  const hashes: HashString[] = [];
  for (const item of decoded) {
    assertHashString(item, "hash array item");
    hashes.push(item);
  }
  return hashes;
};

const decodeSteps = (bytes: Uint8Array): StepDeclaration[] => {
  const decoded = decodeRecordArray(bytes, "run steps");
  const steps: StepDeclaration[] = [];
  for (const step of decoded) {
    assertStepDeclaration(step, "run step");
    steps.push(step);
  }
  return steps;
};

const decodeSchema = (bytes: Uint8Array): TurnTreeSchema => {
  const decoded = decodeKernelRecord(bytes, "schema");
  assertTurnTreeSchema(decoded, "schema");
  return decoded;
};

const decodeManifest = (bytes: Uint8Array): TurnTreeManifest => {
  const decoded = decodeKernelRecord(bytes, "turn tree manifest");
  if (
    decoded === null ||
    typeof decoded !== "object" ||
    Array.isArray(decoded)
  ) {
    throw new TuvrenRuntimeError(
      "turn tree manifest must decode to an object",
      { code: "kernel_runtime_invalid_record" }
    );
  }
  const manifest: TurnTreeManifest = {};
  for (const [path, value] of Object.entries(decoded)) {
    if (value === null) {
      manifest[path] = null;
    } else if (typeof value === "string") {
      assertHashString(value, `manifest.${path}`);
      manifest[path] = value;
    } else if (Array.isArray(value)) {
      const hashes: HashString[] = [];
      for (const item of value) {
        assertHashString(item, `manifest.${path}[]`);
        hashes.push(item);
      }
      manifest[path] = hashes;
    } else {
      throw new TuvrenRuntimeError(
        `turn tree manifest path "${path}" has invalid value`,
        { code: "kernel_runtime_invalid_record" }
      );
    }
  }
  return manifest;
};

const decodeStoredRun = (record: StoredRun): RunRecord => ({
  branchId: record.branchId,
  createdTurnNodes: decodeHashArray(record.createdTurnNodesCbor),
  currentStepIndex: record.currentStepIndex,
  ...(record.executionOwnerId === undefined
    ? {}
    : { executionOwnerId: record.executionOwnerId }),
  ...(record.fencingToken === undefined
    ? {}
    : { fencingToken: record.fencingToken }),
  ...(record.leaseExpiresAtMs === undefined
    ? {}
    : { leaseExpiresAtMs: record.leaseExpiresAtMs }),
  ...(record.preemptionReason === undefined
    ? {}
    : { preemptionReason: record.preemptionReason }),
  runId: record.runId,
  schemaId: record.schemaId,
  startTurnNodeHash: record.startTurnNodeHash,
  status: record.status,
  stepSequence: decodeSteps(record.stepSequenceCbor),
  turnId: record.turnId,
});

const toStoredTurnTreePath = (
  turnTreeHash: HashString,
  collectionKind: "ordered" | "single",
  path: string,
  value: PathValue
): StoredTurnTreePath => {
  if (collectionKind === "ordered") {
    const items = Array.isArray(value) ? value : [];
    return {
      collectionKind,
      orderedCount: items.length,
      orderedEncoding: "flat",
      orderedInlineCbor: encodeRecord(items),
      path,
      turnTreeHash,
    };
  }
  return {
    collectionKind,
    path,
    singleHash: typeof value === "string" ? value : null,
    turnTreeHash,
  };
};

const utf8 = new TextEncoder();

// tree.diff orders changed paths by ascending unsigned UTF-8 bytes (ADR-0080).
const compareUtf8Bytes = (left: string, right: string): number => {
  const leftBytes = utf8.encode(left);
  const rightBytes = utf8.encode(right);
  const shared = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < shared; index += 1) {
    if (leftBytes[index] !== rightBytes[index]) {
      return (leftBytes[index] ?? 0) - (rightBytes[index] ?? 0);
    }
  }
  return leftBytes.length - rightBytes.length;
};

// schema.register accepts a schema whose paths contain a duplicate the way an
// implementation that indexes paths by name would: the last definition wins
// and the call completes through the real registration path. A byte-identical
// commit is impossible — `tx.schemas.put` re-validates the decoded schema and
// would rethrow the same code — so the guarded input is what changes.
const acceptDuplicatePath = (
  kernel: KernelMutantKernel,
  activate: KernelMutantActivate
): KernelMutantKernel => ({
  ...kernel,
  schema: {
    ...kernel.schema,
    async register(schema) {
      return await acceptOnRejection(
        "duplicate_schema_path",
        activate,
        async () => await kernel.schema.register(schema),
        async () =>
          await kernel.schema.register({
            ...schema,
            paths: [
              ...new Map(
                schema.paths.map((definition) => [
                  definition.path,
                  definition,
                ])
              ).values(),
            ],
          })
      );
    },
  },
});

// tree.create without a base builds the tree on the schema's empty manifest
// instead of requiring every path in `changes`.
const acceptMissingRequiredPath = (
  kernel: KernelMutantKernel,
  backend: RuntimeBackend,
  activate: KernelMutantActivate
): KernelMutantKernel => ({
  ...kernel,
  tree: {
    ...kernel.tree,
    async create(schemaId, changes, baseTurnTreeHash) {
      return await acceptOnRejection(
        "kernel_runtime_missing_required_tree_path",
        activate,
        async () =>
          await kernel.tree.create(schemaId, changes, baseTurnTreeHash),
        async (error) =>
          await backend.transact(async (tx) => {
            const storedSchema = await tx.schemas.get(schemaId);
            if (storedSchema === null) {
              throw error;
            }
            const schema = decodeSchema(storedSchema.schemaCbor);
            const pathsByName = new Map(
              schema.paths.map((definition) => [definition.path, definition])
            );
            const manifest: TurnTreeManifest = {};
            for (const definition of schema.paths) {
              manifest[definition.path] =
                definition.collection === "ordered" ? [] : null;
            }
            for (const [path, value] of Object.entries(changes)) {
              const definition = pathsByName.get(path);
              if (definition === undefined) {
                throw new TuvrenValidationError(
                  `unknown path "${path}" in schema "${schema.schemaId}"`,
                  { code: "kernel_runtime_unknown_tree_path" }
                );
              }
              assertPathValueForCollectionKind(
                value,
                definition.collection,
                `changes.${path}`
              );
              manifest[path] = value;
            }
            const hash = await hashTurnTreeIdentity(
              schema.schemaId,
              manifest,
              schema
            );
            if ((await tx.turnTrees.get(hash)) === null) {
              await tx.turnTrees.put({
                createdAtMs: txNow(tx),
                hash,
                manifestCbor: encodeRecord(manifest),
                schemaId: schema.schemaId,
              });
              await tx.turnTreePaths.putMany(
                schema.paths.map((definition) =>
                  toStoredTurnTreePath(
                    hash,
                    definition.collection,
                    definition.path,
                    manifest[definition.path]
                  )
                )
              );
            }
            return hash;
          })
      );
    },
  },
});

// tree.diff compares manifests across a schema boundary.
const acceptCrossSchemaDiff = (
  kernel: KernelMutantKernel,
  backend: RuntimeBackend,
  activate: KernelMutantActivate
): KernelMutantKernel => ({
  ...kernel,
  tree: {
    ...kernel.tree,
    async diff(treeHashA, treeHashB) {
      return await acceptOnRejection(
        "kernel_runtime_tree_schema_mismatch_diff",
        activate,
        async () => await kernel.tree.diff(treeHashA, treeHashB),
        async (error) =>
          await backend.transact(async (tx) => {
            const treeA = await tx.turnTrees.get(treeHashA);
            const treeB = await tx.turnTrees.get(treeHashB);
            if (treeA === null || treeB === null) {
              throw error;
            }
            const left = decodeManifest(treeA.manifestCbor);
            const right = decodeManifest(treeB.manifestCbor);
            return Object.keys({ ...left, ...right })
              .filter(
                (path) =>
                  JSON.stringify(left[path] ?? null) !==
                  JSON.stringify(right[path] ?? null)
              )
              .toSorted(compareUtf8Bytes);
          })
      );
    },
  },
});

// run.beginStep begins any declared step, not only the current one.
const acceptOutOfOrderStep = (
  kernel: KernelMutantKernel,
  backend: RuntimeBackend,
  activate: KernelMutantActivate
): KernelMutantKernel => ({
  ...kernel,
  run: {
    ...kernel.run,
    async beginStep(runId, stepId) {
      return await acceptOnRejection(
        "kernel_runtime_unexpected_step",
        activate,
        async () => await kernel.run.beginStep(runId, stepId),
        async (error) =>
          await backend.transact(async (tx) => {
            const storedRun = await tx.runs.get(runId);
            if (storedRun === null) {
              throw error;
            }
            const run = decodeStoredRun(storedRun);
            const step = run.stepSequence.find(
              (candidate) => candidate.id === stepId
            );
            if (step === undefined) {
              throw error;
            }
            const branch = await tx.branches.get(run.branchId);
            const storedSchema = await tx.schemas.get(run.schemaId);
            if (branch === null || storedSchema === null) {
              throw error;
            }
            return {
              currentTurnNodeHash: branch.headTurnNodeHash,
              schema: decodeSchema(storedSchema.schemaCbor),
              signals:
                storedRun.pendingSignalsCbor === undefined
                  ? []
                  : decodeRecordArray(
                      storedRun.pendingSignalsCbor,
                      "pending signals"
                    ),
              step,
            };
          })
      );
    },
  },
});

// run.completeStep completes the step without anchoring the absent event
// object, the way an implementation that treats the event hash as optional
// would.
const acceptAbsentEventObject = (
  kernel: KernelMutantKernel,
  activate: KernelMutantActivate
): KernelMutantKernel => ({
  ...kernel,
  run: {
    ...kernel.run,
    async completeStep(runId, stepId, eventHash, observeResults, treeHash) {
      return await acceptOnRejection(
        "kernel_runtime_missing_event_object",
        activate,
        async () =>
          await kernel.run.completeStep(
            runId,
            stepId,
            eventHash,
            observeResults,
            treeHash
          ),
        async () =>
          await kernel.run.completeStep(
            runId,
            stepId,
            undefined,
            observeResults,
            treeHash
          )
      );
    },
  },
});

export const EDGE_KERNEL_MUTANTS: readonly KernelMutantDefinition[] = [
  {
    createSeams: () => ({
      kernel: (kernel, backend, activate) =>
        acceptCrossSchemaDiff(kernel, backend, activate),
    }),
    kind: "implementation",
    mutantId: "kernel.misreport-diff-schema-rejection",
    signal: "mutant.misreport-diff-schema-rejection.entered",
  },
  {
    createSeams: () => ({
      kernel: (kernel, _backend, activate) =>
        acceptDuplicatePath(kernel, activate),
    }),
    kind: "implementation",
    mutantId: "kernel.misreport-duplicate-path-rejection",
    signal: "mutant.misreport-duplicate-path-rejection.entered",
  },
  {
    createSeams: () => ({
      kernel: (kernel, _backend, activate) =>
        acceptAbsentEventObject(kernel, activate),
    }),
    kind: "implementation",
    mutantId: "kernel.misreport-event-object-rejection",
    signal: "mutant.misreport-event-object-rejection.entered",
  },
  {
    createSeams: () => ({
      kernel: (kernel, backend, activate) =>
        acceptMissingRequiredPath(kernel, backend, activate),
    }),
    kind: "implementation",
    mutantId: "kernel.misreport-required-path-rejection",
    signal: "mutant.misreport-required-path-rejection.entered",
  },
  {
    createSeams: () => ({
      kernel: (kernel, backend, activate) =>
        acceptOutOfOrderStep(kernel, backend, activate),
    }),
    kind: "implementation",
    mutantId: "kernel.misreport-step-order-rejection",
    signal: "mutant.misreport-step-order-rejection.entered",
  },
];
