import { randomUUID } from "node:crypto";

import { AdapterProtocolError } from "../../../../tools/conformance/adapter-protocol/index.js";
import type { OperationOutcome } from "../../../../tools/conformance/adapter-protocol/index.js";

export const createOperationHandles = (
  invoke: (
    operation: string,
    input: unknown,
    instance: unknown,
    signal: AbortSignal,
    operationHandle: string
  ) => Promise<OperationOutcome>,
  destroy: (instance: unknown) => Promise<void>
) => {
  const operations = new Map<
    string,
    {
      instance: unknown;
      controller: AbortController;
      outcome: Promise<PromiseSettledResult<OperationOutcome>>;
    }
  >();
  const readOperation = (operationHandle: string) => {
    const operation = operations.get(operationHandle);
    if (operation === undefined) {
      throw new Error("unknown operation handle");
    }
    return operation;
  };
  const startOperation = async (
    operation: string,
    argumentsValue: unknown,
    instance: unknown
  ): Promise<{ operationHandle: string }> => {
    const operationHandle = randomUUID();
    const controller = new AbortController();
    const outcome = (async (): Promise<
      PromiseSettledResult<OperationOutcome>
    > => {
      try {
        return {
          status: "fulfilled",
          value: await invoke(
            operation,
            argumentsValue,
            instance,
            controller.signal,
            operationHandle
          ),
        };
      } catch (error: unknown) {
        return { reason: error, status: "rejected" };
      }
    })();
    operations.set(operationHandle, { controller, instance, outcome });
    return await Promise.resolve({ operationHandle });
  };
  const awaitOperation = async (
    operationHandle: string
  ): Promise<OperationOutcome> => {
    const outcome = await readOperation(operationHandle).outcome;
    if (outcome.status === "rejected") {
      throw outcome.reason instanceof Error
        ? outcome.reason
        : new Error(String(outcome.reason));
    }
    return outcome.value;
  };
  const cancelOperation = async (
    operationHandle: string,
    reason: string
  ): Promise<void> => {
    readOperation(operationHandle).controller.abort(new Error(reason));
    await Promise.resolve();
  };
  const destroyOperations = async (handle: unknown): Promise<void> => {
    const pending: Promise<PromiseSettledResult<OperationOutcome>>[] = [];
    for (const operation of operations.values()) {
      if (operation.instance === handle) {
        operation.controller.abort(new Error("adapter instance destroyed"));
        pending.push(operation.outcome);
      }
    }
    const expired = Promise.withResolvers<never>();
    const timer = setTimeout(() => {
      expired.reject(
        new AdapterProtocolError(
          "adapter_instance_busy",
          "started operations did not stop before destruction deadline"
        )
      );
    }, 1000);
    try {
      await Promise.race([Promise.all(pending), expired.promise]);
    } finally {
      clearTimeout(timer);
    }
    await destroy(handle);
    for (const [operationHandle, operation] of operations) {
      if (operation.instance === handle) {
        operations.delete(operationHandle);
      }
    }
  };
  return {
    awaitOperation,
    cancelOperation,
    destroyInstance: destroyOperations,
    startOperation,
  };
};
