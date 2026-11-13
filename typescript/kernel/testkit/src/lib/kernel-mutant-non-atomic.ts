import type { RuntimeBackend, RuntimeBackendTx } from "@tuvren/kernel-protocol";

import { decorateBackend } from "./kernel-mutant-backend.js";
import type {
  KernelMutantActivate,
  KernelMutantDefinition,
} from "./kernel-mutant-types.js";

type RepositoryWork<T> = (tx: RuntimeBackendTx) => Promise<T>;
type Command =
  | { kind: "call"; next: Promise<Command>; run: RepositoryWork<void> }
  | { kind: "finish" }
  | { error: unknown; kind: "abort" };

const runCommands = async (
  tx: RuntimeBackendTx,
  next: Promise<Command>
): Promise<void> => {
  const command = await next;
  if (command.kind === "abort") {
    throw command.error;
  }
  if (command.kind === "call") {
    await command.run(tx);
    await runCommands(tx, command.next);
  }
};

const settleTail = async (inner: RuntimeBackend, first: Promise<Command>) => {
  try {
    await inner.transact(async (tx) => {
      await runCommands(tx, first);
    });
    return { kind: "committed" as const };
  } catch (error: unknown) {
    return { error, kind: "failed" as const };
  }
};

const transactionTail = (inner: RuntimeBackend) => {
  let inbox = Promise.withResolvers<Command>();
  const completion = settleTail(inner, inbox.promise);
  const prematureEnd = async (): Promise<never> => {
    const outcome = await completion;
    throw outcome.kind === "failed"
      ? outcome.error
      : new Error("checkpoint tail ended before its repository call");
  };
  return {
    async call<T>(work: RepositoryWork<T>): Promise<T> {
      const reply = Promise.withResolvers<T>();
      const next = Promise.withResolvers<Command>();
      inbox.resolve({
        kind: "call",
        next: next.promise,
        run: async (tx) => {
          reply.resolve(await work(tx));
        },
      });
      inbox = next;
      return await Promise.race([reply.promise, prematureEnd()]);
    },
    async finish(error?: { cause: unknown }): Promise<void> {
      inbox.resolve(
        error === undefined
          ? { kind: "finish" }
          : { error: error.cause, kind: "abort" }
      );
      const outcome = await completion;
      if (outcome.kind === "failed") {
        throw outcome.error;
      }
    },
  };
};

type RepositoryDispatcher = <T>(work: RepositoryWork<T>) => Promise<T>;

const forwardRepositories = (
  snapshot: RuntimeBackendTx,
  call: RepositoryDispatcher
): RuntimeBackendTx =>
  new Proxy(snapshot, {
    get(target, key, receiver) {
      const repository: unknown = Reflect.get(target, key, receiver);
      if (typeof repository !== "object" || repository === null) {
        return repository;
      }
      return new Proxy(repository, {
        get(repo, method) {
          const member: unknown = Reflect.get(repo, method);
          if (typeof member !== "function") {
            return member;
          }
          return async (...args: unknown[]): Promise<unknown> =>
            await call(async (tx) => {
              const live: unknown = Reflect.get(tx, key);
              if (typeof live !== "object" || live === null) {
                throw new TypeError("missing checkpoint repository");
              }
              const fn: unknown = Reflect.get(live, method);
              if (typeof fn !== "function") {
                throw new TypeError("missing checkpoint repository method");
              }
              const result: unknown = await Reflect.apply(fn, live, args);
              return result;
            });
        },
      });
    },
  });

const writePending = async (
  tx: RuntimeBackendTx,
  writes: readonly RepositoryWork<void>[],
  index = 0
): Promise<void> => {
  const write = writes[index];
  if (write === undefined) {
    return;
  }
  await write(tx);
  await writePending(tx, writes, index + 1);
};

const splitCheckpoint = async <T>(
  inner: RuntimeBackend,
  activate: KernelMutantActivate,
  disarm: () => void,
  work: RepositoryWork<T>
): Promise<T> => {
  const { clock, surface: snapshot } = await inner.transact(
    async (tx) =>
      await Promise.resolve({ clock: tx.now?.(), surface: { ...tx } })
  );
  const { now: _now, ...repositories } = snapshot;
  const pending: RepositoryWork<void>[] = [];
  let tail: ReturnType<typeof transactionTail> | undefined;
  const call: RepositoryDispatcher = async (operation) =>
    tail === undefined
      ? await inner.transact(operation)
      : await tail.call(operation);
  const buffer = async (write: RepositoryWork<void>): Promise<void> => {
    pending.push(write);
    await Promise.resolve();
  };
  const flush = async (): Promise<void> => {
    await call(async (tx) => {
      await writePending(tx, pending);
    });
    pending.length = 0;
  };
  const surface = forwardRepositories(
    { ...repositories, ...(clock === undefined ? {} : { now: () => clock }) },
    call
  );
  const buffered: RuntimeBackendTx = {
    ...surface,
    orderedPathChunks: {
      ...surface.orderedPathChunks,
      async put(record) {
        await buffer(async (tx) => {
          await tx.orderedPathChunks.put(record);
        });
      },
    },
    turnNodes: {
      ...surface.turnNodes,
      async put(node) {
        const early = tail === undefined;
        if (pending.length > 0) {
          await flush();
          if (early) {
            activate();
          }
        }
        await call(async (tx) => {
          await tx.turnNodes.put(node);
        });
        if (early) {
          activate();
          tail = transactionTail(inner);
        }
      },
    },
    turnTreePaths: {
      ...surface.turnTreePaths,
      async putMany(records) {
        await buffer(async (tx) => {
          await tx.turnTreePaths.putMany(records);
        });
      },
    },
    turnTrees: {
      ...surface.turnTrees,
      async put(record) {
        await buffer(async (tx) => {
          await tx.turnTrees.put(record);
        });
      },
    },
  };
  try {
    const result = await work(buffered);
    if (pending.length > 0) {
      await flush();
    }
    await tail?.finish();
    return result;
  } catch (error: unknown) {
    await tail?.finish({ cause: error });
    throw error;
  } finally {
    if (tail !== undefined) {
      disarm();
    }
  }
};

export const NON_ATOMIC_CHECKPOINT_MUTANT: KernelMutantDefinition = {
  createSeams: () => {
    let armed: object | undefined;
    return {
      backend: (inner, _context, activate) =>
        decorateBackend(inner, {
          transact: async <T>(work: RepositoryWork<T>): Promise<T> => {
            const checkpoint = armed;
            return checkpoint === undefined
              ? await inner.transact(work)
              : await splitCheckpoint(
                  inner,
                  activate,
                  () => {
                    if (armed === checkpoint) {
                      armed = undefined;
                    }
                  },
                  work
                );
          },
        }),
      faultInjection: (factory) => (inner, plan) => {
        armed = plan;
        return factory(inner, plan);
      },
    };
  },
  kind: "implementation",
  mutantId: "kernel.non-atomic-checkpoint",
  signal: "mutant.non-atomic-checkpoint.entered",
};
