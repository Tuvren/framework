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

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const BOOTSTRAP =
  "docs/KrakenKernelSpecification.md §3.3 (implementation-owned bootstrap event), §4.1 (thread bootstrap); ADR-0078 §2–3 (derived identities)";
const PREEMPTION =
  "docs/KrakenKernelSpecification.md §5.2 (stale running preemption); ADR-0078 §2–3 (derived identities)";
const FENCING =
  "docs/KrakenKernelSpecification.md §5.2 (execution lease fencing tokens)";
const CURSOR =
  "docs/KrakenKernelSpecification.md §9.3 (opaque enumeration cursors)";
const ARCHIVE =
  "docs/KrakenKernelSpecification.md §4.2 (archive branch creation); spec/conformance/kernel/operations.json kernel.branch.setHead observation.result.archiveBranch.branchId";

export const normalizeObservation = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(normalizeObservation);
  }
  if (!isRecord(value)) {
    return value;
  }
  const entries = Object.entries(value).toSorted(([a], [b]) =>
    a.localeCompare(b)
  );
  return Object.fromEntries(
    entries.map(([key, child]) => [
      key,
      key === "$map" && Array.isArray(child)
        ? child
            .map(normalizeObservation)
            .toSorted((a, b) =>
              JSON.stringify(Array.isArray(a) ? a[0] : a).localeCompare(
                JSON.stringify(Array.isArray(b) ? b[0] : b)
              )
            )
        : normalizeObservation(child),
    ])
  );
};

const visit = (
  value: unknown,
  action: (record: Record<string, unknown>) => void
): void => {
  if (Array.isArray(value)) {
    for (const child of value) {
      visit(child, action);
    }
  } else if (isRecord(value)) {
    action(value);
    for (const child of Object.values(value)) {
      visit(child, action);
    }
  }
};

export const stabilizeObservations = (
  value: unknown,
  implementationId: string
): unknown => {
  const tokens = new Map<string, string>();
  visit(value, (record) => {
    if (
      typeof record.fencingToken === "string" &&
      !tokens.has(record.fencingToken)
    ) {
      tokens.set(
        record.fencingToken,
        `opaque:fencingToken:${implementationId}:${tokens.size + 1}`
      );
    }
  });
  const replace = (child: unknown): unknown => {
    if (typeof child === "string") {
      return tokens.get(child) ?? child;
    }
    if (Array.isArray(child)) {
      return child.map(replace);
    }
    if (isRecord(child)) {
      return Object.fromEntries(
        Object.entries(child).map(([key, entry]) => [key, replace(entry)])
      );
    }
    return child;
  };
  return normalizeObservation(replace(value));
};

export interface ComparedCheck {
  checkId: string;
  status: string;
  assertionResults: readonly unknown[];
}
export interface ComparedImplementation {
  implementationId: string;
  checks: readonly ComparedCheck[];
  observations: readonly unknown[];
}
export interface ObservationDifference {
  checkId: string;
  kind: "applicability" | "outcome" | "observations";
  path: string;
  classification: "sanctioned" | "disagreement" | "coverage";
  citation?: string;
  implementations: readonly [string, string];
  values: readonly unknown[];
}

const collectCheckpointIdentities = (
  observations: unknown,
  values: Map<string, string>
): void => {
  if (!Array.isArray(observations)) {
    return;
  }
  let currentNode: string | undefined;
  for (const frame of observations) {
    if (
      !isRecord(frame) ||
      frame.method !== "dispatch" ||
      !isRecord(frame.outcome) ||
      !isRecord(frame.outcome.value)
    ) {
      continue;
    }
    const { result } = frame.outcome.value;
    if (!isRecord(result)) {
      continue;
    }
    if (
      frame.operation === "kernel.run.beginStep" &&
      typeof result.currentTurnNodeHash === "string"
    ) {
      currentNode = result.currentTurnNodeHash;
    }
    const inherited =
      currentNode === undefined ? undefined : values.get(currentNode);
    if (
      frame.operation === "kernel.run.completeStep" &&
      inherited !== undefined &&
      result.checkpointed === true &&
      typeof result.turnNodeHash === "string"
    ) {
      values.set(result.turnNodeHash, inherited);
    }
  }
};

const inheritNodeIdentity = (
  record: Record<string, unknown>,
  values: Map<string, string>
): boolean => {
  const previous = record.previousTurnNodeHash;
  const { hash } = record;
  if (typeof hash !== "string") {
    return false;
  }
  const inherited =
    typeof previous === "string" ? values.get(previous) : undefined;
  const changed = inherited !== undefined && !values.has(hash);
  if (inherited !== undefined && changed) {
    values.set(hash, inherited);
  }
  if (
    values.has(hash) &&
    typeof record.eventHash === "string" &&
    (previous === null || values.get(hash) === PREEMPTION)
  ) {
    values.set(record.eventHash, previous === null ? BOOTSTRAP : PREEMPTION);
  }
  return changed;
};

const sanctionedValues = (observations: unknown): Map<string, string> => {
  const values = new Map<string, string>();
  const records: Record<string, unknown>[] = [];
  visit(observations, (record) => {
    records.push(record);
    if (record.operation === "kernel.thread.create") {
      visit(record.outcome, (nested) => {
        if (typeof nested.rootTurnNodeHash === "string") {
          values.set(nested.rootTurnNodeHash, BOOTSTRAP);
        }
      });
    }
    if (record.operation === "kernel.branch.setHead") {
      visit(record.outcome, (nested) => {
        if (
          isRecord(nested.archiveBranch) &&
          typeof nested.archiveBranch.branchId === "string"
        ) {
          values.set(nested.archiveBranch.branchId, ARCHIVE);
        }
      });
    }
  });
  for (const record of records) {
    if (record.operation === "kernel.runLiveness.preemptExpired") {
      visit(record.outcome, (nested) => {
        if (typeof nested.lastTurnNodeHash === "string") {
          values.set(nested.lastTurnNodeHash, PREEMPTION);
        }
      });
    }
  }
  collectCheckpointIdentities(observations, values);
  let changed = true;
  while (changed) {
    changed = false;
    for (const record of records) {
      changed = inheritNodeIdentity(record, values) || changed;
    }
  }
  for (const record of records) {
    if (typeof record.$bytes !== "string") {
      continue;
    }
    const hash = createHash("sha256")
      .update(Buffer.from(record.$bytes, "hex"))
      .digest("hex");
    const citation = values.get(hash);
    if (citation !== undefined) {
      values.set(record.$bytes, citation);
    }
  }
  return values;
};

const citationFor = (
  left: unknown,
  right: unknown,
  key: string,
  path: string,
  aParent: unknown,
  bParent: unknown,
  aValues: Map<string, string>,
  bValues: Map<string, string>
): string | undefined => {
  if (
    key === "message" &&
    path.endsWith(".outcome.error.message") &&
    isRecord(aParent) &&
    isRecord(bParent) &&
    typeof aParent.code === "string" &&
    aParent.code === bParent.code
  ) {
    return "ADR-0075 §2 (native error forwarding); spec/conformance/kernel/operations.json errors (equal canonical codes)";
  }
  if (typeof left !== "string" || typeof right !== "string") {
    return undefined;
  }
  if (key === "fencingToken") {
    return FENCING;
  }
  if (key === "nextCursor") {
    return CURSOR;
  }
  const a = aValues.get(left);
  const b = bValues.get(right);
  return a !== undefined && a === b ? a : undefined;
};

interface ComparisonContext {
  checkId: string;
  implementations: readonly [string, string];
  aValues: Map<string, string>;
  bValues: Map<string, string>;
  differences: ObservationDifference[];
}

const walkDifferences = (
  x: unknown,
  y: unknown,
  context: ComparisonContext,
  path = "$",
  key = "",
  xParent?: unknown,
  yParent?: unknown
): void => {
  if (isDeepStrictEqual(x, y)) {
    return;
  }
  if (isRecord(x) && isRecord(y)) {
    for (const field of [
      ...new Set([...Object.keys(x), ...Object.keys(y)]),
    ].toSorted()) {
      walkDifferences(
        x[field],
        y[field],
        context,
        `${path}.${field}`,
        field,
        x,
        y
      );
    }
    return;
  }
  if (Array.isArray(x) && Array.isArray(y) && x.length === y.length) {
    for (const [i, entry] of x.entries()) {
      walkDifferences(entry, y[i], context, `${path}[${i}]`, String(i), x, y);
    }
    return;
  }
  const citation = citationFor(
    x,
    y,
    key,
    path,
    xParent,
    yParent,
    context.aValues,
    context.bValues
  );
  context.differences.push({
    checkId: context.checkId,
    ...(citation === undefined ? {} : { citation }),
    classification: citation === undefined ? "disagreement" : "sanctioned",
    implementations: context.implementations,
    kind: "observations",
    path,
    values: [x ?? null, y ?? null],
  });
};

const indexChecks = (input: ComparedImplementation) =>
  new Map(
    input.checks.map((check, i) => [
      check.checkId,
      { check, observations: normalizeObservation(input.observations[i]) },
    ])
  );

const comparePair = (
  left: ComparedImplementation,
  right: ComparedImplementation
): ObservationDifference[] => {
  const differences: ObservationDifference[] = [];
  const a = indexChecks(left);
  const b = indexChecks(right);
  const pair: readonly [string, string] = [
    left.implementationId,
    right.implementationId,
  ];
  for (const checkId of [...new Set([...a.keys(), ...b.keys()])].toSorted()) {
    const l = a.get(checkId);
    const r = b.get(checkId);
    if (l === undefined || r === undefined) {
      differences.push({
        checkId,
        citation: "ADR-0081 §1, §3 (selection inventory)",
        classification: "coverage",
        implementations: pair,
        kind: "applicability",
        path: "$",
        values: [l !== undefined, r !== undefined],
      });
      continue;
    }
    if (!isDeepStrictEqual(l.check, r.check)) {
      differences.push({
        checkId,
        classification: "disagreement",
        implementations: pair,
        kind: "outcome",
        path: "$",
        values: [l.check, r.check],
      });
    }
    walkDifferences(l.observations, r.observations, {
      aValues: sanctionedValues(l.observations),
      bValues: sanctionedValues(r.observations),
      checkId,
      differences,
      implementations: pair,
    });
  }
  return differences;
};

export const compareObservations = (
  implementations: readonly ComparedImplementation[]
): ObservationDifference[] =>
  implementations.flatMap((left, index) =>
    implementations
      .slice(index + 1)
      .flatMap((right) => comparePair(left, right))
  );

export const validateObservationSteps = (
  checkId: string,
  steps: readonly {
    stepId: string;
    operation: string;
    inspectState?: unknown;
  }[],
  observations: unknown
): void => {
  if (!Array.isArray(observations)) {
    throw new TypeError(`${checkId}: observations must be an array`);
  }
  let index = 0;
  for (const step of steps) {
    const methods = [
      "dispatch",
      "events",
      ...(step.inspectState === undefined ? [] : ["inspectState"]),
    ];
    for (const method of methods) {
      const frame: unknown = observations[index];
      if (
        !isRecord(frame) ||
        frame.method !== method ||
        frame.operation !== step.operation
      ) {
        throw new Error(
          `${checkId}/${step.stepId}: observation ${index} expected ${method} ${step.operation}`
        );
      }
      index += 1;
    }
  }
  if (index !== observations.length) {
    throw new Error(`${checkId}: unexpected trailing observations`);
  }
};
