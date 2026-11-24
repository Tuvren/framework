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

import { TuvrenRuntimeError } from "@tuvren/core";

import { readErrorCode } from "./kernel-mutant-backend.js";
import type {
  KernelMutantActivate,
  KernelMutantDefinition,
  KernelMutantKernel,
} from "./kernel-mutant-types.js";

// A rule's rejection still fires, but the adapter envelope carries a sibling
// verdict's code, the way an implementation whose error mapping conflates two
// validations would. The swallowed error stays attached as the cause.
const remapRejectionCode = async <T>(
  rejected: string,
  reported: string,
  activate: KernelMutantActivate,
  call: () => Promise<T>
): Promise<T> => {
  try {
    return await call();
  } catch (error: unknown) {
    if (readErrorCode(error) !== rejected) {
      throw error;
    }
    activate();
    throw new TuvrenRuntimeError(
      error instanceof Error ? error.message : String(error),
      { cause: error, code: reported }
    );
  }
};

// schema.register reports a duplicate path as a schema-id conflict.
const misreportDuplicatePath = (
  kernel: KernelMutantKernel,
  activate: KernelMutantActivate
): KernelMutantKernel => ({
  ...kernel,
  schema: {
    ...kernel.schema,
    async register(schema) {
      return await remapRejectionCode(
        "duplicate_schema_path",
        "kernel_runtime_duplicate_schema",
        activate,
        async () => await kernel.schema.register(schema)
      );
    },
  },
});

// tree.create reports a missing required path as an unknown schema path.
const misreportRequiredPath = (
  kernel: KernelMutantKernel,
  activate: KernelMutantActivate
): KernelMutantKernel => ({
  ...kernel,
  tree: {
    ...kernel.tree,
    async create(schemaId, changes, baseTurnTreeHash) {
      return await remapRejectionCode(
        "kernel_runtime_missing_required_tree_path",
        "kernel_runtime_unknown_tree_path",
        activate,
        async () =>
          await kernel.tree.create(schemaId, changes, baseTurnTreeHash)
      );
    },
  },
});

// tree.diff reports a cross-schema pair as a base-tree schema mismatch.
const misreportDiffSchema = (
  kernel: KernelMutantKernel,
  activate: KernelMutantActivate
): KernelMutantKernel => ({
  ...kernel,
  tree: {
    ...kernel.tree,
    async diff(treeHashA, treeHashB) {
      return await remapRejectionCode(
        "kernel_runtime_tree_schema_mismatch_diff",
        "kernel_runtime_tree_schema_mismatch",
        activate,
        async () => await kernel.tree.diff(treeHashA, treeHashB)
      );
    },
  },
});

// run.create reports a busy branch as a run-id conflict.
const misreportBusyBranch = (
  kernel: KernelMutantKernel,
  activate: KernelMutantActivate
): KernelMutantKernel => ({
  ...kernel,
  run: {
    ...kernel.run,
    async create(runId, turnId, branchId, schemaId, startTurnNodeHash, steps) {
      return await remapRejectionCode(
        "kernel_runtime_branch_already_active",
        "kernel_runtime_run_exists",
        activate,
        async () =>
          await kernel.run.create(
            runId,
            turnId,
            branchId,
            schemaId,
            startTurnNodeHash,
            steps
          )
      );
    },
  },
});

// run.beginStep reports an out-of-order step as a dead run.
const misreportStepOrder = (
  kernel: KernelMutantKernel,
  activate: KernelMutantActivate
): KernelMutantKernel => ({
  ...kernel,
  run: {
    ...kernel.run,
    async beginStep(runId, stepId) {
      return await remapRejectionCode(
        "kernel_runtime_unexpected_step",
        "kernel_runtime_run_not_running",
        activate,
        async () => await kernel.run.beginStep(runId, stepId)
      );
    },
  },
});

// run.completeStep reports a missing event object as a step-order violation.
const misreportEventObject = (
  kernel: KernelMutantKernel,
  activate: KernelMutantActivate
): KernelMutantKernel => ({
  ...kernel,
  run: {
    ...kernel.run,
    async completeStep(runId, stepId, eventHash, observeResults, treeHash) {
      return await remapRejectionCode(
        "kernel_runtime_missing_event_object",
        "kernel_runtime_unexpected_step",
        activate,
        async () =>
          await kernel.run.completeStep(
            runId,
            stepId,
            eventHash,
            observeResults,
            treeHash
          )
      );
    },
  },
});

// branch.setHead reports a lateral move as a cross-thread containment error.
const misreportLateralHead = (
  kernel: KernelMutantKernel,
  activate: KernelMutantActivate
): KernelMutantKernel => ({
  ...kernel,
  branch: {
    ...kernel.branch,
    async setHead(branchId, turnNodeHash) {
      return await remapRejectionCode(
        "kernel_runtime_lateral_head_movement",
        "turn_node_thread_mismatch",
        activate,
        async () => await kernel.branch.setHead(branchId, turnNodeHash)
      );
    },
  },
});

// branch.create reports a cross-thread anchor as a missing turn node.
const misreportThreadMismatch = (
  kernel: KernelMutantKernel,
  activate: KernelMutantActivate
): KernelMutantKernel => ({
  ...kernel,
  branch: {
    ...kernel.branch,
    async create(branchId, threadId, fromTurnNodeHash) {
      return await remapRejectionCode(
        "turn_node_thread_mismatch",
        "kernel_runtime_missing_turn_node",
        activate,
        async () =>
          await kernel.branch.create(branchId, threadId, fromTurnNodeHash)
      );
    },
  },
});

export const EDGE_KERNEL_MUTANTS: readonly KernelMutantDefinition[] = [
  {
    createSeams: () => ({
      kernel: (kernel, _backend, activate) =>
        misreportBusyBranch(kernel, activate),
    }),
    kind: "implementation",
    mutantId: "kernel.misreport-busy-branch-rejection",
    signal: "mutant.misreport-busy-branch-rejection.entered",
  },
  {
    createSeams: () => ({
      kernel: (kernel, _backend, activate) =>
        misreportDiffSchema(kernel, activate),
    }),
    kind: "implementation",
    mutantId: "kernel.misreport-diff-schema-rejection",
    signal: "mutant.misreport-diff-schema-rejection.entered",
  },
  {
    createSeams: () => ({
      kernel: (kernel, _backend, activate) =>
        misreportDuplicatePath(kernel, activate),
    }),
    kind: "implementation",
    mutantId: "kernel.misreport-duplicate-path-rejection",
    signal: "mutant.misreport-duplicate-path-rejection.entered",
  },
  {
    createSeams: () => ({
      kernel: (kernel, _backend, activate) =>
        misreportEventObject(kernel, activate),
    }),
    kind: "implementation",
    mutantId: "kernel.misreport-event-object-rejection",
    signal: "mutant.misreport-event-object-rejection.entered",
  },
  {
    createSeams: () => ({
      kernel: (kernel, _backend, activate) =>
        misreportLateralHead(kernel, activate),
    }),
    kind: "implementation",
    mutantId: "kernel.misreport-lateral-head-rejection",
    signal: "mutant.misreport-lateral-head-rejection.entered",
  },
  {
    createSeams: () => ({
      kernel: (kernel, _backend, activate) =>
        misreportRequiredPath(kernel, activate),
    }),
    kind: "implementation",
    mutantId: "kernel.misreport-required-path-rejection",
    signal: "mutant.misreport-required-path-rejection.entered",
  },
  {
    createSeams: () => ({
      kernel: (kernel, _backend, activate) =>
        misreportStepOrder(kernel, activate),
    }),
    kind: "implementation",
    mutantId: "kernel.misreport-step-order-rejection",
    signal: "mutant.misreport-step-order-rejection.entered",
  },
  {
    createSeams: () => ({
      kernel: (kernel, _backend, activate) =>
        misreportThreadMismatch(kernel, activate),
    }),
    kind: "implementation",
    mutantId: "kernel.misreport-thread-mismatch-rejection",
    signal: "mutant.misreport-thread-mismatch-rejection.entered",
  },
];
