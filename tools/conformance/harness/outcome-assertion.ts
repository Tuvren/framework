import type { CatalogOperation } from "../plan-compiler/certification-rules.js";
import type {
  ConformancePlanCheck,
  ConformancePlanStep,
} from "../plan-compiler/index.js";
import {
  isDeclaredErrorOutcomeSchema,
  resolveExpectedSchema,
} from "../plan-compiler/outcome-schema.js";

export const assertsNativeErrorOutcome = (
  check: ConformancePlanCheck,
  step: ConformancePlanStep,
  context: Record<string, unknown>,
  operation: CatalogOperation | undefined
): boolean =>
  check.assertions.some(
    (assertion) =>
      assertion.kind === "schemaValid" &&
      assertion.when === undefined &&
      assertion.path === `$.result.trace.${step.stepId}.outcome` &&
      operation !== undefined &&
      isDeclaredErrorOutcomeSchema(
        resolveExpectedSchema(context.fixture, assertion.schema),
        operation.errors ?? []
      )
  );
