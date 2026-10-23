import type { OperationOutcome } from "../adapter-protocol/index.js";
import type { ConformancePlanStep } from "../plan-compiler/index.js";
import type { JsonRpcAdapterClient } from "./adapter-client.js";
import { ArgumentResolutionError } from "./step-arguments.js";

export const isOperationHandleStep = (step: ConformancePlanStep): boolean =>
  step.action === "start" ||
  step.action === "await" ||
  step.action === "cancel";

const readStringArgument = (input: unknown, key: string): string => {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ArgumentResolutionError(`${key} requires an arguments object`);
  }
  const value: unknown = Reflect.get(input, key);
  if (typeof value !== "string" || value.length === 0) {
    throw new ArgumentResolutionError(`${key} must be a non-empty string`);
  }
  return value;
};

export const runOperationHandleStep = async (
  client: JsonRpcAdapterClient,
  step: ConformancePlanStep,
  input: unknown,
  instance: unknown,
  started: Map<string, string>,
  timeoutMs?: number
): Promise<OperationOutcome> => {
  if (step.arguments === undefined) {
    throw new ArgumentResolutionError(
      "operation handle steps require explicit arguments"
    );
  }
  if (step.action === "start") {
    const receipt = await client.startOperation(
      step.operation,
      input,
      instance,
      timeoutMs
    );
    if (started.has(receipt.operationHandle)) {
      throw new Error("adapter reused an operation handle");
    }
    started.set(receipt.operationHandle, step.operation);
    return { kind: "result", value: { result: receipt } };
  }
  const operationHandle = readStringArgument(input, "operationHandle");
  if (started.get(operationHandle) !== step.operation) {
    throw new ArgumentResolutionError(
      "operation handle does not belong to this check and operation"
    );
  }
  if (step.action === "await") {
    return await client.awaitOperation(operationHandle, timeoutMs);
  }
  if (step.action === "cancel") {
    await client.cancelOperation(
      operationHandle,
      readStringArgument(input, "reason"),
      timeoutMs
    );
    return { kind: "result", value: { result: null } };
  }
  throw new Error("unsupported operation handle step");
};
