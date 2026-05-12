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
  decodeDeterministicKernelRecord,
  type HashString,
  type RuntimeKernel,
  TuvrenRuntimeError,
  TuvrenValidationError,
} from "@tuvren/runtime";

export interface PlaygroundKernelHarness {
  kernel: RuntimeKernel;
  readBranchMessages(branchId: string): Promise<unknown[]>;
  readBranchStatus(branchId: string): Promise<unknown | null>;
}

export function createPlaygroundKernelInspector(
  kernel: RuntimeKernel
): Pick<PlaygroundKernelHarness, "readBranchMessages" | "readBranchStatus"> {
  return {
    async readBranchMessages(branchId) {
      const turnTreeHash = await readBranchTurnTreeHash(kernel, branchId);
      const messages = await resolveOptionalPath(
        kernel,
        turnTreeHash,
        "messages"
      );

      if (!Array.isArray(messages)) {
        return [];
      }

      const output: unknown[] = [];

      for (const hash of messages) {
        const bytes = await kernel.store.get(hash);

        if (bytes !== null) {
          output.push(decodeDeterministicKernelRecord(bytes));
        }
      }

      return output;
    },
    async readBranchStatus(branchId) {
      const turnTreeHash = await readBranchTurnTreeHash(kernel, branchId);
      const statusHash = await resolveOptionalPath(
        kernel,
        turnTreeHash,
        "runtime.status"
      );

      if (typeof statusHash !== "string") {
        return null;
      }

      const bytes = await kernel.store.get(statusHash);
      return bytes === null ? null : decodeDeterministicKernelRecord(bytes);
    },
  };
}

async function resolveOptionalPath(
  kernel: RuntimeKernel,
  turnTreeHash: HashString,
  path: string
): Promise<unknown | null> {
  try {
    return await kernel.tree.resolve(turnTreeHash, path);
  } catch (error: unknown) {
    if (
      error instanceof TuvrenValidationError &&
      error.code === "kernel_runtime_unknown_tree_path"
    ) {
      return null;
    }

    throw error;
  }
}

async function readBranchTurnTreeHash(
  kernel: RuntimeKernel,
  branchId: string
): Promise<HashString> {
  const branch = await kernel.branch.get(branchId);

  if (branch === null) {
    throw new TuvrenRuntimeError(`unknown branch "${branchId}"`, {
      code: "playground_kernel_missing_branch",
    });
  }

  const node = await kernel.node.get(branch.headTurnNodeHash);

  if (node === null) {
    throw new TuvrenRuntimeError(
      `unknown turn node "${branch.headTurnNodeHash}"`,
      {
        code: "playground_kernel_missing_turn_node",
      }
    );
  }

  return node.turnTreeHash;
}
