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

import type { HashString } from "@tuvren/core";
import type {
  BranchHeadListEntry,
  PathValue,
} from "@tuvren/kernel-protocol";

import type {
  KernelMutantActivate,
  KernelMutantDefinition,
  KernelMutantKernel,
} from "./kernel-mutant-types.js";

// Flips the first hex nibble: always changes the digest, stays inside the
// 64-hex shape, and is injective so distinct hashes stay distinct.
const perturbedHash = (hash: HashString): HashString =>
  `${(Number.parseInt(hash[0] ?? "0", 16) ^ 1).toString(16)}${hash.slice(1)}`;

const perturbedManifestValue = (value: PathValue): PathValue =>
  value === null
    ? null
    : Array.isArray(value)
      ? value.map(perturbedHash)
      : perturbedHash(value);

// branch.list reports every entry's head with a perturbed digest, the way an
// enumeration that reads a stale head column would.
const corruptBranchHeadList = (
  kernel: KernelMutantKernel,
  activate: KernelMutantActivate
): KernelMutantKernel => ({
  ...kernel,
  branch: {
    ...kernel.branch,
    async list(threadId) {
      const entries = await kernel.branch.list(threadId);
      if (entries.length === 0) {
        return entries;
      }
      activate();
      return entries.map(
        ([branchId, headTurnNodeHash]): BranchHeadListEntry => [
          branchId,
          perturbedHash(headTurnNodeHash),
        ]
      );
    },
  },
});

// node.walkBack yields each non-root node with its previousTurnNodeHash link
// rewritten, so the walked chain no longer proves the recorded lineage and
// each yielded record disagrees with its own identity hash.
const corruptNodeWalkLineage = (
  kernel: KernelMutantKernel,
  activate: KernelMutantActivate
): KernelMutantKernel => ({
  ...kernel,
  node: {
    ...kernel.node,
    async *walkBack(fromHash) {
      for await (const node of kernel.node.walkBack(fromHash)) {
        if (node.previousTurnNodeHash === null) {
          yield node;
        } else {
          activate();
          yield {
            ...node,
            previousTurnNodeHash: perturbedHash(node.previousTurnNodeHash),
          };
        }
      }
    },
  },
});

// tree.manifest hands back the stored manifest with every hash value
// rewritten, so the returned manifest no longer matches the tree's recorded
// content.
const corruptTreeManifest = (
  kernel: KernelMutantKernel,
  activate: KernelMutantActivate
): KernelMutantKernel => ({
  ...kernel,
  tree: {
    ...kernel.tree,
    async manifest(treeHash) {
      const manifest = await kernel.tree.manifest(treeHash);
      activate();
      return Object.fromEntries(
        Object.entries(manifest).map(([path, value]) => [
          path,
          perturbedManifestValue(value),
        ])
      );
    },
  },
});

// schema.get returns the registered record with its paths array reversed, so
// the record the caller sees encodes to different canonical bytes than the
// registered one.
const disorderSchemaPaths = (
  kernel: KernelMutantKernel,
  activate: KernelMutantActivate
): KernelMutantKernel => ({
  ...kernel,
  schema: {
    ...kernel.schema,
    async get(schemaId) {
      const schema = await kernel.schema.get(schemaId);
      if (schema === null || schema.paths.length < 2) {
        return schema;
      }
      activate();
      return { ...schema, paths: schema.paths.toReversed() };
    },
  },
});

// thread.list drops the caller's cursor, handing a paginated caller the first
// page again.
const ignoreThreadListCursor = (
  kernel: KernelMutantKernel,
  activate: KernelMutantActivate
): KernelMutantKernel => ({
  ...kernel,
  thread: {
    ...kernel.thread,
    async list(options) {
      if (options?.cursor === undefined) {
        return await kernel.thread.list(options);
      }
      activate();
      return await kernel.thread.list({ ...options, cursor: undefined });
    },
  },
});

// verdicts.compose collects multiple modify transforms in reverse
// registration order instead of registration order.
const reverseModifyTransformOrder = (
  kernel: KernelMutantKernel,
  activate: KernelMutantActivate
): KernelMutantKernel => ({
  ...kernel,
  verdicts: {
    ...kernel.verdicts,
    async compose(verdicts) {
      const composed = await kernel.verdicts.compose(verdicts);
      if (composed.kind !== "modify" || !Array.isArray(composed.transform)) {
        return composed;
      }
      activate();
      return { ...composed, transform: composed.transform.toReversed() };
    },
  },
});

export const LOGICAL_KERNEL_MUTANTS: readonly KernelMutantDefinition[] = [
  {
    createSeams: () => ({
      kernel: (kernel, _backend, activate) =>
        corruptBranchHeadList(kernel, activate),
    }),
    kind: "implementation",
    mutantId: "kernel.corrupt-branch-head-list",
    signal: "mutant.corrupt-branch-head-list.entered",
  },
  {
    createSeams: () => ({
      kernel: (kernel, _backend, activate) =>
        corruptNodeWalkLineage(kernel, activate),
    }),
    kind: "implementation",
    mutantId: "kernel.corrupt-node-walk-lineage",
    signal: "mutant.corrupt-node-walk-lineage.entered",
  },
  {
    createSeams: () => ({
      kernel: (kernel, _backend, activate) =>
        corruptTreeManifest(kernel, activate),
    }),
    kind: "implementation",
    mutantId: "kernel.corrupt-tree-manifest",
    signal: "mutant.corrupt-tree-manifest.entered",
  },
  {
    createSeams: () => ({
      kernel: (kernel, _backend, activate) =>
        disorderSchemaPaths(kernel, activate),
    }),
    kind: "implementation",
    mutantId: "kernel.disorder-schema-paths",
    signal: "mutant.disorder-schema-paths.entered",
  },
  {
    createSeams: () => ({
      kernel: (kernel, _backend, activate) =>
        ignoreThreadListCursor(kernel, activate),
    }),
    kind: "implementation",
    mutantId: "kernel.ignore-thread-list-cursor",
    signal: "mutant.ignore-thread-list-cursor.entered",
  },
  {
    createSeams: () => ({
      kernel: (kernel, _backend, activate) =>
        reverseModifyTransformOrder(kernel, activate),
    }),
    kind: "implementation",
    mutantId: "kernel.reverse-modify-transform-order",
    signal: "mutant.reverse-modify-transform-order.entered",
  },
];
