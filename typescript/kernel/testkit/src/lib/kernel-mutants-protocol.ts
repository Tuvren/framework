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

import type { KernelRecord } from "@tuvren/core";
import type { RuntimeBackend } from "@tuvren/kernel-protocol";

import { readErrorCode } from "./kernel-mutant-backend.js";
import type {
  KernelMutantActivate,
  KernelMutantCodec,
  KernelMutantDefinition,
  KernelMutantKernel,
} from "./kernel-mutant-types.js";

const CBOR_UNSIGNED_ONE_BYTE_HEAD = 0x18;
const CBOR_SMALLEST_ONE_BYTE_ARGUMENT = 24;

// Accepts exactly one noncanonical encoding: a top-level unsigned integer
// whose one-byte argument head carries a value that fits in the initial byte.
const minimizeUnsignedHead = (bytes: Uint8Array): Uint8Array | undefined => {
  const [head, value] = bytes;
  return head === CBOR_UNSIGNED_ONE_BYTE_HEAD &&
    value !== undefined &&
    value < CBOR_SMALLEST_ONE_BYTE_ARGUMENT
    ? Uint8Array.of(value, ...bytes.subarray(2))
    : undefined;
};

const acceptNoncanonicalCbor = (
  codec: KernelMutantCodec,
  activate: KernelMutantActivate
): KernelMutantCodec => ({
  ...codec,
  decodeDeterministicKernelRecord(bytes): KernelRecord {
    try {
      return codec.decodeDeterministicKernelRecord(bytes);
    } catch (error: unknown) {
      const minimal = minimizeUnsignedHead(bytes);
      if (minimal === undefined) {
        throw error;
      }
      const decoded = codec.decodeDeterministicKernelRecord(minimal);
      activate();
      return decoded;
    }
  },
});

const wrongOpaqueObjectHash = (
  codec: KernelMutantCodec,
  activate: KernelMutantActivate
): KernelMutantCodec => ({
  ...codec,
  async hashOpaqueObjectBytes(bytes) {
    activate();
    return await codec.hashOpaqueObjectBytes(Uint8Array.of(...bytes, 0));
  },
});

const noncanonicalChangedPathsOrder = (
  kernel: KernelMutantKernel,
  activate: KernelMutantActivate
): KernelMutantKernel => ({
  ...kernel,
  tree: {
    ...kernel.tree,
    async diff(treeHashA, treeHashB) {
      const changedPaths = await kernel.tree.diff(treeHashA, treeHashB);
      if (changedPaths.length < 2) {
        return changedPaths;
      }
      activate();
      return changedPaths.toReversed();
    },
  },
});

const dropUncommittedStagedResultOnRecovery = (
  kernel: KernelMutantKernel,
  activate: KernelMutantActivate
): KernelMutantKernel => ({
  ...kernel,
  run: {
    ...kernel.run,
    async recover(runId) {
      const recovery = await kernel.run.recover(runId);
      if (recovery.uncommittedStagedResults.length === 0) {
        return recovery;
      }
      activate();
      return {
        ...recovery,
        uncommittedStagedResults: recovery.uncommittedStagedResults.slice(
          0,
          -1
        ),
      };
    },
  },
});

const LEASE_HORIZON_MS = Number.MAX_SAFE_INTEGER;

// Expiry is judged at a clock past every lease, so a live lease can be listed
// as expired and taken over. Effective only where the kernel uses the caller's
// clock (no shared-lease-clock backend), which is every memory backend.
const leaseTakeoverBeforeExpiry = (
  kernel: KernelMutantKernel,
  activate: KernelMutantActivate
): KernelMutantKernel => ({
  ...kernel,
  runLiveness: {
    ...kernel.runLiveness,
    async listExpired(nowMs) {
      const expired = await kernel.runLiveness.listExpired(nowMs);
      const listed = await kernel.runLiveness.listExpired(LEASE_HORIZON_MS);
      if (listed.length > expired.length) {
        activate();
      }
      return listed;
    },
    async preemptExpired(runId, preemptingOwnerId, nowMs, reason) {
      try {
        return await kernel.runLiveness.preemptExpired(
          runId,
          preemptingOwnerId,
          nowMs,
          reason
        );
      } catch (error: unknown) {
        if (readErrorCode(error) !== "kernel_runtime_run_lease_not_expired") {
          throw error;
        }
        activate();
        return await kernel.runLiveness.preemptExpired(
          runId,
          preemptingOwnerId,
          LEASE_HORIZON_MS,
          reason
        );
      }
    },
  },
});

const FENCING_FAILURES = new Set([
  "run_lease_owner_mismatch",
  "run_lease_token_mismatch",
]);

// Fencing is not enforced: a superseded owner or token renews by borrowing
// the current owner/token pair from storage.
const acceptStaleOwnerAfterTakeover = (
  kernel: KernelMutantKernel,
  backend: RuntimeBackend,
  activate: KernelMutantActivate
): KernelMutantKernel => ({
  ...kernel,
  runLiveness: {
    ...kernel.runLiveness,
    async renewLease(
      runId,
      executionOwnerId,
      fencingToken,
      nextLeaseExpiresAtMs
    ) {
      try {
        return await kernel.runLiveness.renewLease(
          runId,
          executionOwnerId,
          fencingToken,
          nextLeaseExpiresAtMs
        );
      } catch (error: unknown) {
        const stored = FENCING_FAILURES.has(readErrorCode(error) ?? "")
          ? await backend.transact(async (tx) => await tx.runs.get(runId))
          : null;
        if (
          stored?.executionOwnerId === undefined ||
          stored.fencingToken === undefined
        ) {
          throw error;
        }
        activate();
        return await kernel.runLiveness.renewLease(
          runId,
          stored.executionOwnerId,
          stored.fencingToken,
          nextLeaseExpiresAtMs
        );
      }
    },
  },
});

export const PROTOCOL_KERNEL_MUTANTS: readonly KernelMutantDefinition[] = [
  {
    createSeams: () => ({ codec: acceptNoncanonicalCbor }),
    kind: "implementation",
    mutantId: "kernel.accept-noncanonical-cbor",
    signal: "mutant.accept-noncanonical-cbor.entered",
  },
  {
    createSeams: () => ({ kernel: acceptStaleOwnerAfterTakeover }),
    kind: "implementation",
    mutantId: "kernel.accept-stale-owner-after-takeover",
    signal: "mutant.accept-stale-owner-after-takeover.entered",
  },
  {
    createSeams: () => ({
      kernel: (kernel, _backend, activate) =>
        dropUncommittedStagedResultOnRecovery(kernel, activate),
    }),
    kind: "implementation",
    mutantId: "kernel.drop-uncommitted-staged-result-on-recovery",
    signal: "mutant.drop-uncommitted-staged-result-on-recovery.entered",
  },
  {
    createSeams: () => ({
      kernel: (kernel, _backend, activate) =>
        leaseTakeoverBeforeExpiry(kernel, activate),
    }),
    kind: "implementation",
    mutantId: "kernel.lease-takeover-before-expiry",
    signal: "mutant.lease-takeover-before-expiry.entered",
  },
  {
    createSeams: () => ({
      kernel: (kernel, _backend, activate) =>
        noncanonicalChangedPathsOrder(kernel, activate),
    }),
    kind: "implementation",
    mutantId: "kernel.noncanonical-changed-paths-order",
    signal: "mutant.noncanonical-changed-paths-order.entered",
  },
  {
    createSeams: () => ({
      codec: wrongOpaqueObjectHash,
      kernel: (kernel, _backend, activate) => ({
        ...kernel,
        store: {
          ...kernel.store,
          async put(bytes, mediaType) {
            activate();
            return await kernel.store.put(
              Uint8Array.of(...bytes, 0),
              mediaType
            );
          },
        },
      }),
    }),
    kind: "implementation",
    mutantId: "kernel.wrong-opaque-object-hash",
    signal: "mutant.wrong-opaque-object-hash.entered",
  },
];
