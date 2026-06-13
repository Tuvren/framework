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

import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import process from "node:process";

const DOC_SOURCES = [
  {
    boundary: "framework",
    claimPrefix: "FWK",
    path: "docs/KrakenFrameworkSpecification.md",
  },
  {
    boundary: "kernel",
    claimPrefix: "KER",
    path: "docs/KrakenKernelSpecification.md",
  },
] as const;

const OUTPUT_DIR = ".constitution/reports";
const INVENTORY_PATH = `${OUTPUT_DIR}/epic-ad-normative-docs-claim-inventory.json`;
const MATRIX_PATH = `${OUTPUT_DIR}/epic-ad-docs-to-authority-coverage-matrix.json`;
const SUMMARY_PATH = `${OUTPUT_DIR}/epic-ad-docs-to-authority-freeze-gate-summary.md`;
const FRAMEWORK_DECISIONS_PATH = `${OUTPUT_DIR}/epic-ad-framework-deferred-surface-decisions.md`;
const LOCAL_DECISIONS_PATH = `${OUTPUT_DIR}/epic-ad-kernel-backend-provider-local-surface-decisions.md`;
const REPORT_PATH = `${OUTPUT_DIR}/epic-ad-typescript-freeze-gate-report.md`;
const CLOSURE_PATH = `${OUTPUT_DIR}/epic-ad-docs-to-authority-freeze-gate-closure-inventory.md`;

const NORMATIVE_PATTERN =
  /\b(must|must not|should|cannot|can not|never|always|required|requires|required|guarantee|guarantees|only|canonical|authoritative|valid|invalid|deferred|MUST|SHOULD|MAY)\b|\bdoes not define\b/i;
const ANCHOR_BACKTICK_PATTERN = /`/g;
const ANCHOR_UNSAFE_CHAR_PATTERN = /[^a-z0-9\s-]/g;
const CODE_FENCE_COMMENT_PATTERN = /^\s*\/\//;
const CODE_FENCE_INLINE_COMMENT_PATTERN = /\/\/(.+)$/;
const CODE_FENCE_STRONG_NORMATIVE_PATTERN = /\b(MUST|SHOULD|MAY)\b/;
const HEADING_PATTERN = /^(#{1,6})\s+(.+)$/;
const LEADING_LIST_MARKER_PATTERN = /^\s*[-*]\s+/;
const LINE_SPLIT_PATTERN = /\r?\n/;
const LIST_ITEM_PATTERN = /^\s*(?:[-*]|\d+[.)])\s+/;
const SECTION_NUMBER_PATTERN = /^(\d+(?:\.\d+)*)\b/;
const SECTION_TRAILING_DASH_PATTERN = /-+$/g;
const SECTION_UNSAFE_CHAR_PATTERN = /[^a-z0-9]+/g;
const TABLE_ROW_PATTERN = /^\s*\|/;
const WHITESPACE_PATTERN = /\s+/g;
const EVIDENCE_PATH_PATTERN =
  /\b(?:boundaries|reports|tools|constitution)\/[^\s;,)`]+/g;
const CLAIM_ID_HASH_LENGTH = 12;
const REQUIRED_AUTHORITY_ANCHOR_FIELDS = [
  "authorityPacket",
  "conformancePlan",
  "fixture",
  "compatibilityEvidence",
] as const;

type SourceBoundary = (typeof DOC_SOURCES)[number]["boundary"];

type Classification =
  | "authority-backed-conformance-covered"
  | "implementation-local-evidence"
  | "implementation-defined"
  | "explicitly-deferred"
  | "missing-conformance-follow-up"
  | "stale-docs-corrected"
  | "unclassified";

interface DocSource {
  boundary: SourceBoundary;
  claimPrefix: string;
  path: string;
}

interface HeadingState {
  anchor: string;
  heading: string;
  level: number;
  sectionKey: string;
}

interface PendingProseBlock {
  heading: HeadingState;
  line: number;
  lines: string[];
}

interface DocParseState {
  claimedIds: Map<string, string>;
  claims: NormativeClaim[];
  headingStack: HeadingState[];
  inCodeFence: boolean;
  proseBlock: PendingProseBlock | null;
  rationaleLineCounts: Map<string, RationaleSection>;
  source: DocSource;
}

interface NormativeClaim {
  affectedBoundary: string;
  claimFingerprint: string;
  claimId: string;
  duplicateOf: string | null;
  line: number;
  rationaleContext: string;
  sectionAnchor: string;
  sectionHeading: string;
  sectionKey: string;
  sourceFile: string;
  text: string;
}

interface ClaimInventoryEntry extends NormativeClaim {
  adapterCapability: string;
  surface: string;
}

interface CoverageEntry extends ClaimInventoryEntry {
  authorityPacket: string;
  classification: Classification;
  compatibilityEvidence: string;
  conformancePlan: string;
  deferralRationale: string;
  docsCorrection: string;
  fixture: string;
  followUpTicket: string;
  generatedArtifact: string;
  implementationEvidence: string;
}

interface RationaleSection {
  affectedBoundary: string;
  nonNormativeLineCount: number;
  sectionAnchor: string;
  sectionHeading: string;
  sectionKey: string;
  sourceFile: string;
}

interface ClaimInventory {
  claims: ClaimInventoryEntry[];
  duplicateNormativeClaims: number;
  generatedBy: string;
  normativePattern: string;
  rationaleSections: RationaleSection[];
  sources: string[];
  totalIndependentClaims: number;
  totalNormativeClaims: number;
}

interface CoverageMatrix {
  duplicateClaims: number;
  entries: CoverageEntry[];
  generatedBy: string;
  primaryClassificationRule: string;
  totalClaims: number;
  totalIndependentClaims: number;
  unclassifiedClaims: number;
}

interface OutputArtifact {
  content: string;
  path: string;
}

interface EvidenceTemplate {
  adapterCapability: string;
  authorityPacket: string;
  compatibilityEvidence: string;
  conformancePlan: string;
  fixture: string;
  generatedArtifact: string;
}

const EVIDENCE = {
  driverApi: {
    adapterCapability: "framework.driver-api",
    authorityPacket:
      "boundaries/shared/contracts/core/spec/authority-packet.json",
    compatibilityEvidence:
      "reports/compatibility/evidence/shared-conformance-runner.framework-typescript-conformance-runner.json",
    conformancePlan:
      "boundaries/framework/conformance/plans/driver-api-core.json; boundaries/framework/conformance/plans/driver-api-extended.json",
    fixture:
      "boundaries/framework/conformance/scenarios/driver-api-scenarios.json",
    generatedArtifact:
      "boundaries/framework/contracts/driver-api/artifacts/json-schema",
  },
  eventStream: {
    adapterCapability: "framework.event-stream",
    authorityPacket:
      "boundaries/shared/contracts/core/spec/authority-packet.json",
    compatibilityEvidence:
      "reports/compatibility/evidence/shared-conformance-runner.framework-typescript-conformance-runner.json",
    conformancePlan:
      "boundaries/framework/conformance/plans/event-stream-core.json; boundaries/framework/conformance/plans/event-stream-extended.json",
    fixture: "boundaries/framework/conformance/fixtures/stream-events.json",
    generatedArtifact:
      "boundaries/framework/contracts/event-stream/artifacts/json-schema",
  },
  kernelProtocol: {
    adapterCapability: "kernel.protocol; kernel.logical",
    authorityPacket:
      "boundaries/kernel/contracts/protocol/spec/authority-packet.json",
    compatibilityEvidence:
      "reports/compatibility/evidence/shared-conformance-runner.kernel-typescript-sqlite-conformance-runner.json; reports/compatibility/evidence/shared-conformance-runner.kernel-rust-conformance-runner.json",
    conformancePlan:
      "boundaries/kernel/conformance/plans/kernel-protocol-core.json; boundaries/kernel/conformance/plans/kernel-protocol-extended.json",
    fixture:
      "boundaries/kernel/conformance/fixtures/kernel-protocol-logical.json; boundaries/kernel/conformance/fixtures/kernel-protocol-deterministic.json",
    generatedArtifact:
      "N/A - kernel protocol behavior is fixture/conformance-backed; grammar source is boundaries/kernel/contracts/protocol/spec/cddl/kernel-records.cddl",
  },
  providerApi: {
    adapterCapability: "providers.provider-api; providers.ai-sdk-bridge",
    authorityPacket:
      "boundaries/providers/contracts/provider-api/spec/authority-packet.json",
    compatibilityEvidence:
      "reports/compatibility/evidence/shared-conformance-runner.providers-typescript-conformance-runner.json",
    conformancePlan:
      "boundaries/providers/conformance/plans/provider-api-bridge.json; boundaries/providers/conformance/plans/provider-api-bridge-extended.json",
    fixture: "boundaries/providers/conformance/fixtures/provider-fixtures.json",
    generatedArtifact:
      "boundaries/providers/contracts/provider-api/artifacts/json-schema; boundaries/providers/contracts/provider-api/artifacts/openapi",
  },
  reactDriver: {
    adapterCapability: "framework.react-driver",
    authorityPacket:
      "boundaries/framework/contracts/react-driver/spec/authority-packet.json",
    compatibilityEvidence:
      "reports/compatibility/evidence/shared-conformance-runner.framework-typescript-conformance-runner.json",
    conformancePlan:
      "boundaries/framework/conformance/plans/react-driver-callables.json; boundaries/framework/conformance/plans/react-driver-extended.json",
    fixture:
      "boundaries/framework/conformance/scenarios/driver-api-scenarios.json",
    generatedArtifact:
      "N/A - react-driver packet is conformance-plan authority without generated schema artifacts",
  },
  runtimeApi: {
    adapterCapability: "framework.runtime-api",
    authorityPacket:
      "boundaries/shared/contracts/core/spec/authority-packet.json",
    compatibilityEvidence:
      "reports/compatibility/evidence/shared-conformance-runner.framework-typescript-conformance-runner.json",
    conformancePlan:
      "boundaries/framework/conformance/plans/runtime-api-lifecycle.json; boundaries/framework/conformance/plans/runtime-api-lifecycle-extended.json; boundaries/framework/conformance/plans/runtime-api-callables.json; boundaries/framework/conformance/plans/runtime-api-callables-extended.json",
    fixture:
      "boundaries/framework/conformance/scenarios/runtime-api-scenarios.json",
    generatedArtifact:
      "boundaries/framework/contracts/runtime-api/artifacts/json-schema",
  },
  // KRT-AL002 G1 split tool and approval-result authority out of
  // `runtime-api` into a dedicated `tuvren.framework.tool-contracts`
  // packet. Doc classifications that previously rooted tool/approval
  // claims at `runtimeApi` now route here so the freeze gate stops
  // blessing stale `runtime-api` anchors for those promoted claims.
  toolContracts: {
    adapterCapability: "framework.runtime-api",
    authorityPacket:
      "boundaries/shared/contracts/core/spec/authority-packet.json",
    compatibilityEvidence:
      "reports/compatibility/evidence/shared-conformance-runner.framework-typescript-conformance-runner.json",
    conformancePlan:
      "boundaries/framework/conformance/plans/tool-contracts-extended.json",
    fixture:
      "boundaries/framework/conformance/scenarios/runtime-api-scenarios.json",
    generatedArtifact:
      "boundaries/framework/contracts/tool-contracts/artifacts/json-schema; boundaries/framework/contracts/tool-contracts/artifacts/openapi/tool-contracts.openapi.json",
  },
  runtimeOrchestration: {
    adapterCapability: "framework.orchestration",
    authorityPacket:
      "boundaries/shared/contracts/core/spec/authority-packet.json",
    compatibilityEvidence:
      "reports/compatibility/evidence/shared-conformance-runner.framework-typescript-conformance-runner.json",
    conformancePlan:
      "boundaries/framework/conformance/plans/runtime-api-orchestration.json",
    fixture:
      "boundaries/framework/conformance/scenarios/runtime-api-scenarios.json",
    generatedArtifact:
      "boundaries/framework/contracts/runtime-api/artifacts/json-schema",
  },
  runLiveness: {
    adapterCapability: "kernel.run-liveness; framework.run-liveness",
    authorityPacket:
      "boundaries/kernel/contracts/protocol/spec/authority-packet.json",
    compatibilityEvidence:
      "reports/compatibility/evidence/shared-conformance-runner.kernel-typescript-sqlite-conformance-runner.json; reports/compatibility/evidence/shared-conformance-runner.framework-typescript-conformance-runner.json",
    conformancePlan:
      "boundaries/kernel/conformance/plans/kernel-run-liveness.json",
    fixture:
      "boundaries/kernel/conformance/fixtures/kernel-protocol-logical.json",
    generatedArtifact:
      "N/A - run-liveness is conformance-plan authority without generated schema artifacts",
  },
  restartRecovery: {
    adapterCapability: "kernel.restart-recovery",
    authorityPacket:
      "boundaries/kernel/contracts/protocol/spec/authority-packet.json",
    compatibilityEvidence:
      "reports/compatibility/evidence/shared-conformance-runner.kernel-typescript-sqlite-conformance-runner.json",
    conformancePlan:
      "boundaries/kernel/conformance/plans/kernel-restart-recovery.json",
    fixture:
      "boundaries/kernel/conformance/fixtures/kernel-protocol-logical.json",
    generatedArtifact:
      "N/A - restart recovery is conformance-plan authority without generated schema artifacts",
  },
  // KRT-BC001/BC002: capability-orchestration model (ADR-046) — four
  // execution classes, MCP-as-binding, exposure/invocation policy, and
  // per-class observation limits. All §11 normative claims are backed by
  // the cross-class integration conformance plan plus the per-class plans
  // promoted by Epics AW–BB.
  capabilityOrchestration: {
    adapterCapability: "framework.runtime-api",
    authorityPacket:
      "boundaries/shared/contracts/core/spec/authority-packet.json",
    compatibilityEvidence:
      "reports/compatibility/evidence/shared-conformance-runner.framework-typescript-conformance-runner.json",
    conformancePlan:
      "boundaries/framework/conformance/plans/capability-orchestration-integration.json; boundaries/framework/conformance/plans/tuvren-server-execution-class.json; boundaries/framework/conformance/plans/tuvren-client-execution-class.json; boundaries/framework/conformance/plans/invocation-lifecycle-observation.json; boundaries/framework/conformance/plans/capability-policy.json",
    fixture:
      "boundaries/framework/conformance/scenarios/runtime-api-scenarios.json",
    generatedArtifact: "boundaries/shared/contracts/core/artifacts/json-schema",
  },
} as const satisfies Record<string, EvidenceTemplate>;

const EMPTY_EVIDENCE: EvidenceTemplate = {
  adapterCapability: "N/A",
  authorityPacket: "N/A",
  compatibilityEvidence: "N/A",
  conformancePlan: "N/A",
  fixture: "N/A",
  generatedArtifact: "N/A",
};

interface ClassificationDecision {
  classification: Classification;
  deferralRationale: string;
  docsCorrection: string;
  evidence: EvidenceTemplate;
  followUpTicket: string;
  implementationEvidence: string;
  surface: string;
}

async function main(): Promise<void> {
  const mode = resolveCliMode();
  const parsed = await Promise.all(DOC_SOURCES.map(parseDocSource));
  const claims = parsed.flatMap((result) => result.claims);
  const rationaleSections = parsed.flatMap(
    (result) => result.rationaleSections
  );
  const claimsWithDuplicates = addDuplicateLinks(claims);
  const matrixEntries = claimsWithDuplicates.map(toCoverageEntry);
  const inventoryClaims = matrixEntries.map(toInventoryEntry);
  const unclassifiedEntries = matrixEntries.filter(
    (entry) => entry.classification === "unclassified"
  );

  if (unclassifiedEntries.length > 0) {
    const examples = unclassifiedEntries
      .slice(0, 5)
      .map(
        (entry) =>
          `${entry.claimId} ${entry.sourceFile}:${entry.line} ${entry.sectionKey}`
      )
      .join("; ");
    throw new Error(
      `docs authority freeze gate found ${unclassifiedEntries.length} unclassified claims: ${examples}`
    );
  }
  await validateCoverageMatrixEvidence(matrixEntries);

  const inventory = {
    duplicateNormativeClaims: duplicateClaimCount(claimsWithDuplicates),
    generatedBy: "bun tools/scripts/docs-authority-freeze-gate.ts",
    normativePattern: NORMATIVE_PATTERN.source,
    rationaleSections,
    sources: DOC_SOURCES.map((source) => source.path),
    totalIndependentClaims: independentClaimCount(claimsWithDuplicates),
    totalNormativeClaims: claimsWithDuplicates.length,
    claims: inventoryClaims,
  } satisfies ClaimInventory;
  const matrix = {
    duplicateClaims: duplicateClaimCount(matrixEntries),
    generatedBy: "bun tools/scripts/docs-authority-freeze-gate.ts",
    primaryClassificationRule:
      "Each normative claim receives exactly one primary classification derived from its source section and explicit text markers.",
    totalClaims: matrixEntries.length,
    totalIndependentClaims: independentClaimCount(matrixEntries),
    unclassifiedClaims: unclassifiedEntries.length,
    entries: matrixEntries,
  } satisfies CoverageMatrix;
  const artifacts: readonly OutputArtifact[] = [
    { path: INVENTORY_PATH, content: formatJson(inventory) },
    { path: MATRIX_PATH, content: formatJson(matrix) },
    { path: SUMMARY_PATH, content: renderSummary(matrixEntries) },
    {
      path: FRAMEWORK_DECISIONS_PATH,
      content: renderFrameworkDecisions(matrixEntries),
    },
    {
      path: LOCAL_DECISIONS_PATH,
      content: renderLocalSurfaceDecisions(matrixEntries),
    },
    { path: REPORT_PATH, content: renderFreezeGateReport(matrixEntries) },
    { path: CLOSURE_PATH, content: renderClosureInventory(matrixEntries) },
  ];

  if (mode === "check") {
    await checkArtifacts(artifacts);
    console.log(
      `docs authority freeze gate verified ${matrixEntries.length} classified claims`
    );
    return;
  }

  await writeArtifacts(artifacts);

  console.log(
    `docs authority freeze gate generated ${matrixEntries.length} classified claims`
  );
}

function resolveCliMode(): "check" | "write" {
  const args = process.argv.slice(2);
  const unexpectedArgs = args.filter((arg) => arg !== "--check");
  if (unexpectedArgs.length > 0) {
    throw new Error(
      `unsupported docs authority freeze gate arguments: ${unexpectedArgs.join(
        ", "
      )}`
    );
  }

  return args.includes("--check") ? "check" : "write";
}

async function validateCoverageMatrixEvidence(
  entries: readonly CoverageEntry[]
): Promise<void> {
  const failures: string[] = [];

  for (const entry of entries) {
    if (entry.classification !== "authority-backed-conformance-covered") {
      continue;
    }

    failures.push(...authorityAnchorPresenceFailures(entry));

    for (const reference of authorityEvidenceReferences(entry)) {
      if (!(await pathExists(reference.path))) {
        failures.push(
          `${entry.claimId} ${reference.field} path does not exist: ${reference.path}`
        );
      }
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `docs authority freeze gate evidence validation failed:\n${failures.join("\n")}`
    );
  }
}

function authorityAnchorPresenceFailures(entry: CoverageEntry): string[] {
  const failures: string[] = [];

  if (
    entry.adapterCapability === "N/A" ||
    entry.adapterCapability.length === 0
  ) {
    failures.push(`${entry.claimId} adapterCapability is missing`);
  }

  for (const field of REQUIRED_AUTHORITY_ANCHOR_FIELDS) {
    if (entry[field] === "N/A" || entry[field].length === 0) {
      failures.push(`${entry.claimId} ${field} is missing`);
    }
  }

  return failures;
}

function authorityEvidenceReferences(entry: CoverageEntry): Array<{
  field: string;
  path: string;
}> {
  const references: Array<{ field: string; path: string }> = [];

  for (const field of REQUIRED_AUTHORITY_ANCHOR_FIELDS) {
    references.push(
      ...extractEvidencePaths(entry[field]).map((path) => ({ field, path }))
    );
  }

  references.push(
    ...extractEvidencePaths(entry.generatedArtifact).map((path) => ({
      field: "generatedArtifact",
      path,
    }))
  );

  return references;
}

function extractEvidencePaths(value: string): string[] {
  if (value === "N/A") {
    return [];
  }

  if (!value.startsWith("N/A -")) {
    return value.split(";").map((part) => part.trim());
  }

  return [...value.matchAll(EVIDENCE_PATH_PATTERN)].map((match) =>
    (match[0] ?? "").replace(/[.,]+$/g, "")
  );
}

function isSection(section: string, expected: string): boolean {
  return section === expected || section.startsWith(`${expected}.`);
}

function isSectionMajor(section: string, major: string): boolean {
  return section === major || section.startsWith(`${major}.`);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function parseDocSource(source: DocSource): Promise<{
  claims: NormativeClaim[];
  rationaleSections: RationaleSection[];
}> {
  const text = await readFile(source.path, "utf8");
  const state: DocParseState = {
    claimedIds: new Map<string, string>(),
    claims: [],
    headingStack: [
      {
        anchor: "#top",
        heading: "Document Preamble",
        level: 1,
        sectionKey: "preamble",
      },
    ],
    inCodeFence: false,
    proseBlock: null,
    rationaleLineCounts: new Map<string, RationaleSection>(),
    source,
  };

  for (const [index, rawLine] of text.split(LINE_SPLIT_PATTERN).entries()) {
    await parseDocLine(state, rawLine, index + 1);
  }

  await flushProseBlock(state);

  return {
    claims: state.claims,
    rationaleSections: [...state.rationaleLineCounts.values()],
  };
}

async function parseDocLine(
  state: DocParseState,
  rawLine: string,
  line: number
): Promise<void> {
  const trimmed = rawLine.trim();

  if (trimmed.startsWith("```")) {
    await flushProseBlock(state);
    state.inCodeFence = !state.inCodeFence;
    return;
  }

  const currentHeading = currentHeadingFor(state, line);

  if (state.inCodeFence) {
    await parseCodeFenceLine(state, currentHeading, trimmed, line);
    return;
  }

  if (trimmed.length === 0 || trimmed === "---") {
    await flushProseBlock(state);
    return;
  }

  const headingMatch = HEADING_PATTERN.exec(trimmed);
  if (headingMatch != null) {
    await parseHeadingLine(state, headingMatch, line);
    return;
  }

  if (TABLE_ROW_PATTERN.test(trimmed)) {
    await parseStandaloneClaimLine(state, currentHeading, trimmed, line);
    return;
  }

  await appendProseLine(state, currentHeading, trimmed, line);
}

function currentHeadingFor(state: DocParseState, line: number): HeadingState {
  const currentHeading = state.headingStack.at(-1);
  if (currentHeading === undefined) {
    throw new Error(`missing heading state at ${state.source.path}:${line}`);
  }
  return currentHeading;
}

async function parseCodeFenceLine(
  state: DocParseState,
  heading: HeadingState,
  trimmed: string,
  line: number
): Promise<void> {
  if (trimmed.length === 0) {
    return;
  }

  if (CODE_FENCE_COMMENT_PATTERN.test(trimmed)) {
    addRationaleLines(state, heading, 1);
    return;
  }

  if (isNormativeCodeFenceLine(trimmed)) {
    await parseStandaloneClaimLine(state, heading, trimmed, line);
    return;
  }

  addRationaleLines(state, heading, 1);
}

function isNormativeCodeFenceLine(trimmed: string): boolean {
  const commentMatch = CODE_FENCE_INLINE_COMMENT_PATTERN.exec(trimmed);
  if (commentMatch?.[1] != null) {
    return NORMATIVE_PATTERN.test(commentMatch[1]);
  }

  return CODE_FENCE_STRONG_NORMATIVE_PATTERN.test(trimmed);
}

async function parseHeadingLine(
  state: DocParseState,
  headingMatch: RegExpExecArray,
  line: number
): Promise<void> {
  await flushProseBlock(state);
  const [, marker, headingText] = headingMatch;
  if (marker === undefined || headingText === undefined) {
    throw new Error(`invalid heading at ${state.source.path}:${line}`);
  }
  const level = marker.length;
  state.headingStack.splice(level - 1);
  state.headingStack.push({
    anchor: toAnchor(headingText),
    heading: headingText,
    level,
    sectionKey: toSectionKey(headingText),
  });
}

async function parseStandaloneClaimLine(
  state: DocParseState,
  heading: HeadingState,
  trimmed: string,
  line: number
): Promise<void> {
  await flushProseBlock(state);
  if (NORMATIVE_PATTERN.test(trimmed)) {
    await pushClaim(state, heading, trimmed, line);
  } else {
    addRationaleLines(state, heading, 1);
  }
}

async function appendProseLine(
  state: DocParseState,
  heading: HeadingState,
  trimmed: string,
  line: number
): Promise<void> {
  if (LIST_ITEM_PATTERN.test(trimmed)) {
    await flushProseBlock(state);
  }

  if (state.proseBlock == null) {
    state.proseBlock = {
      heading,
      line,
      lines: [trimmed],
    };
    return;
  }

  state.proseBlock.lines.push(trimmed);
}

function addRationaleLines(
  state: DocParseState,
  heading: HeadingState,
  lineCount: number
): void {
  const rationaleKey = `${state.source.path}:${heading.anchor}`;
  const existing = state.rationaleLineCounts.get(rationaleKey);
  if (existing == null) {
    state.rationaleLineCounts.set(rationaleKey, {
      affectedBoundary: state.source.boundary,
      nonNormativeLineCount: lineCount,
      sectionAnchor: heading.anchor,
      sectionHeading: heading.heading,
      sectionKey: heading.sectionKey,
      sourceFile: state.source.path,
    });
    return;
  }

  existing.nonNormativeLineCount += lineCount;
}

async function pushClaim(
  state: DocParseState,
  heading: HeadingState,
  claimText: string,
  line: number
): Promise<void> {
  const normalizedText = normalizeClaimText(claimText);
  const { claimFingerprint, claimId } = await toStableClaimId(
    state.source,
    heading,
    normalizedText,
    state.claimedIds
  );
  state.claims.push({
    affectedBoundary: state.source.boundary,
    claimFingerprint,
    claimId,
    duplicateOf: null,
    line,
    rationaleContext: "normative",
    sectionAnchor: heading.anchor,
    sectionHeading: heading.heading,
    sectionKey: heading.sectionKey,
    sourceFile: state.source.path,
    text: normalizedText,
  });
}

async function flushProseBlock(state: DocParseState): Promise<void> {
  if (state.proseBlock == null) {
    return;
  }

  const block = state.proseBlock;
  state.proseBlock = null;
  const claimText = block.lines.join(" ");

  if (
    NORMATIVE_PATTERN.test(claimText) ||
    isImplicitScopeBoundaryBlock(block)
  ) {
    await pushClaim(state, block.heading, claimText, block.line);
    return;
  }

  addRationaleLines(state, block.heading, block.lines.length);
}

function isImplicitScopeBoundaryBlock(block: PendingProseBlock): boolean {
  if (block.heading.sectionKey !== "10.9" || block.lines.length !== 1) {
    return false;
  }

  const [line] = block.lines;
  return (
    line === "This specification does not define:" ||
    LIST_ITEM_PATTERN.test(line ?? "")
  );
}

async function toStableClaimId(
  source: DocSource,
  heading: HeadingState,
  text: string,
  claimedIds: Map<string, string>
): Promise<{
  claimFingerprint: string;
  claimId: string;
}> {
  const fingerprintInput = [
    source.path,
    source.boundary,
    heading.sectionKey,
    heading.anchor,
    text.toLowerCase(),
  ].join("\n");
  const claimFingerprint = await sha256Hex(fingerprintInput);
  const baseClaimId = `${source.claimPrefix}-${claimFingerprint
    .slice(0, CLAIM_ID_HASH_LENGTH)
    .toUpperCase()}`;
  let claimId = baseClaimId;
  let suffix = 2;

  while (claimedIds.has(claimId)) {
    claimId = `${baseClaimId}-${suffix}`;
    suffix += 1;
  }

  claimedIds.set(claimId, claimFingerprint);

  return {
    claimFingerprint,
    claimId,
  };
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value)
  );
  const bytes = new Uint8Array(digest);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    ""
  );
}

function addDuplicateLinks(
  claims: readonly NormativeClaim[]
): NormativeClaim[] {
  const firstByNormalizedText = new Map<string, string>();

  return claims.map((claim) => {
    const normalized = claim.text.toLowerCase().replace(/\W+/g, " ").trim();
    const firstClaimId = firstByNormalizedText.get(normalized);

    if (firstClaimId == null) {
      firstByNormalizedText.set(normalized, claim.claimId);
      return claim;
    }

    return {
      ...claim,
      duplicateOf: firstClaimId,
    };
  });
}

function toCoverageEntry(claim: NormativeClaim): CoverageEntry {
  const decision =
    claim.affectedBoundary === "framework"
      ? classifyFrameworkClaim(claim)
      : classifyKernelClaim(claim);

  return {
    ...claim,
    adapterCapability: decision.evidence.adapterCapability,
    authorityPacket: decision.evidence.authorityPacket,
    classification: decision.classification,
    compatibilityEvidence: decision.evidence.compatibilityEvidence,
    conformancePlan: decision.evidence.conformancePlan,
    deferralRationale: decision.deferralRationale,
    docsCorrection: decision.docsCorrection,
    fixture: decision.evidence.fixture,
    followUpTicket: decision.followUpTicket,
    generatedArtifact: decision.evidence.generatedArtifact,
    implementationEvidence: decision.implementationEvidence,
    surface: decision.surface,
  };
}

function toInventoryEntry(entry: CoverageEntry): ClaimInventoryEntry {
  return {
    affectedBoundary: entry.affectedBoundary,
    adapterCapability: entry.adapterCapability,
    claimFingerprint: entry.claimFingerprint,
    claimId: entry.claimId,
    duplicateOf: entry.duplicateOf,
    line: entry.line,
    rationaleContext: entry.rationaleContext,
    sectionAnchor: entry.sectionAnchor,
    sectionHeading: entry.sectionHeading,
    sectionKey: entry.sectionKey,
    sourceFile: entry.sourceFile,
    surface: entry.surface,
    text: entry.text,
  };
}

function classifyFrameworkClaim(claim: NormativeClaim): ClassificationDecision {
  const section = claim.sectionKey;
  const text = claim.text.toLowerCase();

  if (
    text.includes("single authoritative") ||
    text.includes("authoritative for")
  ) {
    return staleDocsDecision(
      "framework authority posture",
      "Docs preamble now distinguishes human semantic authority from machine portability authority."
    );
  }

  if (text.includes("future drivers")) {
    return deferredDecision(
      "future framework drivers",
      "Future framework drivers remain deferred until a later TechSpec and Tasks revision activates a concrete driver line."
    );
  }

  const controlSurfaceDecision = classifyFrameworkControlSurfaceClaim(
    section,
    text
  );
  if (controlSurfaceDecision != null) {
    return controlSurfaceDecision;
  }

  if (
    section === "preamble" ||
    section === "0" ||
    section === "kraken-framework-specification"
  ) {
    return implementationDefinedDecision(
      "framework driver framing",
      "Driver framing explains the current semantic layering; portable claim status is determined by the matrix rows for the referenced concrete surfaces."
    );
  }

  const coreSectionDecision = classifyFrameworkCoreSection(section, text);
  if (coreSectionDecision != null) {
    return coreSectionDecision;
  }

  const runtimeSectionDecision = classifyFrameworkRuntimeSection(section);
  if (runtimeSectionDecision != null) {
    return runtimeSectionDecision;
  }

  return unclassifiedDecision(
    "framework unclassified surface",
    "Framework prose landed outside the Epic AD section classifier and must be explicitly routed before the freeze gate can pass."
  );
}

function classifyFrameworkControlSurfaceClaim(
  section: string,
  text: string
): ClassificationDecision | null {
  if (isApprovalControlClaim(text)) {
    // KRT-AL002 G1 moved approval/tool authority onto the tool-contracts
    // packet, so approval-control claims must anchor to that packet (not
    // runtime-api) once the freeze gate routes its evidence accordingly.
    return missingConformanceDecision(
      "approval and cancellation control",
      EVIDENCE.toolContracts,
      "KRT-AF004",
      "Approval resume, paused cancellation, rejection, and resolveApproval control semantics require AF tool/approval checks before freeze closure."
    );
  }

  if (isSection(section, "6.10") && text.includes("cancellation")) {
    // Cancellation lifecycle stays on runtime-api: it is a lifecycle
    // behavior on the runtime callable, not part of the tool/approval
    // contract surface.
    return missingConformanceDecision(
      "runtime cancellation control",
      EVIDENCE.runtimeApi,
      "KRT-AF002",
      "Running cancellation and partial-staging behavior needs AF lifecycle negative/interleaving checks before freeze closure."
    );
  }

  return null;
}

function isApprovalControlClaim(text: string): boolean {
  return (
    text.includes("approval") ||
    text.includes("resolveapproval") ||
    text.includes("paused run") ||
    text.includes("paused handle") ||
    text.includes("paused turn")
  );
}

function classifyFrameworkCoreSection(
  section: string,
  text: string
): ClassificationDecision | null {
  if (section === "6.9" && text.includes("package topology")) {
    return implementationDefinedDecision(
      "stream adapter package topology",
      "TypeScript stream adapter package topology and AG-UI version pinning are implementation-line evidence, not portable event-stream authority."
    );
  }

  const eventSectionDecision = classifyFrameworkEventStreamSection(section);
  if (eventSectionDecision != null) {
    return eventSectionDecision;
  }

  if (isSection(section, "1.8") || isSectionMajor(section, "6")) {
    return authorityDecision("framework event stream", EVIDENCE.eventStream);
  }

  if (isSection(section, "1.5") || isSection(section, "4.10")) {
    return authorityDecision(
      "runtime resolution and errors",
      EVIDENCE.runtimeApi
    );
  }

  if (isSection(section, "1.7") || isSectionMajor(section, "8")) {
    // KRT-AL002 G1: tool and approval contracts now own a dedicated
    // packet at `tuvren.framework.tool-contracts`; route here instead of
    // runtime-api so the freeze evidence anchors to the packet that
    // actually owns these shapes.
    return missingConformanceDecision(
      "tool and approval contracts",
      EVIDENCE.toolContracts,
      "KRT-AF004",
      "Tool and approval shapes have TypeScript artifacts and runtime evidence, but the freeze pass keeps them out of portable truth until AF selects neutral checks."
    );
  }

  if (isSectionMajor(section, "1")) {
    return missingConformanceDecision(
      "shared framework type shapes",
      EVIDENCE.runtimeApi,
      "KRT-AF001",
      "Shared type prose is not by itself portable truth; AF must decide whether to promote more shape checks or leave them as binding projections."
    );
  }

  if (isSectionMajor(section, "2")) {
    return promotedEpicAfDecision(
      "framework state schema",
      EVIDENCE.runtimeApi,
      "KRT-AF001 if portability is selected"
    );
  }

  return classifyFrameworkIntegrationSection(section, text);
}

function classifyFrameworkEventStreamSection(
  section: string
): ClassificationDecision | null {
  if (isSection(section, "6.4")) {
    // §6.4 covers parallel tool caps and mixed approval ordering, which
    // live under the AL-promoted tool-contracts packet; runtime-api no
    // longer owns these claims.
    return missingConformanceDecision(
      "tool parallelism and event ordering",
      EVIDENCE.toolContracts,
      "KRT-AF004",
      "Parallel tool caps, known non-executed outcomes, and mixed approval ordering need AF tool/approval checks before freeze closure."
    );
  }

  if (isSection(section, "6.5")) {
    return missingConformanceDecision(
      "aroundModel live/durable reconciliation",
      EVIDENCE.reactDriver,
      "KRT-AF003",
      "aroundModel replacement, retry, and durable/live response reconciliation need AF ReAct and extension-hook promotion before freeze closure."
    );
  }

  if (isSection(section, "6.7")) {
    return missingConformanceDecision(
      "worker subtree event forwarding",
      EVIDENCE.runtimeOrchestration,
      "KRT-AF005",
      "Worker subtree event forwarding is orchestration behavior that needs AF leftover closure before freeze coverage."
    );
  }

  return null;
}

function classifyFrameworkIntegrationSection(
  section: string,
  text: string
): ClassificationDecision | null {
  if (
    (isSection(section, "3.4") && text.includes("provider-")) ||
    text.includes("provider-anthropic")
  ) {
    return deferredDecision(
      "future provider adapter packages",
      "Future direct provider packages remain deferred until a later TechSpec activates concrete provider package work."
    );
  }

  if (
    [
      "adapter-normalization",
      "streaming-behavior",
      "validation",
      "lifecycle",
    ].includes(section)
  ) {
    return missingConformanceDecision(
      "structured output contract",
      EVIDENCE.runtimeApi,
      "KRT-AF004",
      "Structured-output adapter, streaming, validation, and lifecycle semantics need AF tool/provider/error-boundary checks before freeze closure."
    );
  }

  if (isSectionMajor(section, "3")) {
    return authorityDecision("provider API bridge", EVIDENCE.providerApi);
  }

  if (section === "approval-resume") {
    // KRT-AL002 G1: approval continuity is now owned by tool-contracts;
    // route approval-resume claims through the tool-contracts packet.
    return missingConformanceDecision(
      "approval resume semantics",
      EVIDENCE.toolContracts,
      "KRT-AF004",
      "Approval resume has TypeScript runtime evidence, but AF must promote the selected approval continuity checks into shared conformance."
    );
  }

  if (
    section === "running-lease-ownership" ||
    section === "stale-running-recovery"
  ) {
    return authorityDecision(
      "runtime lifecycle recovery",
      EVIDENCE.runLiveness
    );
  }

  if (isSection(section, "4.8") || isSection(section, "4.9")) {
    return authorityDecision(
      "runtime lifecycle recovery",
      EVIDENCE.runLiveness
    );
  }

  if (isSectionMajor(section, "4")) {
    return authorityDecision(
      "runtime and ReAct execution",
      EVIDENCE.runtimeApi
    );
  }

  if (isSection(section, "5.6")) {
    return authorityDecision("driver contract", EVIDENCE.driverApi);
  }

  if (isSection(section, "5.3")) {
    return missingConformanceDecision(
      "runtime loop policy",
      EVIDENCE.driverApi,
      "KRT-AF003",
      "Loop-policy continuation and invalid-combination semantics are shared driver behavior that AF must promote before freeze closure."
    );
  }

  if (isSectionMajor(section, "9")) {
    if (
      text.includes("ordering") ||
      text.includes("around") ||
      text.includes("beforeiteration") ||
      text.includes("afteriteration")
    ) {
      return missingConformanceDecision(
        "ReAct and extension hooks",
        EVIDENCE.reactDriver,
        "KRT-AF003",
        "Some hook behavior is already packet-backed, but AF must choose which ordering and nesting details become portable."
      );
    }

    return implementationDefinedDecision(
      "extension contracts",
      "Extension storage, composition, custom event, and hook policy details are intentionally local unless AF promotes selected ReAct behavior."
    );
  }

  if (isSectionMajor(section, "5")) {
    return implementationLocalDecision(
      "framework integration contracts",
      "boundaries/framework/implementations/typescript/runtime-core/test/runtime-core.test.ts; boundaries/framework/implementations/typescript/drivers/react/test/react-driver.test.ts",
      "The local TypeScript contract implementations are not cross-language authority until selected by an authority packet and shared plan."
    );
  }

  return null;
}

function classifyFrameworkRuntimeSection(
  section: string
): ClassificationDecision | null {
  if (
    ["system-prompt", "reading-and-updating", "namespace-isolation"].includes(
      section
    )
  ) {
    return implementationDefinedDecision(
      "extension state and prompt contracts",
      "Extension prompt and state policy is explicitly framework-local unless AF promotes selected hook behavior."
    );
  }

  if (
    [
      "interceptresult",
      "handler-signature",
      "afterturn",
      "beforeiteration",
      "afteriteration",
      "aroundtool",
    ].includes(section)
  ) {
    return missingConformanceDecision(
      "ReAct and extension hooks",
      EVIDENCE.reactDriver,
      "KRT-AF003",
      "Extension hook result, ordering, and persistence semantics need AF promotion before they become portable cross-language authority."
    );
  }

  if (isSectionMajor(section, "7")) {
    return authorityDecision("host execution handle", EVIDENCE.runtimeApi);
  }

  if (
    [
      "agent-signaled-handoff",
      "handoff-context-engineering",
      "default-handoff-context-builder-preserve-trace",
    ].includes(section)
  ) {
    return missingConformanceDecision(
      "handoff and context engineering",
      EVIDENCE.runtimeOrchestration,
      "KRT-AF005",
      "Handoff and context-engineering behavior remains blocked on AF orchestration leftover closure."
    );
  }

  if (isSection(section, "10.1") || isSection(section, "10.7")) {
    return implementationDefinedDecision(
      "orchestration static config and extension scoping",
      "Epic AC left static config snapshotting and extension scoping as local evidence; KRT-AF005 decides whether to promote or keep them local."
    );
  }

  if (isSection(section, "10.2") || isSection(section, "10.5")) {
    return implementationDefinedDecision(
      "orchestration optional worker modes",
      "Synchronous workers and ordered pipelines are explicitly above the shared-core freeze surface."
    );
  }

  if (isSection(section, "10.9")) {
    return deferredDecision(
      "orchestration out-of-core boundaries",
      "Worker process management, agent discovery, delegated construction modes, and related higher-layer concerns require a later product plan."
    );
  }

  if (isSectionMajor(section, "10")) {
    return authorityDecision(
      "runtime orchestration",
      EVIDENCE.runtimeOrchestration
    );
  }

  if (isSectionMajor(section, "11")) {
    return authorityDecision(
      "capability orchestration",
      EVIDENCE.capabilityOrchestration
    );
  }

  return null;
}

function classifyKernelClaim(claim: NormativeClaim): ClassificationDecision {
  const section = claim.sectionKey;
  const text = claim.text.toLowerCase();
  const portabilityNoteDecision = classifyKernelPortabilityNoteText(text);
  if (portabilityNoteDecision != null) {
    return portabilityNoteDecision;
  }
  const postureDecision = classifyKernelPostureText(text);
  if (postureDecision != null) {
    return postureDecision;
  }
  const deferredDecisionResult = classifyKernelDeferredText(section, text);
  if (deferredDecisionResult != null) {
    return deferredDecisionResult;
  }

  for (const classifier of [
    classifyKernelFramingSection,
    classifyKernelBackendSection,
    classifyKernelRunLivenessSection,
    classifyKernelAppendixSection,
    classifyKernelCoreSection,
  ]) {
    const decision = classifier(section, text);
    if (decision != null) {
      return decision;
    }
  }

  return unclassifiedDecision(
    "kernel unclassified surface",
    "Kernel prose landed outside the Epic AD section classifier and must be explicitly routed before the freeze gate can pass."
  );
}

function classifyKernelPortabilityNoteText(
  text: string
): ClassificationDecision | null {
  if (
    !(
      text.includes("epic ad freezes the portability reading") &&
      text.includes("docs-to-authority matrix")
    )
  ) {
    return null;
  }

  return implementationDefinedDecision(
    "kernel docs-to-authority framing",
    "The Epic AD portability note describes the freeze gate classification model rather than portable kernel protocol behavior."
  );
}

function classifyKernelDeferredText(
  section: string,
  text: string
): ClassificationDecision | null {
  if (section !== "appendix" || !text.includes("deferred")) {
    return null;
  }

  return deferredDecision(
    "kernel deferred maintenance surfaces",
    "Merge rules, garbage collection, and related maintenance policies remain deferred until a later kernel storage or lifecycle plan activates them."
  );
}

function classifyKernelPostureText(
  text: string
): ClassificationDecision | null {
  if (
    !(
      text.includes("single authoritative") ||
      text.includes("authoritative for")
    )
  ) {
    return null;
  }

  return staleDocsDecision(
    "kernel authority posture",
    "Docs preamble now distinguishes frozen human kernel semantics from promoted machine authority."
  );
}

function classifyKernelFramingSection(
  section: string
): ClassificationDecision | null {
  if (
    section === "preamble" ||
    section === "purpose" ||
    section === "1" ||
    section === "kraken-kernel-specification" ||
    section.startsWith("1.")
  ) {
    return authorityDecision(
      "kernel boundary framing",
      EVIDENCE.kernelProtocol
    );
  }

  return null;
}

function classifyKernelBackendSection(
  _section: string,
  text: string
): ClassificationDecision | null {
  if (
    (text.includes("structural sharing") ||
      text.includes("subtree hashes") ||
      text.includes("reused by reference")) &&
    !text.includes("cannot be diffed")
  ) {
    return implementationDefinedDecision(
      "kernel storage structural sharing",
      "Structural sharing and direct hash-node reuse are implementation freedoms unless a future storage-level packet promotes them."
    );
  }

  if (text.includes("implementation") && text.includes("may maintain")) {
    return implementationDefinedDecision(
      "kernel backend acceleration indexes",
      "Backend-local indexes may exist only as derived acceleration structures and are never canonical kernel records."
    );
  }

  if (text.includes("sqlite") || text.includes("physical")) {
    return implementationDefinedDecision(
      "kernel backend physical storage",
      "Physical storage strategy and backend internals remain implementation-defined unless a future storage packet promotes them."
    );
  }

  return null;
}

function classifyKernelRunLivenessSection(
  section: string
): ClassificationDecision | null {
  if (
    section.startsWith("5.2") ||
    section.includes("run-execution-leases") ||
    section.includes("stale-running-preemption")
  ) {
    return authorityDecision("kernel run liveness", EVIDENCE.runLiveness);
  }

  if (section.startsWith("5.7")) {
    return missingConformanceDecision(
      "kernel recovery edge states",
      EVIDENCE.restartRecovery,
      "KRT-AF006",
      "Restart recovery has a promoted smoke check, but the full crash-class matrix needs AF edge-state expansion before freeze closure."
    );
  }

  if (section === "crash-recovery-invariant") {
    return missingConformanceDecision(
      "kernel recovery edge states",
      EVIDENCE.restartRecovery,
      "KRT-AF006",
      "Checkpoint commit visibility and resume-or-fail-clean recovery semantics are covered by the promoted restart-recovery authority lane."
    );
  }

  return null;
}

function classifyKernelAppendixSection(
  section: string
): ClassificationDecision | null {
  if (
    !(
      section.startsWith("appendix") ||
      [
        "run-status-transitions",
        "run-creation-legality",
        "turn-update-legality",
        "schema",
        "thread",
        "turntree",
        "turnnode",
        "branch",
        "staging",
        "run-lifecycle",
        "turn-lifecycle",
      ].includes(section)
    )
  ) {
    return null;
  }

  return missingConformanceDecision(
    "kernel appendix validation matrix",
    EVIDENCE.kernelProtocol,
    "KRT-AF006",
    "Appendix legality and validation prose is portable intent, but AF must select edge-state checks before treating every row as freeze-covered."
  );
}

function classifyKernelCoreSection(
  section: string
): ClassificationDecision | null {
  if (
    [
      "tree-operations",
      "turnnode-operations",
      "run-lifecycle-operations",
    ].includes(section)
  ) {
    return authorityDecision(
      "kernel logical operations",
      EVIDENCE.kernelProtocol
    );
  }

  if (section.startsWith("2") || section.startsWith("3")) {
    return authorityDecision(
      "kernel protocol records",
      EVIDENCE.kernelProtocol
    );
  }

  if (section.startsWith("4") || section.startsWith("5")) {
    return authorityDecision(
      "kernel logical operations",
      EVIDENCE.kernelProtocol
    );
  }

  if (section.startsWith("6") || section.startsWith("7")) {
    return missingConformanceDecision(
      "kernel verdict and syscall edge states",
      EVIDENCE.kernelProtocol,
      "KRT-AF006",
      "Core protocol plans cover promoted logical behavior; AF decides which remaining verdict/syscall edge states need portable checks."
    );
  }

  if (section.startsWith("8")) {
    return authorityDecision("kernel invariants", EVIDENCE.kernelProtocol);
  }

  if (section.startsWith("9")) {
    return missingConformanceDecision(
      "kernel capability-gated syscalls",
      EVIDENCE.kernelProtocol,
      "KRT-AM010",
      "ADR-034 capability gate semantics are authority-backed; conformance plans gain thread.enumeration check sets in KRT-AM010."
    );
  }

  return null;
}

function authorityDecision(
  surface: string,
  evidence: EvidenceTemplate
): ClassificationDecision {
  return {
    classification: "authority-backed-conformance-covered",
    deferralRationale: "N/A",
    docsCorrection: "N/A",
    evidence,
    followUpTicket: "N/A",
    implementationEvidence:
      "N/A - measured through shared conformance evidence",
    surface,
  };
}

function deferredDecision(
  surface: string,
  rationale: string
): ClassificationDecision {
  return {
    classification: "explicitly-deferred",
    deferralRationale: rationale,
    docsCorrection:
      "Deferred scope is labeled in the docs authority notes and freeze gate report.",
    evidence: EMPTY_EVIDENCE,
    followUpTicket:
      "Future TechSpec/Tasks revision after TypeScript freeze closure",
    implementationEvidence: "N/A",
    surface,
  };
}

function implementationDefinedDecision(
  surface: string,
  rationale: string
): ClassificationDecision {
  return {
    classification: "implementation-defined",
    deferralRationale: rationale,
    docsCorrection:
      "Implementation-defined posture is labeled in the nearest docs authority note or decision report.",
    evidence: EMPTY_EVIDENCE,
    followUpTicket: "N/A unless AF promotes the surface",
    implementationEvidence:
      "Implementation evidence may exist, but it is not portable authority.",
    surface,
  };
}

function implementationLocalDecision(
  surface: string,
  implementationEvidence: string,
  rationale: string
): ClassificationDecision {
  return {
    classification: "implementation-local-evidence",
    deferralRationale: rationale,
    docsCorrection:
      "Docs and AD decision reports label this as local evidence rather than cross-language authority.",
    evidence: EMPTY_EVIDENCE,
    followUpTicket: "KRT-AF001 if portability is selected",
    implementationEvidence,
    surface,
  };
}

function missingConformanceDecision(
  surface: string,
  evidence: EvidenceTemplate,
  followUpTicket: string,
  rationale: string
): ClassificationDecision {
  if (followUpTicket.startsWith("KRT-AF")) {
    return promotedEpicAfDecision(surface, evidence, followUpTicket);
  }

  return {
    classification: "missing-conformance-follow-up",
    deferralRationale: rationale,
    docsCorrection:
      "Docs and AD reports label this as not freeze-covered until the follow-up ticket closes.",
    evidence,
    followUpTicket,
    implementationEvidence:
      "TypeScript local tests remain implementation evidence only until shared checks are promoted.",
    surface,
  };
}

function promotedEpicAfDecision(
  surface: string,
  evidence: EvidenceTemplate,
  followUpTicket: string
): ClassificationDecision {
  return {
    classification: "authority-backed-conformance-covered",
    deferralRationale:
      "N/A - Epic AF promoted this claim into boundary-owned authority and shared conformance evidence.",
    docsCorrection:
      "Epic AF closure records this claim as freeze-covered by authority packets, conformance plans, adapter observations, and compatibility evidence.",
    evidence,
    followUpTicket,
    implementationEvidence:
      "Shared conformance runner evidence is the portable authority; TypeScript local tests remain regression evidence only.",
    surface,
  };
}

function staleDocsDecision(
  surface: string,
  docsCorrection: string
): ClassificationDecision {
  return {
    classification: "stale-docs-corrected",
    deferralRationale:
      "The previous wording could be read as Markdown carrying machine portability authority.",
    docsCorrection,
    evidence: EMPTY_EVIDENCE,
    followUpTicket: "N/A",
    implementationEvidence: "N/A",
    surface,
  };
}

function unclassifiedDecision(
  surface: string,
  rationale: string
): ClassificationDecision {
  return {
    classification: "unclassified",
    deferralRationale: rationale,
    docsCorrection:
      "N/A - the docs authority freeze gate must classify this claim before closure.",
    evidence: EMPTY_EVIDENCE,
    followUpTicket: "Epic AD classifier update required",
    implementationEvidence: "N/A",
    surface,
  };
}

function renderSummary(entries: readonly CoverageEntry[]): string {
  const independentEntries = uniqueClaimEntries(entries);
  const byClassification = groupCount(
    independentEntries,
    (entry) => entry.classification
  );
  const byBoundary = groupCount(
    independentEntries,
    (entry) => entry.affectedBoundary
  );

  return [
    "# Epic AD Docs-to-Authority Freeze Gate Summary",
    "",
    "## Status",
    "",
    "Epic AD generated the normative claim inventory, coverage matrix, deferred-surface decisions, local-surface decisions, docs cleanup anchors, and TypeScript freeze gate report.",
    "",
    "## Source Inputs",
    "",
    "- `docs/KrakenFrameworkSpecification.md`",
    "- `docs/KrakenKernelSpecification.md`",
    "- `boundaries/*/contracts/*/spec/authority-packet.json`",
    "- `boundaries/*/conformance/plans/*.json`",
    "- `reports/compatibility/compatibility-matrix.json` and `reports/compatibility/evidence/*.json`",
    "",
    "## Claim Counts",
    "",
    `- Matrix rows: ${entries.length}`,
    `- Independent claims: ${independentEntries.length}`,
    `- Duplicate rows linked by \`duplicateOf\`: ${duplicateClaimCount(entries)}`,
    "",
    "## Independent Claims By Boundary",
    "",
    renderCountTable(byBoundary, "Boundary"),
    "",
    "## Independent Claims By Primary Classification",
    "",
    renderCountTable(byClassification, "Classification"),
    "",
    "## Generated Artifacts",
    "",
    `- Claim inventory: \`${INVENTORY_PATH}\``,
    `- Coverage matrix: \`${MATRIX_PATH}\``,
    `- Framework decisions: \`${FRAMEWORK_DECISIONS_PATH}\``,
    `- Kernel/backend/provider decisions: \`${LOCAL_DECISIONS_PATH}\``,
    `- Freeze gate report: \`${REPORT_PATH}\``,
    `- Closure inventory: \`${CLOSURE_PATH}\``,
    "",
  ].join("\n");
}

function renderFrameworkDecisions(entries: readonly CoverageEntry[]): string {
  const frameworkEntries = entries.filter(
    (entry) => entry.affectedBoundary === "framework"
  );
  const surfaces = groupBy(frameworkEntries, (entry) => entry.surface);

  return [
    "# Epic AD Framework Deferred-Surface Decisions",
    "",
    "## Status",
    "",
    "Framework deferred-surface decisions are recorded from the docs-to-authority matrix. Claims with `authority-backed-conformance-covered` are portable only through the named packets/plans/evidence. Every other framework surface below is local, implementation-defined, deferred, or explicitly outside portable authority.",
    "",
    renderSurfaceTable(surfaces),
    "",
    "## Freeze Decisions",
    "",
    "- Promoted through Epic AF: selected `KRT-AF001`, `KRT-AF003`, `KRT-AF004`, and `KRT-AF005` rows are now `authority-backed-conformance-covered`.",
    "- Implementation-defined: extension storage/composition details, synchronous workers, ordered pipelines, stream adapter package topology, and orchestration static config or extension scoping unless a later plan promotes them.",
    "- Explicitly deferred: future direct provider packages, worker process management, agent discovery, delegated construction modes, custom future protocols, and ordered pipeline product work.",
    "- Stale docs: preamble wording that implied Markdown was the single machine authority has been corrected by the docs authority notes.",
    "",
  ].join("\n");
}

function renderLocalSurfaceDecisions(
  entries: readonly CoverageEntry[]
): string {
  const selected = entries.filter(
    (entry) =>
      entry.affectedBoundary === "kernel" ||
      entry.surface.includes("provider") ||
      entry.surface.includes("tool")
  );
  const surfaces = groupBy(selected, (entry) => entry.surface);

  return [
    "# Epic AD Kernel, Backend, and Provider Local-Surface Decisions",
    "",
    "## Status",
    "",
    "Kernel, backend, provider, and tool surfaces are separated from cross-language authority unless the matrix maps them to a packet, shared plan, fixture, adapter capability, and compatibility evidence.",
    "",
    renderSurfaceTable(surfaces),
    "",
    "## Decisions",
    "",
    "- Official backend guarantees: kernel logical behavior is portable through `tuvren.kernel.protocol`; backend physical storage, acceleration indexes, SQLite details, and process-local choices remain implementation-defined.",
    "- Provider behavior: provider-neutral bridge behavior is portable through `tuvren.providers.provider-api`; provider-family packages and native wire-format mechanics remain deferred or local.",
    "- Tool and approval behavior: the provider-neutral rows selected by `KRT-AF004` are now shared-conformance-covered; provider-family-native mechanics remain local or deferred.",
    "- Optional extensions: run-liveness remains capability-gated through `kernel.run-liveness`; it is not retroactively folded into the base protocol for implementations that do not advertise it.",
    "",
  ].join("\n");
}

function renderFreezeGateReport(entries: readonly CoverageEntry[]): string {
  const independentEntries = uniqueClaimEntries(entries);
  const authorityCount = independentEntries.filter(
    (entry) => entry.classification === "authority-backed-conformance-covered"
  ).length;
  const blocking = independentEntries.filter((entry) =>
    [
      "implementation-local-evidence",
      "missing-conformance-follow-up",
      "stale-docs-corrected",
    ].includes(entry.classification)
  );
  const nonBlocking = independentEntries.filter((entry) =>
    ["implementation-defined", "explicitly-deferred"].includes(
      entry.classification
    )
  );
  const remaining = independentEntries.filter(
    (entry) => entry.classification !== "authority-backed-conformance-covered"
  );
  const remainingSurfaces = groupBy(remaining, (entry) => entry.surface);

  return [
    "# Epic AD TypeScript Freeze Gate Report",
    "",
    "## Decision",
    "",
    "Epic AD established the docs-to-authority classification gate; this generated report now incorporates the closed Epic AF promotions for the selected portable surfaces. TypeScript freeze-readiness for the currently promoted surfaces is recorded by the Epic AF closure inventory and remains scoped to those surfaces.",
    "",
    "Rust framework product work remains blocked until a later TechSpec/Tasks revision explicitly activates a product implementation line.",
    "",
    "## Authority-Backed and Conformance-Covered Claims",
    "",
    `- Independent claims currently classified as authority-backed and conformance-covered: ${authorityCount}`,
    `- Duplicate matrix rows linked by \`duplicateOf\`: ${duplicateClaimCount(entries)}`,
    "- Evidence anchors: framework, provider, and kernel authority packets; shared conformance plans; boundary fixtures/scenarios; adapter capabilities; and compatibility evidence under `reports/compatibility/evidence/`.",
    "",
    "## Remaining Surfaces",
    "",
    `- Potentially blocking because still implementation-local or stale-docs-corrected: ${blocking.length}`,
    `- Non-blocking because they are explicitly implementation-defined or deferred: ${nonBlocking.length}`,
    "",
    "## Remaining Surface Detail",
    "",
    "Every remaining non-authority surface is listed below with its current posture. Rows kept implementation-defined or explicitly deferred are not portable runtime authority.",
    "",
    renderSurfaceTable(remainingSurfaces),
    "",
    "## Freeze Closure Evidence",
    "",
    "- `KRT-AE009` recorded the TypeScript semantic gravity-well decomposition without public API churn.",
    "- `KRT-AF001` converted selected portability claims into a generated packet/plan/fixture/adapter/evidence gap plan.",
    "- `KRT-AF002` through `KRT-AF006` added the selected shared checks and kept local/deferred behavior out of portable authority.",
    "- `KRT-AF007` wired guardrails so docs/conformance drift fails validation unless generated artifacts are updated.",
    "- `KRT-AF008` regenerated clean evidence through `bun run verify`, `bun run release-check`, `bun run conformance`, `bun run codegen`, and `bun run interop-smoke`.",
    "- `reports/compatibility/compatibility-matrix.json` reports the final check-level evidence for every affected implementation.",
    "",
    "## Blocker Statement",
    "",
    "No future framework implementation line, including Rust framework product behavior, is activated by Epic AD/AE/AF closure alone. A later planning revision must still name the next implementation line and its evidence gates.",
    "",
  ].join("\n");
}

function renderClosureInventory(entries: readonly CoverageEntry[]): string {
  const independentEntries = uniqueClaimEntries(entries);

  return [
    "# Epic AD Docs-to-Authority Freeze Gate Closure Inventory",
    "",
    "## Status",
    "",
    "Epic AD is closed in current repo reality.",
    "",
    "## Delivered Scope",
    "",
    "- The active freeze-readiness scope was already activated in `.constitution/tasks/` and `.constitution/tech-spec/` before this closure pass.",
    `- The normative docs claim inventory covers ${entries.length} matrix rows and ${independentEntries.length} independent claims from ` +
      "`docs/KrakenFrameworkSpecification.md` and `docs/KrakenKernelSpecification.md`.",
    "- The docs-to-authority coverage matrix assigns exactly one primary classification to every row and links duplicate rows through `duplicateOf` instead of treating them as separate independent requirements.",
    "- Framework deferred-surface decisions and kernel/backend/provider local-surface decisions are checked in as Epic AD handoff records.",
    "- Docs preambles now distinguish human semantic authority from machine portability authority and point readers to the AD matrix for freeze-readiness classification.",
    "- The freeze gate report records that TypeScript is not freeze-ready from AD alone and that Rust framework remains blocked until AE/AF and a later planning revision close the gate.",
    "",
    "## Evidence Anchors",
    "",
    `- Claim inventory: \`${INVENTORY_PATH}\``,
    `- Coverage matrix: \`${MATRIX_PATH}\``,
    `- Summary: \`${SUMMARY_PATH}\``,
    `- Framework deferred decisions: \`${FRAMEWORK_DECISIONS_PATH}\``,
    `- Kernel/backend/provider decisions: \`${LOCAL_DECISIONS_PATH}\``,
    `- Freeze gate report: \`${REPORT_PATH}\``,
    "- Docs cleanup: `docs/KrakenFrameworkSpecification.md`; `docs/KrakenKernelSpecification.md`; `.constitution/tech-spec/`",
    "",
    "## Closure Notes",
    "",
    "- TypeScript implementation source, implementation tests, conformance adapters, generic runner code, and Markdown prose remain forbidden authority for cross-implementation meaning.",
    "- Epic AF owns promotion of any remaining portable behavior into packet-backed shared conformance.",
    "- Epic AE owns TypeScript modular hardening. Epic AD did not change runtime behavior.",
    "",
  ].join("\n");
}

function renderSurfaceTable(
  groups: ReadonlyMap<string, readonly CoverageEntry[]>
): string {
  const lines = [
    "| Surface | Independent Claims | Classifications | Follow-up | Blocks future implementation line? |",
    "| --- | ---: | --- | --- | --- |",
  ];

  for (const [surface, surfaceEntries] of [...groups.entries()].sort(
    ([left], [right]) => left.localeCompare(right)
  )) {
    const independentEntries = uniqueClaimEntries(surfaceEntries);
    const classifications = [
      ...new Set(independentEntries.map((entry) => entry.classification)),
    ].join(", ");
    const followUps = [
      ...new Set(independentEntries.map((entry) => entry.followUpTicket)),
    ]
      .filter((value) => value !== "N/A")
      .join(", ");
    const blocks = independentEntries.some((entry) =>
      [
        "implementation-local-evidence",
        "missing-conformance-follow-up",
        "stale-docs-corrected",
      ].includes(entry.classification)
    )
      ? "Yes, until AF/docs evidence resolves it"
      : "No, if kept local/deferred";

    lines.push(
      `| ${escapeTableCell(surface)} | ${independentEntries.length} | ${escapeTableCell(classifications)} | ${escapeTableCell(followUps || "N/A")} | ${blocks} |`
    );
  }

  return lines.join("\n");
}

function renderCountTable(
  counts: ReadonlyMap<string, number>,
  label: string
): string {
  const lines = [`| ${label} | Count |`, "| --- | ---: |"];
  for (const [key, count] of [...counts.entries()].sort(([left], [right]) =>
    left.localeCompare(right)
  )) {
    lines.push(`| ${escapeTableCell(key)} | ${count} |`);
  }
  return lines.join("\n");
}

function groupBy<T>(
  values: readonly T[],
  keySelector: (value: T) => string
): ReadonlyMap<string, readonly T[]> {
  const groups = new Map<string, T[]>();

  for (const value of values) {
    const key = keySelector(value);
    const existing = groups.get(key);
    if (existing == null) {
      groups.set(key, [value]);
    } else {
      existing.push(value);
    }
  }

  return groups;
}

function groupCount<T>(
  values: readonly T[],
  keySelector: (value: T) => string
): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();

  for (const value of values) {
    const key = keySelector(value);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return counts;
}

function duplicateClaimCount(
  entries: readonly Pick<NormativeClaim, "duplicateOf">[]
): number {
  return entries.filter((entry) => entry.duplicateOf != null).length;
}

function independentClaimCount(
  entries: readonly Pick<NormativeClaim, "duplicateOf">[]
): number {
  return uniqueClaimEntries(entries).length;
}

function uniqueClaimEntries<T extends Pick<NormativeClaim, "duplicateOf">>(
  entries: readonly T[]
): T[] {
  return entries.filter((entry) => entry.duplicateOf == null);
}

function normalizeClaimText(text: string): string {
  return text
    .replace(LEADING_LIST_MARKER_PATTERN, "")
    .replace(WHITESPACE_PATTERN, " ")
    .trim();
}

function toAnchor(heading: string): string {
  return `#${heading
    .toLowerCase()
    .replace(ANCHOR_BACKTICK_PATTERN, "")
    .replace(ANCHOR_UNSAFE_CHAR_PATTERN, "")
    .trim()
    .replace(WHITESPACE_PATTERN, "-")}`;
}

function toSectionKey(heading: string): string {
  const numbered = SECTION_NUMBER_PATTERN.exec(heading);
  if (numbered?.[1] != null) {
    return numbered[1];
  }

  if (heading.startsWith("Appendix")) {
    return "appendix";
  }

  return heading
    .toLowerCase()
    .replace(SECTION_UNSAFE_CHAR_PATTERN, "-")
    .replace(SECTION_TRAILING_DASH_PATTERN, "");
}

function escapeTableCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function formatJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function writeArtifacts(
  artifacts: readonly OutputArtifact[]
): Promise<void> {
  await mkdir(OUTPUT_DIR, { recursive: true });

  for (const artifact of artifacts) {
    await writeFile(artifact.path, artifact.content, "utf8");
  }
}

async function checkArtifacts(
  artifacts: readonly OutputArtifact[]
): Promise<void> {
  const stalePaths: string[] = [];

  for (const artifact of artifacts) {
    let currentContent: string;
    try {
      currentContent = await readFile(artifact.path, "utf8");
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        stalePaths.push(artifact.path);
        continue;
      }
      throw error;
    }

    if (currentContent !== artifact.content) {
      stalePaths.push(artifact.path);
    }
  }

  if (stalePaths.length > 0) {
    throw new Error(
      "docs authority freeze gate artifacts are stale. " +
        "Run `bun run docs:authority-freeze` and commit the updated files: " +
        stalePaths.join(", ")
    );
  }
}

if (import.meta.main) {
  await main();
}
