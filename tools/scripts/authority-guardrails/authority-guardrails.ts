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

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface AuthorityPacketManifest {
  authoritativeSources: Array<{
    format: string;
    path: string;
  }>;
  conformancePlans?: Array<{
    path: string;
    planId: string;
  }>;
  forbiddenAuthoritySources: string[];
  freshnessChecks?: Array<{
    artifact: string;
    regenerateCommand: string;
  }>;
  generatedArtifacts?: Array<{
    generatedFrom: string;
    path: string;
  }>;
  packetId: string;
}

interface GuardrailFailure {
  check: string;
  message: string;
}

interface FileSnapshot {
  content: string;
  relativePath: string;
}

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const BOUNDARIES_ROOT = resolve(REPO_ROOT, "boundaries");
const COMPATIBILITY_EVIDENCE_ROOT = resolve(
  REPO_ROOT,
  "reports/compatibility/evidence"
);
const FIXTURE_ROOT = resolve(
  REPO_ROOT,
  "tools/scripts/authority-guardrails/__fixtures__"
);
const ROOT_TESTS_ROOT = resolve(REPO_ROOT, "tests");
const FRAMEWORK_TYPESCRIPT_ROOT =
  "boundaries/framework/implementations/typescript";
const TYPESCRIPT_OWNED_CONFORMANCE_PATTERNS: readonly RegExp[] = [
  /@tuvren\/framework-testkit/u,
  /\bframeworkStreamTestFixtures\b/u,
  /(?:\.\.\/)+testkit/u,
];
const TYPESCRIPT_OWNED_FRAMEWORK_FIXTURE_PATTERNS: readonly RegExp[] = [
  /\bframeworkStreamTestFixtures\b/u,
  /\bFrameworkStreamTestFixtureSet\b/u,
  /framework-conformance-fixtures/u,
];
const ROOT_TUVREN_IMPORT_PATTERN = /@tuvren\//u;
const RUNNER_AGUI_EVENT_ENUM_PATTERN = /\bEventType\.[A-Z_]+\b/u;
const CALLABLES_NAMESPACE_PATTERN = /\bcallables\b/u;
const FORBIDDEN_RUNNER_OR_ADAPTER_TOKENS: readonly string[] = [
  "assertionResults",
  "checkId",
  "createCheckResult",
  "createConformanceEvidence",
  "emitEvidence",
  "failedChecks",
  "passedChecks",
  "requiredEvidence",
];
const FORBIDDEN_VOCABULARY_PATTERNS: readonly RegExp[] = [
  /\bPromise\b/u,
  /\bAsyncIterable\b/u,
  /\bAbortSignal\b/u,
  /\bUint8Array\b/u,
  /\bBuffer\b/u,
  /\bVec<u8>\b/u,
  /\breact_driver_[a-z0-9_]*\b/u,
  /\brust_framework_[a-z0-9_]*\b/u,
  /\btypescript_framework_[a-z0-9_]*\b/u,
];
const GENERIC_RUNNER_LITERAL_ALLOWLIST = new Set([
  "completed",
  "end_turn",
  "error",
  "fail",
  "failed",
  "paused",
]);

await main();

async function main(): Promise<void> {
  const manifests = await loadAuthorityPackets();
  const failures = [
    ...checkFreshnessDeclarations(manifests),
    ...(await checkFreshnessDrift(manifests)),
    ...(await checkForbiddenAuthorityEvidence(manifests)),
    ...(await checkRootTypescriptFixtures()),
    ...(await checkTypescriptOwnedConformanceSources()),
    ...(await checkTypescriptOwnedFrameworkFixtures()),
    ...(await checkPlanEvidenceOracleShapes(manifests)),
    ...(await checkRunnerOracleLiterals(manifests)),
    ...(await checkForbiddenVocabulary(manifests)),
    ...(await runFixtureSelfTests()),
  ];

  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(`${failure.check}: ${failure.message}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log("authority guardrails passed");
}

async function loadAuthorityPackets(): Promise<AuthorityPacketManifest[]> {
  const manifestPaths = await findFiles(
    BOUNDARIES_ROOT,
    "authority-packet.json"
  );
  const manifests: AuthorityPacketManifest[] = [];

  for (const manifestPath of manifestPaths) {
    const value: unknown = JSON.parse(await readFile(manifestPath, "utf8"));

    if (isAuthorityPacketManifest(value)) {
      manifests.push(value);
    }
  }

  return manifests;
}

function checkFreshnessDeclarations(
  manifests: readonly AuthorityPacketManifest[]
): GuardrailFailure[] {
  const failures: GuardrailFailure[] = [];

  for (const manifest of manifests) {
    const freshnessChecks = new Map(
      (manifest.freshnessChecks ?? []).map((check) => [check.artifact, check])
    );

    for (const artifact of manifest.generatedArtifacts ?? []) {
      if (!existsSync(resolve(REPO_ROOT, artifact.path))) {
        failures.push({
          check: "freshness-check",
          message: `${manifest.packetId} generated artifact is missing: ${artifact.path}`,
        });
      }

      const check = freshnessChecks.get(artifact.path);

      if (check === undefined || check.regenerateCommand.trim().length === 0) {
        failures.push({
          check: "freshness-check",
          message: `${manifest.packetId} generated artifact lacks regenerate command: ${artifact.path}`,
        });
      }
    }
  }

  return failures;
}

async function checkFreshnessDrift(
  manifests: readonly AuthorityPacketManifest[]
): Promise<GuardrailFailure[]> {
  const failures: GuardrailFailure[] = [];

  for (const manifest of manifests) {
    for (const check of manifest.freshnessChecks ?? []) {
      const artifactPath = resolve(REPO_ROOT, check.artifact);

      if (!existsSync(artifactPath)) {
        continue;
      }

      const before = await snapshotPath(artifactPath);
      const result = await runRegenerateCommand(check.regenerateCommand);
      const after = await snapshotPath(artifactPath);

      if (!result.ok) {
        failures.push({
          check: "freshness-check",
          message: `${manifest.packetId} regenerate command failed for ${check.artifact}: ${result.message}`,
        });
        continue;
      }

      if (!snapshotsAreEqual(before, after)) {
        failures.push({
          check: "freshness-check",
          message: `${manifest.packetId} generated artifact drifted after ${check.regenerateCommand}: ${check.artifact}`,
        });
      }
    }
  }

  return failures;
}

async function checkForbiddenAuthorityEvidence(
  manifests: readonly AuthorityPacketManifest[]
): Promise<GuardrailFailure[]> {
  const evidencePaths = await findFiles(COMPATIBILITY_EVIDENCE_ROOT, ".json");
  const failures: GuardrailFailure[] = [];

  for (const evidencePath of evidencePaths) {
    const evidenceText = await readFile(evidencePath, "utf8");
    failures.push(
      ...collectForbiddenAuthorityEvidenceFailures(
        evidenceText,
        relative(REPO_ROOT, evidencePath),
        manifests
      )
    );
  }

  return failures;
}

function collectForbiddenAuthorityEvidenceFailures(
  evidenceText: string,
  evidenceLabel: string,
  manifests: readonly AuthorityPacketManifest[]
): GuardrailFailure[] {
  const failures: GuardrailFailure[] = [];

  for (const manifest of manifests) {
    for (const forbiddenSource of manifest.forbiddenAuthoritySources) {
      if (forbiddenSource.length <= 4) {
        continue;
      }

      if (evidenceText.includes(forbiddenSource)) {
        failures.push({
          check: "forbidden-authority-source",
          message: `${evidenceLabel} cites forbidden authority source ${forbiddenSource} for ${manifest.packetId}`,
        });
      }
    }
  }

  return failures;
}

async function checkRunnerOracleLiterals(
  manifests: readonly AuthorityPacketManifest[]
): Promise<GuardrailFailure[]> {
  const failures: GuardrailFailure[] = [];
  const planCheckIds = await collectPlanCheckIds(manifests);
  const planOperationNames = await collectPlanOperationNames(manifests);
  const planAssertionLiterals = await collectPlanAssertionLiterals(manifests);
  const conformanceSourceRoots = await findConformanceSourceRoots();

  for (const runnerRoot of conformanceSourceRoots) {
    const sourcePaths = await findSourceFiles(resolve(REPO_ROOT, runnerRoot));

    for (const sourcePath of sourcePaths) {
      failures.push(
        ...(await checkRunnerSourceFile(
          sourcePath,
          planCheckIds,
          planOperationNames,
          planAssertionLiterals
        ))
      );
    }
  }

  return failures;
}

async function checkPlanEvidenceOracleShapes(
  manifests: readonly AuthorityPacketManifest[]
): Promise<GuardrailFailure[]> {
  const failures: GuardrailFailure[] = [];

  for (const manifest of manifests) {
    for (const plan of manifest.conformancePlans ?? []) {
      const planValue: unknown = JSON.parse(
        await readFile(resolve(REPO_ROOT, plan.path), "utf8")
      );
      failures.push(
        ...collectPlanEvidenceOracleShapeFailures(planValue, plan.path)
      );
    }
  }

  return failures;
}

async function checkRootTypescriptFixtures(): Promise<GuardrailFailure[]> {
  const sourcePaths = await findSourceFiles(ROOT_TESTS_ROOT);
  const failures: GuardrailFailure[] = [];

  for (const sourcePath of sourcePaths) {
    const source = await readFile(sourcePath, "utf8");
    const sourceLabel = relative(REPO_ROOT, sourcePath);

    if (ROOT_TUVREN_IMPORT_PATTERN.test(source)) {
      failures.push({
        check: "root-typescript-fixture",
        message: `${sourceLabel} imports a Tuvren TypeScript package; root tests must not own reusable contract or conformance fixtures`,
      });
    }
  }

  return failures;
}

async function checkTypescriptOwnedConformanceSources(): Promise<
  GuardrailFailure[]
> {
  const failures: GuardrailFailure[] = [];
  const conformanceSourceRoots = await findConformanceSourceRoots();

  for (const runnerRoot of conformanceSourceRoots) {
    const sourcePaths = await findSourceFiles(resolve(REPO_ROOT, runnerRoot));

    for (const sourcePath of sourcePaths) {
      const source = await readFile(sourcePath, "utf8");
      failures.push(
        ...collectTypescriptOwnedConformanceFailures(
          source,
          relative(REPO_ROOT, sourcePath)
        )
      );
    }
  }

  return failures;
}

async function checkTypescriptOwnedFrameworkFixtures(): Promise<
  GuardrailFailure[]
> {
  const sourcePaths = await findSourceFiles(
    resolve(REPO_ROOT, FRAMEWORK_TYPESCRIPT_ROOT)
  );
  const failures: GuardrailFailure[] = [];

  for (const sourcePath of sourcePaths) {
    const source = await readFile(sourcePath, "utf8");
    failures.push(
      ...collectTypescriptOwnedFrameworkFixtureFailures(
        source,
        relative(REPO_ROOT, sourcePath)
      )
    );
  }

  return failures;
}

function collectTypescriptOwnedConformanceFailures(
  source: string,
  sourceLabel: string
): GuardrailFailure[] {
  const failures: GuardrailFailure[] = [];

  for (const pattern of TYPESCRIPT_OWNED_CONFORMANCE_PATTERNS) {
    if (pattern.test(source)) {
      failures.push({
        check: "typescript-owned-conformance-source",
        message: `${sourceLabel} cites TypeScript-owned testkit fixtures; promoted runner source must load boundary conformance-plan fixtures`,
      });
    }
  }

  return failures;
}

function collectTypescriptOwnedFrameworkFixtureFailures(
  source: string,
  sourceLabel: string
): GuardrailFailure[] {
  const failures: GuardrailFailure[] = [];

  for (const pattern of TYPESCRIPT_OWNED_FRAMEWORK_FIXTURE_PATTERNS) {
    if (pattern.test(source)) {
      failures.push({
        check: "typescript-owned-framework-fixture",
        message: `${sourceLabel} contains a TypeScript-owned framework conformance fixture facade; use boundary conformance-plan fixtures instead`,
      });
    }
  }

  return failures;
}

async function collectPlanCheckIds(
  manifests: readonly AuthorityPacketManifest[]
): Promise<Set<string>> {
  const planCheckIds = new Set<string>();

  for (const manifest of manifests) {
    for (const plan of manifest.conformancePlans ?? []) {
      const planValue: unknown = JSON.parse(
        await readFile(resolve(REPO_ROOT, plan.path), "utf8")
      );

      collectCheckIdsFromPlanValue(planValue, planCheckIds);
    }
  }

  return planCheckIds;
}

async function collectPlanAssertionLiterals(
  manifests: readonly AuthorityPacketManifest[]
): Promise<Set<string>> {
  const literals = new Set<string>();

  for (const manifest of manifests) {
    for (const plan of manifest.conformancePlans ?? []) {
      const planValue: unknown = JSON.parse(
        await readFile(resolve(REPO_ROOT, plan.path), "utf8")
      );

      collectAssertionLiteralsFromPlanValue(planValue, literals);
    }
  }

  return literals;
}

async function collectPlanOperationNames(
  manifests: readonly AuthorityPacketManifest[]
): Promise<Set<string>> {
  const operationNames = new Set<string>();

  for (const manifest of manifests) {
    for (const plan of manifest.conformancePlans ?? []) {
      const planValue: unknown = JSON.parse(
        await readFile(resolve(REPO_ROOT, plan.path), "utf8")
      );

      collectOperationNamesFromPlanValue(planValue, operationNames);
    }
  }

  return operationNames;
}

function collectCheckIdsFromPlanValue(
  planValue: unknown,
  planCheckIds: Set<string>
): void {
  if (!(isRecord(planValue) && Array.isArray(planValue.checks))) {
    return;
  }

  for (const check of planValue.checks) {
    if (isRecord(check) && typeof check.checkId === "string") {
      planCheckIds.add(check.checkId);
    }
  }
}

function collectAssertionLiteralsFromPlanValue(
  planValue: unknown,
  literals: Set<string>
): void {
  if (!(isRecord(planValue) && Array.isArray(planValue.checks))) {
    return;
  }

  for (const check of planValue.checks) {
    if (!isRecord(check)) {
      continue;
    }

    collectAssertionLiteralsFromAssertions(check.assertions, literals);

    for (const step of readPlanSteps(check)) {
      collectAssertionLiteralsFromAssertions(step.assertions, literals);
    }
  }
}

function collectAssertionLiteralsFromAssertions(
  assertions: unknown,
  literals: Set<string>
): void {
  if (!Array.isArray(assertions)) {
    return;
  }

  for (const assertion of assertions) {
    if (!isRecord(assertion)) {
      continue;
    }

    collectStringLiterals(assertion.equals, literals);
    collectStringLiterals(assertion.contains, literals);
    collectStringLiterals(assertion.eventType, literals);
  }
}

function collectOperationNamesFromPlanValue(
  planValue: unknown,
  operationNames: Set<string>
): void {
  if (!(isRecord(planValue) && Array.isArray(planValue.checks))) {
    return;
  }

  for (const check of planValue.checks) {
    if (!isRecord(check)) {
      continue;
    }

    if (typeof check.operation === "string") {
      operationNames.add(check.operation);
    }

    for (const step of readPlanSteps(check)) {
      if (typeof step.operation === "string") {
        operationNames.add(step.operation);
      }
    }
  }
}

function collectPlanEvidenceOracleShapeFailures(
  planValue: unknown,
  planLabel: string
): GuardrailFailure[] {
  const failures: GuardrailFailure[] = [];

  if (!(isRecord(planValue) && Array.isArray(planValue.checks))) {
    return failures;
  }

  for (const check of planValue.checks) {
    if (!isRecord(check)) {
      continue;
    }

    failures.push(
      ...collectEvidencePathOracleFailures(check, planLabel),
      ...collectAssertionOracleFailures(check, planLabel),
      ...collectFixtureSelfCertificationFailures(check, planLabel),
      ...readPlanSteps(check).flatMap((step) =>
        collectAssertionOracleFailures(
          {
            ...step,
            checkId: `${String(check.checkId)}.${String(step.stepId)}`,
          },
          planLabel
        )
      ),
      ...readPlanSteps(check).flatMap((step) =>
        collectFixtureSelfCertificationFailures(
          {
            ...check,
            ...step,
            checkId: `${String(check.checkId)}.${String(step.stepId)}`,
          },
          planLabel
        )
      )
    );
  }

  return failures;
}

function readPlanSteps(
  check: Record<string, unknown>
): Record<string, unknown>[] {
  if (!Array.isArray(check.steps)) {
    return [];
  }

  return check.steps.filter(isRecord);
}

function collectFixtureSelfCertificationFailures(
  check: Record<string, unknown>,
  planLabel: string
): GuardrailFailure[] {
  const operation =
    typeof check.operation === "string" ? check.operation : undefined;

  if (operation?.endsWith(".fixture-events") === true) {
    return [
      {
        check: "plan-self-certification",
        message: `${planLabel} check ${String(check.checkId)} replays authority fixture events as implementation conformance`,
      },
    ];
  }

  if (
    check.fixture !== undefined &&
    operation?.startsWith("event-stream.") === true
  ) {
    return [
      {
        check: "plan-self-certification",
        message: `${planLabel} check ${String(check.checkId)} uses fixture input for event-stream implementation conformance; event-stream checks must consume implementation-emitted events`,
      },
    ];
  }

  if (
    check.fixture !== undefined &&
    Array.isArray(check.assertions) &&
    check.assertions.length > 0 &&
    check.assertions.every(isFixtureEventAssertion)
  ) {
    return [
      {
        check: "plan-self-certification",
        message: `${planLabel} check ${String(check.checkId)} asserts only fixture event shape; fixture validation must not count as implementation conformance`,
      },
    ];
  }

  return [];
}

function isFixtureEventAssertion(assertion: unknown): boolean {
  if (!isRecord(assertion)) {
    return false;
  }

  return (
    assertion.kind === "eventSequence" ||
    assertion.kind === "terminalEvent" ||
    assertion.kind === "ordering" ||
    assertion.kind === "noEvent"
  );
}

function collectEvidencePathOracleFailures(
  check: Record<string, unknown>,
  planLabel: string
): GuardrailFailure[] {
  if (!Array.isArray(check.evidence)) {
    return [];
  }

  return check.evidence
    .filter(
      (evidencePath): evidencePath is string =>
        typeof evidencePath === "string" && isBooleanOraclePath(evidencePath)
    )
    .map((evidencePath) => ({
      check: "plan-oracle-shape",
      message: `${planLabel} check ${String(check.checkId)} declares boolean-oracle evidence path ${evidencePath}`,
    }));
}

function collectAssertionOracleFailures(
  check: Record<string, unknown>,
  planLabel: string
): GuardrailFailure[] {
  if (!Array.isArray(check.assertions)) {
    return [];
  }

  return check.assertions.flatMap((assertion) =>
    isRecord(assertion)
      ? collectSingleAssertionOracleFailures(assertion, check, planLabel)
      : []
  );
}

function collectSingleAssertionOracleFailures(
  assertion: Record<string, unknown>,
  check: Record<string, unknown>,
  planLabel: string
): GuardrailFailure[] {
  const assertionKind = assertion.kind;

  if (assertionKind !== "evidenceField" && assertionKind !== "stateField") {
    return [];
  }

  const failures: GuardrailFailure[] = [];
  const field =
    typeof assertion.field === "string" ? assertion.field : undefined;

  if (field !== undefined && isBooleanOraclePath(field)) {
    failures.push({
      check: "plan-oracle-shape",
      message: `${planLabel} check ${String(check.checkId)} asserts boolean-oracle field ${field}`,
    });
  }

  if (typeof assertion.equals === "boolean") {
    failures.push({
      check: "plan-oracle-shape",
      message: `${planLabel} check ${String(check.checkId)} asserts bare boolean evidence/state; promoted plans must assert raw observed values`,
    });
  }

  return failures;
}

function collectStringLiterals(value: unknown, literals: Set<string>): void {
  if (typeof value === "string") {
    if (value.length >= 3 && !GENERIC_RUNNER_LITERAL_ALLOWLIST.has(value)) {
      literals.add(value);
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectStringLiterals(item, literals);
    }
    return;
  }

  if (isRecord(value)) {
    for (const item of Object.values(value)) {
      collectStringLiterals(item, literals);
    }
  }
}

async function checkRunnerSourceFile(
  sourcePath: string,
  planCheckIds: ReadonlySet<string>,
  planOperationNames: ReadonlySet<string>,
  planAssertionLiterals: ReadonlySet<string>
): Promise<GuardrailFailure[]> {
  const source = await readFile(sourcePath, "utf8");
  return checkRunnerSourceText(
    source,
    relative(REPO_ROOT, sourcePath),
    planCheckIds,
    planOperationNames,
    planAssertionLiterals
  );
}

function checkRunnerSourceText(
  source: string,
  sourceLabel: string,
  planCheckIds: ReadonlySet<string>,
  planOperationNames: ReadonlySet<string>,
  planAssertionLiterals: ReadonlySet<string>
): GuardrailFailure[] {
  const failures: GuardrailFailure[] = [
    ...collectForbiddenRunnerOrAdapterTokenFailures(source, sourceLabel),
    ...collectRunnerCheckIdFailures(source, sourceLabel, planCheckIds),
    ...(sourceLabel.includes("/conformance-runner/")
      ? collectRunnerAssertionLiteralFailures(
          source,
          sourceLabel,
          planAssertionLiterals
        )
      : []),
    ...collectRunnerOperationLiteralFailures(
      source,
      sourceLabel,
      planOperationNames
    ),
  ];

  if (CALLABLES_NAMESPACE_PATTERN.test(source)) {
    failures.push({
      check: "runner-oracle",
      message: `${sourceLabel} embeds callables boolean-evidence namespace; promoted plans must assert raw observations`,
    });
  }

  if (RUNNER_AGUI_EVENT_ENUM_PATTERN.test(source)) {
    failures.push({
      check: "runner-oracle",
      message: `${sourceLabel} embeds AG-UI semantic event enum constants; runner source must read expected event names from plans`,
    });
  }

  if (source.includes("AUTHORITY_ORACLE_FIXTURE")) {
    failures.push({
      check: "runner-oracle",
      message: `${sourceLabel} contains a runner-oracle fixture marker`,
    });
  }

  return failures;
}

function collectForbiddenRunnerOrAdapterTokenFailures(
  source: string,
  sourceLabel: string
): GuardrailFailure[] {
  return FORBIDDEN_RUNNER_OR_ADAPTER_TOKENS.filter((token) =>
    source.includes(token)
  ).map((token) => ({
    check: "runner-or-adapter-authority",
    message: `${sourceLabel} embeds ${token}; runner and adapter roots must not own check-scoped grading, required-evidence, or compatibility evidence semantics`,
  }));
}

function collectRunnerCheckIdFailures(
  source: string,
  sourceLabel: string,
  planCheckIds: ReadonlySet<string>
): GuardrailFailure[] {
  const failures: GuardrailFailure[] = [];

  for (const checkId of planCheckIds) {
    if (source.includes(checkId)) {
      failures.push({
        check: "runner-oracle",
        message: `${sourceLabel} embeds conformance-plan check id ${checkId}; runner source must load plan data instead`,
      });
    }
  }

  return failures;
}

function collectRunnerAssertionLiteralFailures(
  source: string,
  sourceLabel: string,
  planAssertionLiterals: ReadonlySet<string>
): GuardrailFailure[] {
  const failures: GuardrailFailure[] = [];

  for (const literal of planAssertionLiterals) {
    if (source.includes(JSON.stringify(literal))) {
      failures.push({
        check: "runner-oracle",
        message: `${sourceLabel} embeds conformance-plan assertion literal ${literal}; runner source must load semantic expectations from plans`,
      });
    }
  }

  return failures;
}

function collectRunnerOperationLiteralFailures(
  source: string,
  sourceLabel: string,
  planOperationNames: ReadonlySet<string>
): GuardrailFailure[] {
  const failures: GuardrailFailure[] = [];
  const lines = source.split("\n");

  for (const operationName of planOperationNames) {
    const quotedOperation = JSON.stringify(operationName);

    for (const [index, line] of lines.entries()) {
      if (
        line.includes(quotedOperation) &&
        !isAllowedOperationRoutingLine(
          line,
          quotedOperation,
          lines[index - 2] ?? "",
          lines[index - 1] ?? "",
          lines[index + 1] ?? ""
        )
      ) {
        failures.push({
          check: "runner-oracle",
          message: `${sourceLabel}:${index + 1} embeds promoted operation ${operationName} outside generic routing/scenario validation`,
        });
      }
    }
  }

  return failures;
}

function isAllowedOperationRoutingLine(
  line: string,
  quotedOperation: string,
  twoLinesBefore: string,
  previousLine: string,
  nextLine: string
): boolean {
  return (
    line.includes(`case ${quotedOperation}:`) ||
    line.includes(`${quotedOperation} =>`) ||
    line.includes(`${quotedOperation}:`) ||
    line.includes(`readOperationScenario(input, ${quotedOperation})`) ||
    (line.includes(quotedOperation) &&
      (previousLine.includes("readOperationScenario(") ||
        twoLinesBefore.includes("readOperationScenario(")) &&
      nextLine.includes(")"))
  );
}

function isBooleanOraclePath(path: string): boolean {
  return (
    path === "$.callables" ||
    path.startsWith("$.callables.") ||
    path.startsWith("callables.")
  );
}

async function runFixtureSelfTests(): Promise<GuardrailFailure[]> {
  const failures: GuardrailFailure[] = [];

  const freshnessFixture: unknown = JSON.parse(
    await readFile(
      resolve(FIXTURE_ROOT, "freshness-drift/authority-packet.json"),
      "utf8"
    )
  );

  if (
    !isAuthorityPacketManifest(freshnessFixture) ||
    checkFreshnessDeclarations([freshnessFixture]).length === 0
  ) {
    failures.push({
      check: "guardrail-fixture",
      message:
        "freshness-drift fixture did not trigger the freshness guardrail",
    });
  }

  const evidenceFixture = await readFile(
    resolve(FIXTURE_ROOT, "forbidden-authority-evidence/evidence.json"),
    "utf8"
  );
  const evidenceFailures = collectForbiddenAuthorityEvidenceFailures(
    evidenceFixture,
    "fixture evidence",
    [
      {
        authoritativeSources: [],
        forbiddenAuthoritySources: [
          "boundaries/framework/contracts/runtime-api/implementations/typescript",
        ],
        packetId: "tuvren.fixture.forbidden-authority-evidence",
      },
    ]
  );

  if (evidenceFailures.length === 0) {
    failures.push({
      check: "guardrail-fixture",
      message:
        "forbidden-authority-evidence fixture did not trigger the evidence guardrail",
    });
  }

  const runnerFixture = await readFile(
    resolve(FIXTURE_ROOT, "runner-oracle/source.ts"),
    "utf8"
  );
  const runnerFailures = checkRunnerSourceText(
    runnerFixture,
    "fixture runner",
    new Set(),
    new Set(["runtime.fixture-operation"]),
    new Set(["turn.start"])
  );

  if (runnerFailures.length === 0) {
    failures.push({
      check: "guardrail-fixture",
      message: "runner-oracle fixture did not trigger the runner guardrail",
    });
  }

  const booleanOraclePlanFailures = collectPlanEvidenceOracleShapeFailures(
    {
      checks: [
        {
          assertions: [
            {
              equals: true,
              field: "$.callables.providerGenerate",
              kind: "evidenceField",
            },
          ],
          checkId: "fixture.boolean-oracle",
          evidence: ["callables.providerGenerate"],
        },
      ],
    },
    "fixture boolean-oracle plan"
  );

  if (booleanOraclePlanFailures.length === 0) {
    failures.push({
      check: "guardrail-fixture",
      message:
        "boolean-oracle fixture did not trigger the plan-shape guardrail",
    });
  }

  const selfCertifyingPlanFailures = collectPlanEvidenceOracleShapeFailures(
    {
      checks: [
        {
          assertions: [
            {
              equals: ["turn.start", "turn.end"],
              kind: "eventSequence",
              path: "$.type",
            },
          ],
          checkId: "fixture.self-certifying",
          fixture: "stream-events",
          operation: "event-stream.fixture-events",
        },
        {
          assertions: [
            {
              equals: ["RUN_STARTED", "RUN_FINISHED"],
              field: "$.eventTypes",
              kind: "evidenceField",
            },
          ],
          checkId: "fixture.projection-self-certifying",
          fixture: "stream-events",
          operation: "event-stream.agui-projection",
        },
      ],
    },
    "fixture self-certifying plan"
  );

  if (selfCertifyingPlanFailures.length === 0) {
    failures.push({
      check: "guardrail-fixture",
      message:
        "self-certifying fixture plan did not trigger the plan guardrail",
    });
  }

  const stepOperationNames = new Set<string>();
  collectOperationNamesFromPlanValue(
    {
      checks: [
        {
          assertions: [],
          checkId: "fixture.step-operation",
          operation: "runtime.top-level-operation",
          steps: [
            {
              operation: "runtime.step-operation",
              stepId: "step",
            },
          ],
        },
      ],
    },
    stepOperationNames
  );

  if (!stepOperationNames.has("runtime.step-operation")) {
    failures.push({
      check: "guardrail-fixture",
      message:
        "step operation fixture did not collect trace-step operation names",
    });
  }

  const stepAssertionLiterals = new Set<string>();
  collectAssertionLiteralsFromPlanValue(
    {
      checks: [
        {
          assertions: [],
          checkId: "fixture.step-assertion",
          operation: "runtime.top-level-operation",
          steps: [
            {
              assertions: [
                {
                  equals: "step-owned-literal",
                  field: "$.value",
                  kind: "evidenceField",
                },
              ],
              operation: "runtime.step-operation",
              stepId: "step",
            },
          ],
        },
      ],
    },
    stepAssertionLiterals
  );

  if (!stepAssertionLiterals.has("step-owned-literal")) {
    failures.push({
      check: "guardrail-fixture",
      message:
        "step assertion fixture did not collect trace-step assertion literals",
    });
  }

  const typescriptOwnedFixture = await readFile(
    resolve(FIXTURE_ROOT, "typescript-owned-conformance/source.ts"),
    "utf8"
  );
  const typescriptOwnedFailures = collectTypescriptOwnedConformanceFailures(
    typescriptOwnedFixture,
    "fixture runner"
  );

  if (typescriptOwnedFailures.length === 0) {
    failures.push({
      check: "guardrail-fixture",
      message:
        "typescript-owned-conformance fixture did not trigger the TypeScript ownership guardrail",
    });
  }

  const frameworkFixtureFailures =
    collectTypescriptOwnedFrameworkFixtureFailures(
      typescriptOwnedFixture,
      "fixture runner"
    );

  if (frameworkFixtureFailures.length === 0) {
    failures.push({
      check: "guardrail-fixture",
      message:
        "typescript-owned-conformance fixture did not trigger the framework fixture guardrail",
    });
  }

  const vocabularyFixture = await readFile(
    resolve(FIXTURE_ROOT, "forbidden-vocabulary/main.tsp"),
    "utf8"
  );

  if (
    !FORBIDDEN_VOCABULARY_PATTERNS.some((pattern) =>
      pattern.test(vocabularyFixture)
    )
  ) {
    failures.push({
      check: "guardrail-fixture",
      message:
        "forbidden-vocabulary fixture did not trigger the vocabulary guardrail",
    });
  }

  return failures;
}

async function checkForbiddenVocabulary(
  manifests: readonly AuthorityPacketManifest[]
): Promise<GuardrailFailure[]> {
  const failures: GuardrailFailure[] = [];

  for (const manifest of manifests) {
    for (const source of manifest.authoritativeSources) {
      if (
        source.format !== "typespec" &&
        source.format !== "conformance-plan"
      ) {
        continue;
      }

      const sourcePath = resolve(REPO_ROOT, source.path);

      if (!existsSync(sourcePath)) {
        continue;
      }

      const sourceText = await readFile(sourcePath, "utf8");

      for (const pattern of FORBIDDEN_VOCABULARY_PATTERNS) {
        if (pattern.test(sourceText)) {
          failures.push({
            check: "forbidden-vocabulary",
            message: `${manifest.packetId} authority source ${source.path} contains implementation vocabulary ${pattern.source}`,
          });
        }
      }
    }
  }

  return failures;
}

async function findFiles(
  directory: string,
  nameOrSuffix: string
): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths: string[] = [];

  for (const entry of entries) {
    const entryPath = resolve(directory, entry.name);

    if (entry.isDirectory()) {
      paths.push(...(await findFiles(entryPath, nameOrSuffix)));
      continue;
    }

    if (
      entry.isFile() &&
      (entry.name === nameOrSuffix || entry.name.endsWith(nameOrSuffix))
    ) {
      paths.push(entryPath);
    }
  }

  return paths;
}

async function findSourceFiles(directory: string): Promise<string[]> {
  if (!existsSync(directory)) {
    return [];
  }

  const paths = [
    ...(await findFiles(directory, ".rs")),
    ...(await findFiles(directory, ".ts")),
    ...(await findFiles(directory, ".tsx")),
  ];
  return paths.filter((path) => !path.endsWith(".d.ts"));
}

async function findConformanceSourceRoots(): Promise<string[]> {
  const roots = await collectConformanceSourceRoots(BOUNDARIES_ROOT);
  return roots
    .map((root) => relative(REPO_ROOT, root))
    .sort((left, right) => left.localeCompare(right));
}

async function collectConformanceSourceRoots(
  directory: string
): Promise<string[]> {
  if (!existsSync(directory)) {
    return [];
  }

  const entries = await readdir(directory, { withFileTypes: true });
  const roots: string[] = [];

  for (const entry of entries) {
    const entryPath = resolve(directory, entry.name);

    if (!entry.isDirectory()) {
      continue;
    }

    if (
      (entry.name === "conformance-runner" ||
        entry.name === "conformance-adapter") &&
      existsSync(resolve(entryPath, "src"))
    ) {
      roots.push(resolve(entryPath, "src"));
      continue;
    }

    roots.push(...(await collectConformanceSourceRoots(entryPath)));
  }

  return roots;
}

async function snapshotPath(path: string): Promise<FileSnapshot[]> {
  const entries = await collectSnapshotEntries(path, path);
  return entries.sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath)
  );
}

async function collectSnapshotEntries(
  rootPath: string,
  currentPath: string
): Promise<FileSnapshot[]> {
  const entries = await readdir(currentPath, { withFileTypes: true });
  const snapshots: FileSnapshot[] = [];

  for (const entry of entries) {
    const entryPath = resolve(currentPath, entry.name);

    if (entry.isDirectory()) {
      snapshots.push(...(await collectSnapshotEntries(rootPath, entryPath)));
      continue;
    }

    if (entry.isFile()) {
      snapshots.push({
        content: await readFile(entryPath, "utf8"),
        relativePath: relative(rootPath, entryPath),
      });
    }
  }

  return snapshots;
}

function snapshotsAreEqual(
  left: readonly FileSnapshot[],
  right: readonly FileSnapshot[]
): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((entry, index) => {
    const other = right[index];
    return (
      other !== undefined &&
      entry.relativePath === other.relativePath &&
      entry.content === other.content
    );
  });
}

function runRegenerateCommand(
  command: string
): Promise<{ message: string; ok: boolean }> {
  return new Promise((resolvePromise) => {
    // Freshness checks intentionally execute the manifest-owned command instead
    // of duplicating generator knowledge in this guardrail.
    const child = spawn(command, {
      cwd: REPO_ROOT,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output: string[] = [];

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => output.push(chunk));
    child.stderr.on("data", (chunk: string) => output.push(chunk));
    child.on("error", (error) => {
      resolvePromise({ message: error.message, ok: false });
    });
    child.on("close", (code) => {
      resolvePromise({
        message: output.join("").trim().slice(-1000),
        ok: code === 0,
      });
    });
  });
}

function isAuthorityPacketManifest(
  value: unknown
): value is AuthorityPacketManifest {
  return (
    isRecord(value) &&
    typeof value.packetId === "string" &&
    Array.isArray(value.authoritativeSources) &&
    Array.isArray(value.forbiddenAuthoritySources)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
