import { AsyncLocalStorage } from "node:async_hooks";

import type { RuntimeBackend } from "@tuvren/kernel-protocol";

import { decorateBackend } from "./kernel-mutant-backend.js";

interface EntryReceipt {
  barrierId: string;
  seam: string;
  operationHandle: string;
}
interface Entry {
  released: boolean;
  receipt: EntryReceipt;
  gate: PromiseWithResolvers<null>;
}
interface Barrier {
  barrierId: string;
  seam: string;
  participants: ReadonlySet<string>;
  entries: Map<string, Entry>;
  arrivals: Map<string, PromiseWithResolvers<EntryReceipt>>;
}
interface OperationContext {
  operationHandle: string;
  signal?: AbortSignal;
}

const requireString = (value: unknown): string => {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError("barrier requires a nonempty string");
  }
  return value;
};

const context = new AsyncLocalStorage<OperationContext>();

export const createKernelBarrierControl = (inner: RuntimeBackend) => {
  const barriers = new Map<string, Barrier>();
  let active: Barrier | undefined;
  const read = (id: unknown): Barrier => {
    const barrier = barriers.get(requireString(id));
    if (barrier === undefined) {
      throw new Error("unknown barrier");
    }
    return barrier;
  };
  const backend = decorateBackend(inner, {
    // This dependency-entry gate runs before the backend acquires its Scope lock.
    transact: async (work) => {
      const operation = context.getStore();
      const barrier = active;
      if (operation !== undefined && barrier !== undefined) {
        let entry = barrier.entries.get(operation.operationHandle);
        if (entry === undefined) {
          entry = {
            gate: Promise.withResolvers<null>(),
            receipt: {
              barrierId: barrier.barrierId,
              operationHandle: operation.operationHandle,
              seam: barrier.seam,
            },
            released: false,
          };
          barrier.entries.set(operation.operationHandle, entry);
          barrier.arrivals
            .get(operation.operationHandle)
            ?.resolve(entry.receipt);
        }
        const abort = (): void => {
          entry?.gate.reject(operation.signal?.reason);
        };
        operation.signal?.throwIfAborted();
        operation.signal?.addEventListener("abort", abort, { once: true });
        try {
          await entry.gate.promise;
          operation.signal?.throwIfAborted();
        } finally {
          operation.signal?.removeEventListener("abort", abort);
        }
      }
      return await inner.transact(work);
    },
  });
  return {
    arm: (id: unknown, seam: unknown, participants: unknown) => {
      const barrierId = requireString(id);
      if (
        seam !== "kernel.persistence.before-transact" ||
        !Array.isArray(participants) ||
        participants.length < 2 ||
        participants.some(
          (value) => typeof value !== "string" || value.length === 0
        ) ||
        new Set(participants).size !== participants.length
      ) {
        throw new TypeError("unsupported barrier seam or participants");
      }
      if (active !== undefined || barriers.has(barrierId)) {
        throw new Error("barrier already armed");
      }
      active = {
        arrivals: new Map(),
        barrierId,
        entries: new Map(),
        participants: new Set(participants.map(requireString)),
        seam,
      };
      barriers.set(barrierId, active);
      return { barrierId, seam };
    },
    backend,
    close: (): void => {
      active = undefined;
      for (const barrier of barriers.values()) {
        for (const entry of barrier.entries.values()) {
          entry.gate.reject(new Error("barrier closed before release"));
        }
        for (const arrival of barrier.arrivals.values()) {
          arrival.reject(
            new Error("barrier closed before implementation entry receipt")
          );
        }
      }
    },
    release: (id: unknown, handles: unknown) => {
      const barrier = read(id);
      if (!Array.isArray(handles) || handles.length === 0) {
        throw new TypeError("release requires operation handles");
      }
      const entries = handles.map((handle) => {
        const entry = barrier.entries.get(requireString(handle));
        if (entry === undefined) {
          throw new Error("release before implementation entry receipt");
        }
        return entry;
      });
      for (const entry of entries) {
        entry.released = true;
        entry.gate.resolve(null);
      }
      if (
        barrier.entries.size >= barrier.participants.size &&
        [...barrier.entries.values()].every((entry) => entry.released)
      ) {
        active = undefined;
      }
      return { barrierId: barrier.barrierId, operationHandles: handles };
    },
    run: async <T>(
      operationHandle: string,
      signal: AbortSignal | undefined,
      work: () => Promise<T>
    ): Promise<T> => await context.run({ operationHandle, signal }, work),
    wait: async (id: unknown, handle: unknown, timeout: unknown) => {
      const barrier = read(id);
      const operationHandle = requireString(handle);
      if (
        typeof timeout !== "number" ||
        !Number.isSafeInteger(timeout) ||
        timeout < 1
      ) {
        throw new TypeError("invalid receipt timeout");
      }
      const entry = barrier.entries.get(operationHandle);
      if (entry !== undefined) {
        return entry.receipt;
      }
      let arrival = barrier.arrivals.get(operationHandle);
      if (arrival === undefined) {
        arrival = Promise.withResolvers<EntryReceipt>();
        barrier.arrivals.set(operationHandle, arrival);
      }
      const expired = Promise.withResolvers<never>();
      const timer = setTimeout(() => {
        expired.reject(
          new Error(`missing implementation entry receipt: ${operationHandle}`)
        );
      }, timeout);
      try {
        return await Promise.race([arrival.promise, expired.promise]);
      } finally {
        clearTimeout(timer);
        barrier.arrivals.delete(operationHandle);
      }
    },
  };
};
