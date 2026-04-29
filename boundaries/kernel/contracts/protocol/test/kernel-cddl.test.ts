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

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  assertEpochMs,
  assertHashString,
  assertKernelRecord,
} from "@tuvren/core-types";
import { parse } from "cddl";
import { assertRunRecord, assertTurnTreeSchema } from "../src/index.ts";

const REQUIRED_CDDL_ASSIGNMENTS = [
  "hash-string",
  "non-empty-tstr",
  "js-safe-int",
  "non-negative-safe-int",
  "turn-tree-schema",
  "turn-tree-manifest",
  "staged-result",
  "turn-node",
  "thread-record",
  "branch-record",
  "turn-record",
  "run-record",
  "recovery-state",
  "thread-create-result",
  "branch-head-list-entry",
  "set-head-result",
  "stored-object",
  "stored-turn-tree",
  "stored-turn-node",
  "stored-run",
  "stored-staged-result",
] as const;

const HASH_STRING_PATTERN = "^[0-9a-f]{64}$";
const NON_EMPTY_TEXT_PATTERN = ".+";
const MIN_SAFE_INTEGER = -9_007_199_254_740_991;
const MAX_SAFE_INTEGER = 9_007_199_254_740_991;
const HASH_STRING_ERROR_PATTERN = /lowercase 64-character SHA-256 hex digest/;
const SAFE_INTEGER_ERROR_PATTERN = /safe integer/;
const KERNEL_RECORD_ERROR_PATTERN = /restricted runtime kernel record profile/;
const NON_EMPTY_STRING_ERROR_PATTERN = /non-empty string/;
const NON_NEGATIVE_SAFE_INTEGER_ERROR_PATTERN = /non-negative safe integer/;
const GROUP_REFERENCE = (value: string) => ({
  Type: "group",
  Unwrapped: false,
  Value: value,
});

interface CddlAssignment {
  Name: string;
  Type: string;
}

interface CddlVariableAssignment extends CddlAssignment {
  PropertyType: unknown[];
}

interface CddlGroupAssignment extends CddlAssignment {
  Properties: CddlProperty[];
}

interface CddlArrayAssignment extends CddlAssignment {
  Values: CddlProperty[];
}

interface CddlProperty {
  Name: string;
  Type: unknown[];
}

describe("kernel CDDL grammar", () => {
  test("parses the authored kernel record grammar and names canonical families", () => {
    const { assignments } = readKernelCddlGrammar();
    const assignmentNames = new Set(
      assignments.map((assignment) => assignment.Name)
    );

    for (const requiredAssignment of REQUIRED_CDDL_ASSIGNMENTS) {
      expect(assignmentNames.has(requiredAssignment)).toBe(true);
    }
  });

  test("mirrors runtime scalar restrictions in the CDDL artifact", () => {
    const { assignments, source } = readKernelCddlGrammar();

    expectVariableRegexp(assignments, "hash-string", HASH_STRING_PATTERN);
    expectVariableRegexp(assignments, "non-empty-tstr", NON_EMPTY_TEXT_PATTERN);
    expectVariableRange(
      assignments,
      "js-safe-int",
      MIN_SAFE_INTEGER,
      MAX_SAFE_INTEGER
    );
    expectVariableRange(
      assignments,
      "non-negative-safe-int",
      0,
      MAX_SAFE_INTEGER
    );
    expectVariableReferences(assignments, "epoch-ms", "js-safe-int");
    expectVariableReferences(assignments, "kernel-record", "js-safe-int");

    for (const { fieldName, groupName } of NON_EMPTY_GROUP_FIELDS) {
      expectGroupFieldReferences(
        assignments,
        groupName,
        fieldName,
        "non-empty-tstr"
      );
    }

    for (const { fieldName, groupName } of NON_NEGATIVE_SAFE_INTEGER_FIELDS) {
      expectGroupFieldReferences(
        assignments,
        groupName,
        fieldName,
        "non-negative-safe-int"
      );
    }

    expectArrayFieldReferences(
      assignments,
      "branch-head-list-entry",
      "branchId",
      "non-empty-tstr"
    );
    // Keep this explicit: uint alone is non-negative but still too wide for
    // the JavaScript-safe integer protocol profile used by runtime validators.
    expect(source).not.toContain(": uint");
  });

  test("keeps runtime fixtures aligned with the CDDL scalar profile", () => {
    const validHash = "f".repeat(64);
    const validSchema = {
      incorporationRules: [
        {
          objectType: "message",
          targetPath: "messages",
        },
      ],
      paths: [
        {
          collection: "ordered",
          path: "messages",
        },
      ],
      schemaId: "chat",
    };
    const validRun = {
      branchId: "branch-1",
      createdTurnNodes: [],
      currentStepIndex: 0,
      runId: "run-1",
      schemaId: "chat",
      startTurnNodeHash: validHash,
      status: "completed",
      stepSequence: [],
      turnId: "turn-1",
    };

    expect(() => assertHashString(validHash, "hash")).not.toThrow();
    expect(() => assertHashString("F".repeat(64), "hash")).toThrow(
      HASH_STRING_ERROR_PATTERN
    );
    expect(() => assertEpochMs(MAX_SAFE_INTEGER, "epoch")).not.toThrow();
    expect(() => assertEpochMs(MAX_SAFE_INTEGER + 1, "epoch")).toThrow(
      SAFE_INTEGER_ERROR_PATTERN
    );
    expect(() => assertKernelRecord({ negative: -1 }, "record")).not.toThrow();
    expect(() =>
      assertKernelRecord({ tooLarge: MAX_SAFE_INTEGER + 1 }, "record")
    ).toThrow(KERNEL_RECORD_ERROR_PATTERN);
    expect(() => assertTurnTreeSchema(validSchema, "schema")).not.toThrow();
    expect(() =>
      assertTurnTreeSchema({ ...validSchema, schemaId: "" }, "schema")
    ).toThrow(NON_EMPTY_STRING_ERROR_PATTERN);
    expect(() => assertRunRecord(validRun, "run")).not.toThrow();
    expect(() =>
      assertRunRecord({ ...validRun, currentStepIndex: -1 }, "run")
    ).toThrow(NON_NEGATIVE_SAFE_INTEGER_ERROR_PATTERN);
  });
});

const NON_EMPTY_GROUP_FIELDS = [
  { fieldName: "mediaType", groupName: "kernel-object" },
  { fieldName: "path", groupName: "path-definition" },
  { fieldName: "objectType", groupName: "incorporation-rule" },
  { fieldName: "targetPath", groupName: "incorporation-rule" },
  { fieldName: "schemaId", groupName: "turn-tree-schema" },
  { fieldName: "id", groupName: "step-declaration" },
  { fieldName: "reason", groupName: "abort-verdict" },
  { fieldName: "reason", groupName: "pause-verdict" },
  { fieldName: "taskId", groupName: "base-staged-result" },
  { fieldName: "objectType", groupName: "base-staged-result" },
  { fieldName: "schemaId", groupName: "turn-node" },
  { fieldName: "threadId", groupName: "thread-record" },
  { fieldName: "schemaId", groupName: "thread-record" },
  { fieldName: "branchId", groupName: "branch-record" },
  { fieldName: "threadId", groupName: "branch-record" },
  { fieldName: "turnId", groupName: "turn-record" },
  { fieldName: "threadId", groupName: "turn-record" },
  { fieldName: "branchId", groupName: "turn-record" },
  { fieldName: "parentTurnId", groupName: "turn-record" },
  { fieldName: "runId", groupName: "run-record" },
  { fieldName: "turnId", groupName: "run-record" },
  { fieldName: "branchId", groupName: "run-record" },
  { fieldName: "schemaId", groupName: "run-record" },
  { fieldName: "lastCompletedStepId", groupName: "recovery-state" },
  { fieldName: "branchId", groupName: "thread-create-result" },
  { fieldName: "threadId", groupName: "thread-create-result" },
  { fieldName: "mediaType", groupName: "stored-object" },
  { fieldName: "schemaId", groupName: "stored-schema" },
  { fieldName: "schemaId", groupName: "stored-turn-tree" },
  { fieldName: "path", groupName: "stored-single-turn-tree-path" },
  { fieldName: "path", groupName: "stored-flat-ordered-turn-tree-path" },
  { fieldName: "path", groupName: "stored-chunked-ordered-turn-tree-path" },
  { fieldName: "schemaId", groupName: "stored-turn-node" },
  { fieldName: "threadId", groupName: "stored-thread" },
  { fieldName: "schemaId", groupName: "stored-thread" },
  { fieldName: "branchId", groupName: "stored-branch" },
  { fieldName: "threadId", groupName: "stored-branch" },
  { fieldName: "archivedFromBranchId", groupName: "stored-branch" },
  { fieldName: "turnId", groupName: "stored-turn" },
  { fieldName: "threadId", groupName: "stored-turn" },
  { fieldName: "branchId", groupName: "stored-turn" },
  { fieldName: "parentTurnId", groupName: "stored-turn" },
  { fieldName: "runId", groupName: "stored-run" },
  { fieldName: "turnId", groupName: "stored-run" },
  { fieldName: "branchId", groupName: "stored-run" },
  { fieldName: "schemaId", groupName: "stored-run" },
  { fieldName: "runId", groupName: "stored-staged-result" },
  { fieldName: "taskId", groupName: "stored-staged-result" },
  { fieldName: "objectType", groupName: "stored-staged-result" },
] as const;

const NON_NEGATIVE_SAFE_INTEGER_FIELDS = [
  { fieldName: "currentStepIndex", groupName: "run-record" },
  { fieldName: "byteLength", groupName: "stored-object" },
  {
    fieldName: "orderedCount",
    groupName: "stored-flat-ordered-turn-tree-path",
  },
  {
    fieldName: "orderedCount",
    groupName: "stored-chunked-ordered-turn-tree-path",
  },
  { fieldName: "itemCount", groupName: "stored-ordered-path-chunk" },
  { fieldName: "currentStepIndex", groupName: "stored-run" },
] as const;

function readKernelCddlGrammar(): {
  assignments: CddlAssignment[];
  source: string;
} {
  const cddlPath = fileURLToPath(
    new URL("../spec/cddl/kernel-records.cddl", import.meta.url)
  );
  const assignments = parse(cddlPath);
  assertCddlAssignments(assignments);

  return {
    assignments,
    source: readFileSync(cddlPath, "utf8"),
  };
}

function expectVariableRegexp(
  assignments: CddlAssignment[],
  name: string,
  pattern: string
): void {
  const assignment = findVariableAssignment(assignments, name);

  expect(assignment.PropertyType).toContainEqual({
    Operator: {
      Type: "regexp",
      Value: {
        Type: "literal",
        Unwrapped: false,
        Value: pattern,
      },
    },
    Type: "tstr",
  });
}

function expectVariableRange(
  assignments: CddlAssignment[],
  name: string,
  min: number,
  max: number
): void {
  const assignment = findVariableAssignment(assignments, name);

  expect(assignment.PropertyType).toContainEqual({
    Type: "range",
    Unwrapped: false,
    Value: {
      Inclusive: true,
      Max: {
        Type: "literal",
        Unwrapped: false,
        Value: max,
      },
      Min: {
        Type: "literal",
        Unwrapped: false,
        Value: min,
      },
    },
  });
}

function expectVariableReferences(
  assignments: CddlAssignment[],
  name: string,
  referenceName: string
): void {
  const assignment = findVariableAssignment(assignments, name);

  expect(assignment.PropertyType).toContainEqual(
    GROUP_REFERENCE(referenceName)
  );
}

function expectGroupFieldReferences(
  assignments: CddlAssignment[],
  groupName: string,
  fieldName: string,
  referenceName: string
): void {
  const field = findGroupField(assignments, groupName, fieldName);

  expect(field.Type).toContainEqual(GROUP_REFERENCE(referenceName));
}

function expectArrayFieldReferences(
  assignments: CddlAssignment[],
  arrayName: string,
  fieldName: string,
  referenceName: string
): void {
  const assignment = findArrayAssignment(assignments, arrayName);
  const field = assignment.Values.find((value) => value.Name === fieldName);

  expect(field).toBeDefined();
  expect(field?.Type).toContainEqual(GROUP_REFERENCE(referenceName));
}

function findVariableAssignment(
  assignments: CddlAssignment[],
  name: string
): CddlVariableAssignment {
  const assignment = assignments.find(
    (candidate) => candidate.Name === name && candidate.Type === "variable"
  );

  if (!isVariableAssignment(assignment)) {
    throw new Error(`Expected CDDL variable assignment "${name}"`);
  }

  return assignment;
}

function findGroupField(
  assignments: CddlAssignment[],
  groupName: string,
  fieldName: string
): CddlProperty {
  const assignment = assignments.find(
    (candidate) => candidate.Name === groupName && candidate.Type === "group"
  );

  if (!isGroupAssignment(assignment)) {
    throw new Error(`Expected CDDL group assignment "${groupName}"`);
  }

  const field = assignment.Properties.find(
    (property) => property.Name === fieldName
  );

  if (field === undefined) {
    throw new Error(`Expected ${groupName}.${fieldName} in CDDL grammar`);
  }

  return field;
}

function findArrayAssignment(
  assignments: CddlAssignment[],
  name: string
): CddlArrayAssignment {
  const assignment = assignments.find(
    (candidate) => candidate.Name === name && candidate.Type === "array"
  );

  if (!isArrayAssignment(assignment)) {
    throw new Error(`Expected CDDL array assignment "${name}"`);
  }

  return assignment;
}

function assertCddlAssignments(
  value: unknown
): asserts value is CddlAssignment[] {
  if (!(Array.isArray(value) && value.every(isCddlAssignment))) {
    throw new Error("Expected cddl.parse to return CDDL assignments");
  }
}

function isCddlAssignment(value: unknown): value is CddlAssignment {
  return (
    isRecord(value) &&
    typeof value.Name === "string" &&
    typeof value.Type === "string"
  );
}

function isVariableAssignment(value: unknown): value is CddlVariableAssignment {
  return (
    isCddlAssignment(value) &&
    isRecord(value) &&
    Array.isArray(value.PropertyType)
  );
}

function isGroupAssignment(value: unknown): value is CddlGroupAssignment {
  return (
    isCddlAssignment(value) &&
    isRecord(value) &&
    Array.isArray(value.Properties) &&
    value.Properties.every(isCddlProperty)
  );
}

function isArrayAssignment(value: unknown): value is CddlArrayAssignment {
  return (
    isCddlAssignment(value) &&
    isRecord(value) &&
    Array.isArray(value.Values) &&
    value.Values.every(isCddlProperty)
  );
}

function isCddlProperty(value: unknown): value is CddlProperty {
  return (
    isRecord(value) &&
    typeof value.Name === "string" &&
    Array.isArray(value.Type)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
