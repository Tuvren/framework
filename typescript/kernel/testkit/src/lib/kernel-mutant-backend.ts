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
  ListThreadsCursorPayload,
  RuntimeBackend,
  RuntimeBackendTx,
  StoredBranch,
} from "@tuvren/kernel-protocol";

export interface BackendDecoration {
  readonly reclaim?: RuntimeBackend["reclaim"];
  readonly transact?: RuntimeBackend["transact"];
}

export const readErrorCode = (error: unknown): string | undefined => {
  const code: unknown =
    typeof error === "object" && error !== null
      ? Reflect.get(error, "code")
      : undefined;
  return typeof code === "string" ? code : undefined;
};

const forwardOptionalMethod = (
  inner: RuntimeBackend,
  decorated: RuntimeBackend,
  key: "close" | "destroy"
): void => {
  const method: unknown = Reflect.get(inner, key);
  if (typeof method === "function") {
    Reflect.set(decorated, key, async (...args: unknown[]): Promise<void> => {
      await Reflect.apply(method, inner, args);
    });
  }
};

/**
 * Wraps a backend while staying faithful to everything the wrapper does not
 * mutate, including the hidden symbol-keyed fault-injection control that
 * {@link createFaultInjectingBackend} discovers by shape.
 */
export const decorateBackend = (
  inner: RuntimeBackend,
  decoration: BackendDecoration
): RuntimeBackend => {
  const reclaim = decoration.reclaim ?? inner.reclaim?.bind(inner);
  const purgeScope = inner.purgeScope?.bind(inner);
  const decorated: RuntimeBackend = {
    capabilities: () => inner.capabilities(),
    health: async () => await inner.health(),
    transact:
      decoration.transact ??
      (async <T>(work: (tx: RuntimeBackendTx) => Promise<T>) =>
        await inner.transact(work)),
    ...(reclaim === undefined ? {} : { reclaim }),
    ...(purgeScope === undefined ? {} : { purgeScope }),
  };

  forwardOptionalMethod(inner, decorated, "close");
  forwardOptionalMethod(inner, decorated, "destroy");
  for (const symbol of Object.getOwnPropertySymbols(inner)) {
    Reflect.set(decorated, symbol, Reflect.get(inner, symbol));
  }

  return decorated;
};

export const decorateTransactions = (
  inner: RuntimeBackend,
  decorateTx: (tx: RuntimeBackendTx) => RuntimeBackendTx,
  decoration: Omit<BackendDecoration, "transact"> = {}
): RuntimeBackend =>
  decorateBackend(inner, {
    ...decoration,
    transact: async <T>(work: (tx: RuntimeBackendTx) => Promise<T>) =>
      await inner.transact(async (tx) => await work(decorateTx(tx))),
  });

const listThreadBranches = async (
  tx: RuntimeBackendTx,
  threadIds: readonly string[],
  index = 0,
  branches: StoredBranch[] = []
): Promise<StoredBranch[]> => {
  const threadId = threadIds[index];
  if (threadId === undefined) {
    return branches;
  }
  branches.push(...(await tx.branches.listByThread(threadId)));
  return await listThreadBranches(tx, threadIds, index + 1, branches);
};

const listThreadIds = async (
  tx: RuntimeBackendTx,
  cursor?: ListThreadsCursorPayload,
  threadIds: string[] = []
): Promise<string[]> => {
  const page = await tx.threads.list?.(
    cursor === undefined ? undefined : { cursor }
  );
  if (page === undefined) {
    return threadIds;
  }
  threadIds.push(...page.threads.map((thread) => thread.threadId));
  return page.nextCursor === undefined
    ? threadIds
    : await listThreadIds(tx, page.nextCursor, threadIds);
};

/** Every branch in the backend's Scope, read through thread enumeration. */
export const listAllBranches = async (
  tx: RuntimeBackendTx
): Promise<StoredBranch[]> =>
  await listThreadBranches(tx, await listThreadIds(tx));
