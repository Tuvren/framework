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

import type {
  StoredTurnTree,
  StoredTurnTreePath,
} from "@tuvren/kernel-protocol";
import { createCanonicalTurnTreePaths as createSharedCanonicalTurnTreePaths } from "@tuvren/kernel-testkit";

/** Returns a rejected Error so assertions run after the operation settles. */
export const rejectionOf = async (
  operation: Promise<unknown>
): Promise<Error> => {
  try {
    await operation;
  } catch (error: unknown) {
    if (error instanceof Error) {
      return error;
    }
    throw new Error("Expected the operation to reject with an Error", {
      cause: error,
    });
  }
  throw new Error("Expected the operation to reject");
};

export const createCanonicalTurnTreePaths = (
  turnTree: StoredTurnTree,
  messages: string[]
): StoredTurnTreePath[] =>
  createSharedCanonicalTurnTreePaths(turnTree, {
    "context.manifest": null,
    messages,
  });
