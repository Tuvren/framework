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

import { mkdir, readFile, writeFile } from "node:fs/promises";

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

const OUTPUT_DIR = "constitution/spikes";
const INVENTORY_PATH = `${OUTPUT_DIR}/epic-ad-normative-docs-claim-inventory.json`;
const MATRIX_PATH = `${OUTPUT_DIR}/epic-ad-docs-to-authority-coverage-matrix.json`;
const SUMMARY_PATH = `${OUTPUT_DIR}/epic-ad-docs-to-authority-freeze-gate-summary.md`;
const FRAMEWORK_DECISIONS_PATH = `${OUTPUT_DIR}/epic-ad-framework-deferred-surface-decisions.md`;
const LOCAL_DECISIONS_PATH = `${OUTPUT_DIR}/epic-ad-kernel-backend-provider-local-surface-decisions.md`;
const REPORT_PATH = `${OUTPUT_DIR}/epic-ad-typescript-freeze-gate-report.md`;
const CLOSURE_PATH = `${OUTPUT_DIR}/epic-ad-docs-to-authority-freeze-gate-closure-inventory.md`;

const NORMATIVE_PATTERN =
  /\b(must|must not|should|cannot|can not|never|always|required|requires|required|guarantee|guarantees|only|canonical|authoritative|valid|invalid|MUST|SHOULD|MAY)\b/i;
const ANCHOR_BACKTICK_PATTERN = /`/g;
const ANCHOR_UNSAFE_CHAR_PATTERN = /[^a-z0-9\s-]/g;
const HEADING_PATTERN = /^(#{1,6})\s+(.+)$/;
const LEADING_LIST_MARKER_PATTERN = /^\s*[-*]\s+/;
const LINE_SPLIT_PATTERN = /\r?\n/;
const LIST_ITEM_PATTERN = /^\s*(?:[-*]|\d+[.)])\s+/;
const SECTION_NUMBER_PATTERN = /^(\d+(?:\.\d+)*)\b/;
const SECTION_TRAILING_DASH_PATTERN = /-+$/g;
const SECTION_UNSAFE_CHAR_PATTERN = /[^a-z0-9]+/g;
const TABLE_ROW_PATTERN = /^\s*\|/;
const WHITESPACE_PATTERN = /\s+/g;
const CLAIM_ID_HASH_LENGTH = 12;

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
  generatedBy: string;
  normativePattern: string;
  rationaleSections: RationaleSection[];
  sources: string[];
  totalNormativeClaims: number;
}

interface CoverageMatrix {
  entries: CoverageEntry[];
  generatedBy: string;
  primaryClassificationRule: string;
  totalClaims: number;
  unclassifiedClaims: number;
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
      "boundaries/framework/contracts/driver-api/spec/authority-packet.json",
    compatibilityEvidence:
      "reports/compatibility/evidence/shared-conformance-runner.typescript-framework.json",
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
      "boundaries/framework/contracts/event-stream/spec/authority-packet.json",
    compatibilityEvidence:
      "reports/compatibility/evidence/shared-conformance-runner.typescript-framework.json",
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
      "reports/compatibility/evidence/shared-conformance-runner.typescript-kernel-sqlite.json; reports/compatibility/evidence/shared-conformance-runner.rust-kernel.json",
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
      "reports/compatibility/evidence/shared-conformance-runner.typescript-providers.json",
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
      "reports/compatibility/evidence/shared-conformance-runner.typescript-framework.json",
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
      "boundaries/framework/contracts/runtime-api/spec/authority-packet.json",
    compatibilityEvidence:
      "reports/compatibility/evidence/shared-conformance-runner.typescript-framework.json",
    conformancePlan:
      "boundaries/framework/conformance/plans/runtime-api-lifecycle.json; boundaries/framework/conformance/plans/runtime-api-lifecycle-extended.json; boundaries/framework/conformance/plans/runtime-api-callables.json; boundaries/framework/conformance/plans/runtime-api-callables-extended.json",
    fixture:
      "boundaries/framework/conformance/scenarios/runtime-api-scenarios.json",
    generatedArtifact:
      "boundaries/framework/contracts/runtime-api/artifacts/json-schema",
  },
  runtimeOrchestration: {
    adapterCapability: "framework.orchestration",
    authorityPacket:
      "boundaries/framework/contracts/runtime-api/spec/authority-packet.json",
    compatibilityEvidence:
      "reports/compatibility/evidence/shared-conformance-runner.typescript-framework.json",
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
      "reports/compatibility/evidence/shared-conformance-runner.typescript-kernel-sqlite.json; reports/compatibility/evidence/shared-conformance-runner.typescript-framework.json",
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
      "reports/compatibility/evidence/shared-conformance-runner.typescript-kernel-sqlite.json",
    conformancePlan:
      "boundaries/kernel/conformance/plans/kernel-restart-recovery.json",
    fixture:
      "boundaries/kernel/conformance/fixtures/kernel-protocol-logical.json",
    generatedArtifact:
      "N/A - restart recovery is conformance-plan authority without generated schema artifacts",
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

  await mkdir(OUTPUT_DIR, { recursive: true });
  await writeJson(INVENTORY_PATH, {
    generatedBy: "bun tools/scripts/docs-authority-freeze-gate.ts",
    normativePattern: NORMATIVE_PATTERN.source,
    rationaleSections,
    sources: DOC_SOURCES.map((source) => source.path),
    totalNormativeClaims: claimsWithDuplicates.length,
    claims: inventoryClaims,
  } satisfies ClaimInventory);
  await writeJson(MATRIX_PATH, {
    generatedBy: "bun tools/scripts/docs-authority-freeze-gate.ts",
    primaryClassificationRule:
      "Each normative claim receives exactly one primary classification derived from its source section and explicit text markers.",
    totalClaims: matrixEntries.length,
    unclassifiedClaims: unclassifiedEntries.length,
    entries: matrixEntries,
  } satisfies CoverageMatrix);

  await writeFile(SUMMARY_PATH, renderSummary(matrixEntries), "utf8");
  await writeFile(
    FRAMEWORK_DECISIONS_PATH,
    renderFrameworkDecisions(matrixEntries),
    "utf8"
  );
  await writeFile(
    LOCAL_DECISIONS_PATH,
    renderLocalSurfaceDecisions(matrixEntries),
    "utf8"
  );
  await writeFile(REPORT_PATH, renderFreezeGateReport(matrixEntries), "utf8");
  await writeFile(CLOSURE_PATH, renderClosureInventory(matrixEntries), "utf8");

  console.log(
    `docs authority freeze gate generated ${matrixEntries.length} classified claims`
  );
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

  await parseStandaloneClaimLine(state, heading, trimmed, line);
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

  if (NORMATIVE_PATTERN.test(claimText)) {
    await pushClaim(state, block.heading, claimText, block.line);
    return;
  }

  addRationaleLines(state, block.heading, block.lines.length);
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

  if (section === "preamble" || section === "0") {
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

function classifyFrameworkCoreSection(
  section: string,
  text: string
): ClassificationDecision | null {
  if (section.startsWith("1.8") || section.startsWith("6")) {
    return authorityDecision("framework event stream", EVIDENCE.eventStream);
  }

  if (section.startsWith("1.5") || section.startsWith("4.10")) {
    return authorityDecision(
      "runtime resolution and errors",
      EVIDENCE.runtimeApi
    );
  }

  if (section.startsWith("1.7") || section.startsWith("8")) {
    return missingConformanceDecision(
      "tool and approval contracts",
      EVIDENCE.runtimeApi,
      "KRT-AF004",
      "Tool and approval shapes have TypeScript artifacts and runtime evidence, but the freeze pass keeps them out of portable truth until AF selects neutral checks."
    );
  }

  if (section.startsWith("1")) {
    return missingConformanceDecision(
      "shared framework type shapes",
      EVIDENCE.runtimeApi,
      "KRT-AF001",
      "Shared type prose is not by itself portable truth; AF must decide whether to promote more shape checks or leave them as binding projections."
    );
  }

  if (section.startsWith("2")) {
    return implementationLocalDecision(
      "framework state schema",
      "boundaries/framework/implementations/typescript/runtime-core/test/runtime-core.test.ts",
      "Framework default state layout remains TypeScript runtime-core evidence unless AF promotes a portable state-schema packet or checks."
    );
  }

  return classifyFrameworkIntegrationSection(section, text);
}

function classifyFrameworkIntegrationSection(
  section: string,
  text: string
): ClassificationDecision | null {
  if (section.startsWith("3.4") || text.includes("provider-anthropic")) {
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

  if (section.startsWith("3")) {
    return authorityDecision("provider API bridge", EVIDENCE.providerApi);
  }

  if (section === "approval-resume") {
    return missingConformanceDecision(
      "approval resume semantics",
      EVIDENCE.runtimeApi,
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

  if (section.startsWith("4.8") || section.startsWith("4.9")) {
    return authorityDecision(
      "runtime lifecycle recovery",
      EVIDENCE.runLiveness
    );
  }

  if (section.startsWith("4")) {
    return authorityDecision(
      "runtime and ReAct execution",
      EVIDENCE.runtimeApi
    );
  }

  if (section.startsWith("5.6")) {
    return authorityDecision("driver contract", EVIDENCE.driverApi);
  }

  if (section.startsWith("5.3") || section.startsWith("9")) {
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

  if (section.startsWith("5")) {
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

  if (section.startsWith("7")) {
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

  if (section.startsWith("10.1") || section.startsWith("10.7")) {
    return implementationDefinedDecision(
      "orchestration static config and extension scoping",
      "Epic AC left static config snapshotting and extension scoping as local evidence; KRT-AF005 decides whether to promote or keep them local."
    );
  }

  if (section.startsWith("10.2") || section.startsWith("10.5")) {
    return implementationDefinedDecision(
      "orchestration optional worker modes",
      "Synchronous workers and ordered pipelines are explicitly above the shared-core freeze surface."
    );
  }

  if (section.startsWith("10.9")) {
    return deferredDecision(
      "orchestration out-of-core boundaries",
      "Worker process management, agent discovery, delegated construction modes, and related higher-layer concerns require a later product plan."
    );
  }

  if (section.startsWith("10")) {
    return authorityDecision(
      "runtime orchestration",
      EVIDENCE.runtimeOrchestration
    );
  }

  return null;
}

function classifyKernelClaim(claim: NormativeClaim): ClassificationDecision {
  const section = claim.sectionKey;
  const text = claim.text.toLowerCase();
  const postureDecision = classifyKernelPostureText(text);
  if (postureDecision != null) {
    return postureDecision;
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
  const byClassification = groupCount(entries, (entry) => entry.classification);
  const byBoundary = groupCount(entries, (entry) => entry.affectedBoundary);

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
    renderCountTable(byBoundary, "Boundary"),
    "",
    "## Primary Classification Counts",
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
    "Framework deferred-surface decisions are recorded from the docs-to-authority matrix. Claims with `authority-backed-conformance-covered` are portable only through the named packets/plans/evidence. Every other framework surface below is either local, implementation-defined, deferred, stale-corrected, or queued for Epic AF.",
    "",
    renderSurfaceTable(surfaces),
    "",
    "## Freeze Decisions",
    "",
    "- Promote now through Epic AF: claims classified as `missing-conformance-follow-up`, routed to `KRT-AF001`, `KRT-AF003`, `KRT-AF004`, or `KRT-AF005`.",
    "- Implementation-defined: extension storage/composition details, synchronous workers, ordered pipelines, and orchestration static config or extension scoping unless AF promotes them.",
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
    "- Tool and approval behavior: current TypeScript artifacts and runtime checks are implementation evidence until `KRT-AF004` promotes neutral checks into shared conformance.",
    "- Optional extensions: run-liveness remains capability-gated through `kernel.run-liveness`; it is not retroactively folded into the base protocol for implementations that do not advertise it.",
    "",
  ].join("\n");
}

function renderFreezeGateReport(entries: readonly CoverageEntry[]): string {
  const authorityCount = entries.filter(
    (entry) => entry.classification === "authority-backed-conformance-covered"
  ).length;
  const blocking = entries.filter((entry) =>
    [
      "implementation-local-evidence",
      "missing-conformance-follow-up",
      "stale-docs-corrected",
    ].includes(entry.classification)
  );
  const nonBlocking = entries.filter((entry) =>
    ["implementation-defined", "explicitly-deferred"].includes(
      entry.classification
    )
  );
  const remaining = entries.filter(
    (entry) => entry.classification !== "authority-backed-conformance-covered"
  );
  const remainingSurfaces = groupBy(remaining, (entry) => entry.surface);

  return [
    "# Epic AD TypeScript Freeze Gate Report",
    "",
    "## Decision",
    "",
    "TypeScript is not yet a freeze-closure candidate at the end of Epic AD alone. Epic AD establishes the docs-to-authority classification gate. TypeScript freeze closure still requires Epic AE modular hardening, Epic AF conformance expansion and freshness guardrails, and fresh clean-checkout evidence.",
    "",
    "Rust framework product work remains blocked until Epic AF closes and a later TechSpec/Tasks revision explicitly activates a product implementation line.",
    "",
    "## Authority-Backed and Conformance-Covered Claims",
    "",
    `- Claims currently classified as authority-backed and conformance-covered: ${authorityCount}`,
    "- Evidence anchors: framework, provider, and kernel authority packets; shared conformance plans; boundary fixtures/scenarios; adapter capabilities; and compatibility evidence under `reports/compatibility/evidence/`.",
    "",
    "## Remaining Surfaces",
    "",
    `- Potentially blocking until AE/AF or docs correction evidence closes: ${blocking.length}`,
    `- Non-blocking because they are explicitly implementation-defined or deferred: ${nonBlocking.length}`,
    "",
    "## Remaining Surface Detail",
    "",
    "Every remaining non-authority surface is listed below with its current blocker posture. `missing-conformance-follow-up` rows are blocking until AF either promotes checks or explicitly leaves the behavior local/deferred.",
    "",
    renderSurfaceTable(remainingSurfaces),
    "",
    "## Exact Evidence Required for Freeze Closure",
    "",
    "- `KRT-AE009` must show the TypeScript semantic gravity wells have been decomposed without public API churn.",
    "- `KRT-AF001` must convert every `missing-conformance-follow-up` claim selected for portability into packet/plan/fixture/adapter/evidence work.",
    "- `KRT-AF002` through `KRT-AF006` must add the selected shared checks and keep local/deferred behavior out of portable authority.",
    "- `KRT-AF007` must wire guardrails so docs normative drift fails validation unless the matrix is updated.",
    "- `KRT-AF008` must regenerate clean evidence through `bun run verify`, `bun run release-check`, `bun run conformance`, `bun run codegen`, and `bun run interop-smoke`.",
    "- `reports/compatibility/compatibility-matrix.json` must report the final check-level evidence for every affected implementation.",
    "",
    "## Blocker Statement",
    "",
    "No future framework implementation line, including Rust framework product behavior, is unblocked by Epic AD alone. The earliest unblock point is after Epic AF and AE close, with a later planning revision naming the next implementation line.",
    "",
  ].join("\n");
}

function renderClosureInventory(entries: readonly CoverageEntry[]): string {
  return [
    "# Epic AD Docs-to-Authority Freeze Gate Closure Inventory",
    "",
    "## Status",
    "",
    "Epic AD is closed in current repo reality.",
    "",
    "## Delivered Scope",
    "",
    "- The active freeze-readiness scope was already activated in `constitution/Tasks.md` and `constitution/TechSpec.md` before this closure pass.",
    `- The normative docs claim inventory covers ${entries.length} claims from ` +
      "`docs/KrakenFrameworkSpecification.md` and `docs/KrakenKernelSpecification.md`.",
    "- The docs-to-authority coverage matrix assigns exactly one primary classification to every claim.",
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
    "- Docs cleanup: `docs/KrakenFrameworkSpecification.md`; `docs/KrakenKernelSpecification.md`; `constitution/TechSpec.md`",
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
    "| Surface | Claims | Classifications | Follow-up | Blocks future implementation line? |",
    "| --- | ---: | --- | --- | --- |",
  ];

  for (const [surface, surfaceEntries] of [...groups.entries()].sort(
    ([left], [right]) => left.localeCompare(right)
  )) {
    const classifications = [
      ...new Set(surfaceEntries.map((entry) => entry.classification)),
    ].join(", ");
    const followUps = [
      ...new Set(surfaceEntries.map((entry) => entry.followUpTicket)),
    ]
      .filter((value) => value !== "N/A")
      .join(", ");
    const blocks = surfaceEntries.some((entry) =>
      [
        "implementation-local-evidence",
        "missing-conformance-follow-up",
        "stale-docs-corrected",
      ].includes(entry.classification)
    )
      ? "Yes, until AF/docs evidence resolves it"
      : "No, if kept local/deferred";

    lines.push(
      `| ${escapeTableCell(surface)} | ${surfaceEntries.length} | ${escapeTableCell(classifications)} | ${escapeTableCell(followUps || "N/A")} | ${blocks} |`
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

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

if (import.meta.main) {
  await main();
}
