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

// biome-ignore-all lint/performance/noBarrelFile: This focused contract subpath intentionally combines shared runtime validators with delegated record validators.

import type {
  ComposedVerdict,
  ObserveResult,
  PathCollectionKind,
  PathDefinition,
  PathValue,
  RunCompletionStatus,
  RunStatus,
  StagedResultStatus,
  StepDeclaration,
  TurnTreeChangeSet,
  TurnTreeManifest,
  TurnTreeSchema,
  Verdict,
  VerdictDisposition,
} from "./kernel-types.js";
import {
  assertAllowedObjectKeys,
  assertArray,
  assertBoolean,
  assertHashString,
  assertHashStringArray,
  assertKernelObjectArray,
  assertKernelRecord,
  assertKernelRecordArray,
  assertNonEmptyString,
  assertOptionalFieldIsOmittedWhenUndefined,
  assertPlainObject,
  isStringLiteral,
  tryAssert,
  validationError,
} from "./kernel-validation-shared.js";

export {
  assertBranchHeadListEntry,
  assertBranchRecord,
  assertRecoveryState,
  assertRunRecord,
  assertSetHeadResult,
  assertStagedResult,
  assertStepContext,
  assertThreadCreateResult,
  assertThreadRecord,
  assertTurnNode,
  assertTurnNodeIdentity,
  assertTurnRecord,
  isBranchHeadListEntry,
  isBranchRecord,
  isRecoveryState,
  isRunRecord,
  isSetHeadResult,
  isStagedResult,
  isStepContext,
  isThreadCreateResult,
  isThreadRecord,
  isTurnNode,
  isTurnRecord,
} from "./kernel-validation-records.js";

const PATH_COLLECTION_KINDS = ["ordered", "single"] as const;
const STAGED_RESULT_STATUSES = ["completed", "failed", "interrupted"] as const;
const RUN_STATUSES = ["running", "paused", "completed", "failed"] as const;
const RUN_COMPLETION_STATUSES = ["paused", "completed", "failed"] as const;
const VERDICT_DISPOSITIONS = ["HardFail", "SoftFail", "EndTurn"] as const;

/**
 * True when `value` is a valid {@link PathCollectionKind}.
 */
export function isPathCollectionKind(
  value: unknown
): value is PathCollectionKind {
  return isStringLiteral(value, PATH_COLLECTION_KINDS);
}

/**
 * Asserts a valid {@link PathCollectionKind} (`"ordered"` or `"single"`,
 * kernel spec §3.1).
 */
export function assertPathCollectionKind(
  value: unknown,
  label = "value"
): asserts value is PathCollectionKind {
  if (!isPathCollectionKind(value)) {
    throw validationError(
      `${label} must be "ordered" or "single"`,
      "invalid_path_collection_kind",
      { value }
    );
  }
}

/**
 * True when `value` is a valid {@link PathValue}: a HashString, a dense
 * HashString array, or `null`. Kind-agnostic — use
 * {@link assertPathValueForCollectionKind} to also check the collection kind.
 */
export function isPathValue(value: unknown): value is PathValue {
  return (
    typeof value === "string" ||
    value === null ||
    tryAssert(value, (candidate, candidateLabel = "value") =>
      assertHashStringArray(candidate, candidateLabel)
    )
  );
}

/**
 * Asserts a valid {@link PathValue} without checking collection-kind pairing.
 */
export function assertPathValue(
  value: unknown,
  label = "value"
): asserts value is PathValue {
  if (!isPathValue(value)) {
    throw validationError(
      `${label} must be a HashString, HashString[], or null`,
      "invalid_path_value",
      { value }
    );
  }
}

/**
 * Asserts that a path value matches its collection kind (kernel spec §3.2):
 * `HashString[]` for `"ordered"` paths, `HashString | null` for `"single"`
 * paths.
 *
 * @throws TuvrenValidationError With code `invalid_path_value_kind`.
 */
export function assertPathValueForCollectionKind(
  value: unknown,
  collectionKind: PathCollectionKind,
  label = "value"
): asserts value is PathValue {
  assertPathCollectionKind(collectionKind, "collectionKind");

  if (collectionKind === "ordered") {
    if (
      !tryAssert(value, (candidate, candidateLabel = "value") =>
        assertHashStringArray(candidate, candidateLabel)
      )
    ) {
      throw validationError(
        `${label} must be a HashString[] for an ordered path`,
        "invalid_path_value_kind",
        { collectionKind, value }
      );
    }

    return;
  }

  if (
    !(
      tryAssert(value, (candidate, candidateLabel = "value") =>
        assertHashString(candidate, candidateLabel)
      ) || value === null
    )
  ) {
    throw validationError(
      `${label} must be a HashString or null for a single path`,
      "invalid_path_value_kind",
      { collectionKind, value }
    );
  }
}

/**
 * True when `value` is a valid {@link TurnTreeSchema}.
 */
export function isTurnTreeSchema(value: unknown): value is TurnTreeSchema {
  return tryAssert(value, assertTurnTreeSchema);
}

/**
 * Asserts a valid {@link TurnTreeSchema} against the registration rules of
 * kernel spec §3.1 / Appendix B: non-empty `schemaId`, well-formed path
 * definitions without duplicates, and incorporation rules whose target paths
 * exist and whose `objectType` mappings are unique.
 */
export function assertTurnTreeSchema(
  value: unknown,
  label = "value"
): asserts value is TurnTreeSchema {
  const objectValue = assertPlainObject(value, label);
  assertAllowedObjectKeys(
    objectValue,
    ["incorporationRules", "paths", "schemaId"],
    label
  );

  assertNonEmptyString(objectValue.schemaId, `${label}.schemaId`);
  assertPathDefinitions(objectValue.paths, `${label}.paths`);
  assertIncorporationRules(
    objectValue.incorporationRules,
    objectValue.paths,
    `${label}.incorporationRules`
  );
}

/**
 * Asserts a valid {@link TurnTreeManifest} (kernel spec §3.2).
 *
 * Without a schema, only path-map shape is validated (dot-separated paths and
 * valid {@link PathValue}s). With a schema, the manifest must be full: every
 * schema path present, no unknown paths, and each value matching its collection
 * kind.
 */
export function assertTurnTreeManifest(
  value: unknown,
  label?: string
): asserts value is TurnTreeManifest;
export function assertTurnTreeManifest(
  value: unknown,
  schema: TurnTreeSchema,
  label?: string
): asserts value is TurnTreeManifest;
export function assertTurnTreeManifest(
  value: unknown,
  schemaOrLabel?: string | TurnTreeSchema,
  label = "value"
): asserts value is TurnTreeManifest {
  const { schema, resolvedLabel } = resolveSchemaAndLabel(
    schemaOrLabel,
    label,
    "schema"
  );
  const manifest = assertTurnTreePathMap(value, resolvedLabel);

  if (schema !== undefined) {
    assertTurnTreePathMapMatchesSchema(manifest, schema, resolvedLabel, true);
  }
}

/**
 * Asserts a valid {@link TurnTreeChangeSet} against a schema (kernel spec
 * §3.2). Unlike a manifest, a change set may be partial: schema paths may be
 * omitted, but every present path must be schema-defined and match its
 * collection kind.
 */
export function assertTurnTreeChangeSet(
  value: unknown,
  schema: TurnTreeSchema,
  label = "value"
): asserts value is TurnTreeChangeSet {
  assertTurnTreeSchema(schema, "schema");
  const changeSet = assertTurnTreePathMap(value, label);
  assertTurnTreePathMapMatchesSchema(changeSet, schema, label, false);
}

/**
 * True when `value` is a valid {@link StepDeclaration}.
 */
export function isStepDeclaration(value: unknown): value is StepDeclaration {
  return tryAssert(value, assertStepDeclaration);
}

/**
 * Asserts a valid {@link StepDeclaration} (kernel spec §5.1). Optional
 * `metadata` must be a KernelRecord and omitted rather than `undefined`.
 */
export function assertStepDeclaration(
  value: unknown,
  label = "value"
): asserts value is StepDeclaration {
  const objectValue = assertPlainObject(value, label);
  assertAllowedObjectKeys(
    objectValue,
    ["deterministic", "id", "metadata", "sideEffects"],
    label
  );

  assertOptionalFieldIsOmittedWhenUndefined(objectValue, "metadata", label);
  assertNonEmptyString(objectValue.id, `${label}.id`);
  assertBoolean(objectValue.deterministic, `${label}.deterministic`);
  assertBoolean(objectValue.sideEffects, `${label}.sideEffects`);

  if (objectValue.metadata !== undefined) {
    assertKernelRecord(objectValue.metadata, `${label}.metadata`);
  }
}

/**
 * True when `value` is a valid {@link ObserveResult}.
 */
export function isObserveResult(value: unknown): value is ObserveResult {
  return tryAssert(value, assertObserveResult);
}

/**
 * Asserts a valid {@link ObserveResult} (kernel spec §6.4): `annotations` as
 * plain-object kernel records, `signals` as kernel records.
 */
export function assertObserveResult(
  value: unknown,
  label = "value"
): asserts value is ObserveResult {
  const objectValue = assertPlainObject(value, label);
  assertAllowedObjectKeys(objectValue, ["annotations", "signals"], label);

  assertKernelObjectArray(objectValue.annotations, `${label}.annotations`);
  assertKernelRecordArray(objectValue.signals, `${label}.signals`);
}

/**
 * True when `value` is a valid {@link VerdictDisposition}.
 */
export function isVerdictDisposition(
  value: unknown
): value is VerdictDisposition {
  return isStringLiteral(value, VERDICT_DISPOSITIONS);
}

/**
 * Asserts a valid {@link VerdictDisposition} (kernel spec §6.1).
 */
export function assertVerdictDisposition(
  value: unknown,
  label = "value"
): asserts value is VerdictDisposition {
  if (!isVerdictDisposition(value)) {
    throw validationError(
      `${label} must be one of ${VERDICT_DISPOSITIONS.join(", ")}`,
      "invalid_verdict_disposition",
      { value }
    );
  }
}

/**
 * True when `value` is a valid {@link Verdict}.
 */
export function isVerdict(value: unknown): value is Verdict {
  return tryAssert(value, assertVerdict);
}

/**
 * Asserts a valid {@link Verdict} (kernel spec §6.1), dispatching on `kind` to
 * the per-variant shape guard (`proceed`, `abort`, `modify`, `pause`,
 * `retry`).
 *
 * @throws TuvrenValidationError With code `invalid_verdict_kind` for unknown
 *   kinds, or the variant guard's error for malformed payloads.
 */
export function assertVerdict(
  value: unknown,
  label = "value"
): asserts value is Verdict {
  const objectValue = assertPlainObject(value, label);
  const kind = objectValue.kind;

  if (kind === "proceed") {
    assertProceedVerdict(objectValue, label);
    return;
  }

  if (kind === "abort") {
    assertAbortVerdict(objectValue, label);
    return;
  }

  if (kind === "modify") {
    assertModifyVerdict(objectValue, label);
    return;
  }

  if (kind === "pause") {
    assertPauseVerdict(objectValue, label);
    return;
  }

  if (kind === "retry") {
    assertRetryVerdict(objectValue, label);
    return;
  }

  throw validationError(
    `${label}.kind must be one of proceed, abort, modify, pause, retry`,
    "invalid_verdict_kind",
    { value: kind }
  );
}

/**
 * True when `value` is a valid {@link ComposedVerdict}.
 */
export function isComposedVerdict(value: unknown): value is ComposedVerdict {
  return tryAssert(value, assertComposedVerdict);
}

/**
 * Asserts a valid {@link ComposedVerdict}. Structurally identical to
 * {@link assertVerdict}; composition (kernel spec §6.2) does not change the
 * shape.
 */
export function assertComposedVerdict(
  value: unknown,
  label = "value"
): asserts value is ComposedVerdict {
  assertVerdict(value, label);
}

/**
 * True when `value` is a valid {@link StagedResultStatus}.
 */
export function isStagedResultStatus(
  value: unknown
): value is StagedResultStatus {
  return isStringLiteral(value, STAGED_RESULT_STATUSES);
}

/**
 * Asserts a valid {@link StagedResultStatus} (kernel spec §3.4).
 */
export function assertStagedResultStatus(
  value: unknown,
  label = "value"
): asserts value is StagedResultStatus {
  if (!isStagedResultStatus(value)) {
    throw validationError(
      `${label} must be one of ${STAGED_RESULT_STATUSES.join(", ")}`,
      "invalid_staged_result_status",
      { value }
    );
  }
}

/**
 * True when `value` is a valid {@link RunStatus}.
 */
export function isRunStatus(value: unknown): value is RunStatus {
  return isStringLiteral(value, RUN_STATUSES);
}

/**
 * Asserts a valid {@link RunStatus} (kernel spec §5.2).
 */
export function assertRunStatus(
  value: unknown,
  label = "value"
): asserts value is RunStatus {
  if (!isRunStatus(value)) {
    throw validationError(
      `${label} must be one of ${RUN_STATUSES.join(", ")}`,
      "invalid_run_status",
      { value }
    );
  }
}

/**
 * True when `value` is a valid {@link RunCompletionStatus}.
 */
export function isRunCompletionStatus(
  value: unknown
): value is RunCompletionStatus {
  return isStringLiteral(value, RUN_COMPLETION_STATUSES);
}

/**
 * Asserts a valid {@link RunCompletionStatus} — the statuses `run.complete`
 * accepts (kernel spec §5.8).
 */
export function assertRunCompletionStatus(
  value: unknown,
  label = "value"
): asserts value is RunCompletionStatus {
  if (!isRunCompletionStatus(value)) {
    throw validationError(
      `${label} must be one of ${RUN_COMPLETION_STATUSES.join(", ")}`,
      "invalid_run_completion_status",
      { value }
    );
  }
}

/**
 * Asserts a valid schema path: a non-empty, dot-separated string with non-empty
 * segments (kernel spec §3.1).
 *
 * @throws TuvrenValidationError With code `invalid_schema_path`.
 */
export function assertSchemaPath(
  value: unknown,
  label: string
): asserts value is string {
  assertNonEmptyString(value, label);

  const segments = value.split(".");

  if (segments.some((segment) => segment.length === 0)) {
    throw validationError(
      `${label} must be a dot-separated path with non-empty segments`,
      "invalid_schema_path",
      { value }
    );
  }
}

/**
 * Validates path-map shape (schema paths mapped to {@link PathValue}s) and
 * returns a null-prototype copy. Schema pairing is checked separately by
 * `assertTurnTreePathMapMatchesSchema`.
 */
function assertTurnTreePathMap(
  value: unknown,
  label: string
): Record<string, PathValue> {
  const objectValue = assertPlainObject(value, label);
  const validatedPathMap: Record<string, PathValue> = Object.create(null);

  for (const [path, pathValue] of Object.entries(objectValue)) {
    assertSchemaPath(path, `${label} path`);
    assertPathValue(pathValue, `${label}.${path}`);
    validatedPathMap[path] = pathValue;
  }

  return validatedPathMap;
}

/**
 * Validates a path map against a schema: every present path must be
 * schema-defined and match its collection kind; when `requireFullManifest` is
 * set, every schema path must also be present (kernel spec §3.2).
 */
function assertTurnTreePathMapMatchesSchema(
  value: Record<string, PathValue>,
  schema: TurnTreeSchema,
  label: string,
  requireFullManifest: boolean
): void {
  const pathDefinitions = new Map(
    schema.paths.map((definition) => [definition.path, definition.collection])
  );

  if (requireFullManifest) {
    for (const pathDefinition of schema.paths) {
      if (!Object.hasOwn(value, pathDefinition.path)) {
        throw validationError(
          `${label}.${pathDefinition.path} must be present in a full TurnTree manifest`,
          "missing_turn_tree_path",
          { path: pathDefinition.path, schemaId: schema.schemaId }
        );
      }
    }
  }

  for (const [path, pathValue] of Object.entries(value)) {
    const collectionKind = pathDefinitions.get(path);

    if (collectionKind === undefined) {
      throw validationError(
        `${label}.${path} must reference a schema-defined path`,
        "unknown_turn_tree_path",
        { path, schemaId: schema.schemaId }
      );
    }

    assertPathValueForCollectionKind(
      pathValue,
      collectionKind,
      `${label}.${path}`
    );
  }
}

/**
 * Shape guard for the `proceed` verdict variant: `kind` only.
 */
function assertProceedVerdict(
  value: Record<string, unknown>,
  label: string
): void {
  assertAllowedObjectKeys(value, ["kind"], label);

  if (value.kind !== "proceed") {
    throw validationError(
      `${label}.kind must be "proceed"`,
      "invalid_verdict_kind",
      { value: value.kind }
    );
  }
}

/**
 * Shape guard for the `abort` verdict variant: disposition and non-empty
 * reason.
 */
function assertAbortVerdict(
  value: Record<string, unknown>,
  label: string
): void {
  assertAllowedObjectKeys(value, ["disposition", "kind", "reason"], label);

  if (value.kind !== "abort") {
    throw validationError(
      `${label}.kind must be "abort"`,
      "invalid_verdict_kind",
      { value: value.kind }
    );
  }

  assertVerdictDisposition(value.disposition, `${label}.disposition`);
  assertNonEmptyString(value.reason, `${label}.reason`);
}

/**
 * Shape guard for the `modify` verdict variant: an opaque KernelRecord
 * transform.
 */
function assertModifyVerdict(
  value: Record<string, unknown>,
  label: string
): void {
  assertAllowedObjectKeys(value, ["kind", "transform"], label);

  if (value.kind !== "modify") {
    throw validationError(
      `${label}.kind must be "modify"`,
      "invalid_verdict_kind",
      { value: value.kind }
    );
  }

  assertKernelRecord(value.transform, `${label}.transform`);
}

/**
 * Shape guard for the `pause` verdict variant: non-empty reason and an opaque
 * resumption schema.
 */
function assertPauseVerdict(
  value: Record<string, unknown>,
  label: string
): void {
  assertAllowedObjectKeys(value, ["kind", "reason", "resumptionSchema"], label);

  if (value.kind !== "pause") {
    throw validationError(
      `${label}.kind must be "pause"`,
      "invalid_verdict_kind",
      { value: value.kind }
    );
  }

  assertNonEmptyString(value.reason, `${label}.reason`);
  assertKernelRecord(value.resumptionSchema, `${label}.resumptionSchema`);
}

/**
 * Shape guard for the `retry` verdict variant: an opaque KernelRecord
 * adjustment.
 */
function assertRetryVerdict(
  value: Record<string, unknown>,
  label: string
): void {
  assertAllowedObjectKeys(value, ["adjustment", "kind"], label);

  if (value.kind !== "retry") {
    throw validationError(
      `${label}.kind must be "retry"`,
      "invalid_verdict_kind",
      { value: value.kind }
    );
  }

  assertKernelRecord(value.adjustment, `${label}.adjustment`);
}

/**
 * Validates schema path definitions: dot-separated paths, valid collection
 * kinds, optional KernelRecord `metadata`, and no duplicate paths (kernel spec
 * §3.1).
 */
function assertPathDefinitions(
  value: unknown,
  label: string
): asserts value is PathDefinition[] {
  const definitions = assertArray(value, label);
  const seenPaths = new Set<string>();

  for (const [index, definition] of definitions.entries()) {
    const definitionLabel = `${label}[${index}]`;
    const objectValue = assertPlainObject(definition, definitionLabel);
    assertAllowedObjectKeys(
      objectValue,
      ["collection", "metadata", "path"],
      definitionLabel
    );

    assertSchemaPath(objectValue.path, `${definitionLabel}.path`);
    assertPathCollectionKind(
      objectValue.collection,
      `${definitionLabel}.collection`
    );

    assertOptionalFieldIsOmittedWhenUndefined(
      objectValue,
      "metadata",
      definitionLabel
    );
    if (objectValue.metadata !== undefined) {
      assertKernelRecord(objectValue.metadata, `${definitionLabel}.metadata`);
    }

    if (seenPaths.has(objectValue.path)) {
      throw validationError(
        `${label} must not contain duplicate schema paths`,
        "duplicate_schema_path",
        { path: objectValue.path }
      );
    }

    seenPaths.add(objectValue.path);
  }
}

/**
 * Validates incorporation rules: every `targetPath` must reference a defined
 * schema path and `objectType` mappings must be unique (kernel spec §3.1).
 */
function assertIncorporationRules(
  value: unknown,
  pathDefinitions: PathDefinition[],
  label: string
): void {
  const rules = assertArray(value, label);
  const seenObjectTypes = new Set<string>();
  const knownPaths = new Set(pathDefinitions.map(({ path }) => path));

  for (const [index, rule] of rules.entries()) {
    const ruleLabel = `${label}[${index}]`;
    const objectValue = assertPlainObject(rule, ruleLabel);
    assertAllowedObjectKeys(
      objectValue,
      ["objectType", "targetPath"],
      ruleLabel
    );

    assertNonEmptyString(objectValue.objectType, `${ruleLabel}.objectType`);
    assertNonEmptyString(objectValue.targetPath, `${ruleLabel}.targetPath`);

    if (!knownPaths.has(objectValue.targetPath)) {
      throw validationError(
        `${ruleLabel}.targetPath must reference a defined schema path`,
        "unknown_incorporation_target_path",
        { targetPath: objectValue.targetPath }
      );
    }

    if (seenObjectTypes.has(objectValue.objectType)) {
      throw validationError(
        `${label} must not contain duplicate objectType mappings`,
        "duplicate_incorporation_object_type",
        { objectType: objectValue.objectType }
      );
    }

    seenObjectTypes.add(objectValue.objectType);
  }
}

/**
 * Untangles the `assertTurnTreeManifest` overloads: the second argument may be
 * a diagnostic label or a schema to validate against.
 */
function resolveSchemaAndLabel(
  schemaOrLabel: string | TurnTreeSchema | undefined,
  label: string,
  schemaLabel: string
): {
  resolvedLabel: string;
  schema?: TurnTreeSchema;
} {
  if (schemaOrLabel === undefined) {
    return { resolvedLabel: label };
  }

  if (typeof schemaOrLabel === "string") {
    return { resolvedLabel: schemaOrLabel };
  }

  assertTurnTreeSchema(schemaOrLabel, schemaLabel);
  return {
    resolvedLabel: label,
    schema: schemaOrLabel,
  };
}
