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

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import process from "node:process";

const MATRIX_PATH =
  ".constitution/reports/epic-ad-docs-to-authority-coverage-matrix.json";
const PLAN_JSON_PATH =
  ".constitution/reports/epic-af-conformance-gap-plan.json";
const PLAN_MD_PATH = ".constitution/reports/epic-af-conformance-gap-plan.md";
const BOUNDARIES_ROOT = "boundaries";

type MatrixClassification =
  | "authority-backed-conformance-covered"
  | "explicitly-deferred"
  | "implementation-defined"
  | "implementation-local-evidence"
  | "missing-conformance-follow-up";

type SurfaceDisposition = "exclude" | "promote";

interface CoverageMatrix {
  entries: CoverageEntry[];
}

interface CoverageEntry {
  adapterCapability: string;
  authorityPacket: string;
  claimId: string;
  classification: MatrixClassification;
  compatibilityEvidence: string;
  conformancePlan: string;
  fixture: string;
  followUpTicket: string;
  generatedArtifact: string;
  sourceFile: string;
  surface: string;
}

interface SurfacePlan {
  adapterOperation: string;
  authorityPacket?: string;
  capabilityRequirement: string;
  checkIds: string[];
  conformancePlan?: string;
  deliveryTicket: string;
  disposition: SurfaceDisposition;
  evidenceUpdate: string;
  fixture?: string;
  rationale: string;
  requiredEvidence: string[];
}

interface PlannedSurface extends SurfacePlan {
  adapterCapability: string;
  authorityPacket: string;
  claimIds: string[];
  classifications: MatrixClassification[];
  compatibilityEvidence: string;
  conformancePlan: string;
  fixture: string;
  generatedArtifact: string;
  matrixFollowUpTickets: string[];
  surface: string;
}

interface GapPlan {
  generatedBy: string;
  matrixPath: string;
  promoteNowClaims: number;
  surfaces: PlannedSurface[];
}

interface CliOptions {
  check: boolean;
}

const SURFACE_PLANS: Readonly<Record<string, SurfacePlan>> = {
  "ReAct and extension hooks": {
    adapterOperation: "driver.execute",
    capabilityRequirement: "framework.react-driver",
    checkIds: [
      "react-driver-af.extension.phase-order-before-around-after",
      "react-driver-af.extension.around-tool-nesting",
      "react-driver-af.extension.after-iteration-terminal-state-nondurable",
    ],
    deliveryTicket: "KRT-AF003",
    disposition: "promote",
    evidenceUpdate:
      "Refresh TypeScript and Rust-framework non-applicable compatibility evidence after react-driver-extended gains AF checks.",
    rationale:
      "Hook ordering and around-hook nesting are portable ReAct behavior; adapter observations must expose traces, not expected sequences.",
    requiredEvidence: [
      "hooks.phaseTrace",
      "hooks.aroundToolTrace",
      "hooks.terminalMutationAttempted",
      "hooks.terminalMutationDurableText",
    ],
  },
  "approval and cancellation control": {
    adapterOperation: "runtime.approval-resolve; runtime.cancel-execution",
    capabilityRequirement:
      "framework.runtime-api; providers.framework-owned-approval-boundary",
    checkIds: [
      "runtime-lifecycle-af.cancel-running-idempotent-fails-once",
      "runtime-callable-af.approval-resume-new-handle-only",
      "runtime-callable-af.approval-reject-stages-tool-result",
      "runtime-callable-af.paused-cancel-rejection-and-stop",
    ],
    deliveryTicket: "KRT-AF002/KRT-AF004",
    disposition: "promote",
    evidenceUpdate:
      "Refresh framework compatibility evidence with lifecycle negative and approval boundary outcomes; Rust framework remains non-applicable.",
    rationale:
      "Running cancellation, approval resume, rejection, and paused cancellation are high-risk lifecycle/tool interleavings selected for portability.",
    requiredEvidence: [
      "cancellation.cancelInvocations",
      "approval.cancelledPhase",
      "approval.cancelledToolResults.1.isError",
      "approval.handleOwnership.cancelErrorCode",
      "approval.handleOwnership.resolveApprovalErrorCode",
      "approval.resumedPhase",
      "approval.resumedTextAbsent",
      "approval.toolResults.1.isError",
      "approval.toolResults.1.output.decisionType",
      "cancellation.errorEventCount",
      "runtime.phase",
      "tool.execution.executedNamesAfterCancel",
    ],
  },
  "approval resume semantics": {
    adapterOperation: "runtime.approval-resolve",
    capabilityRequirement: "framework.runtime-api",
    checkIds: [
      "runtime-callable-af.approval-resume-same-turn",
      "runtime-callable-af.approval-resume-reruns-unfinished-tools-only",
    ],
    deliveryTicket: "KRT-AF004",
    disposition: "promote",
    evidenceUpdate:
      "Refresh framework compatibility evidence with same-turn resume and unfinished-tool-only traces.",
    rationale:
      "Approval resume is a shared control surface; the adapter must report observations about turn identity and tool execution names only.",
    requiredEvidence: [
      "approval.sameTurn",
      "tool.execution.executedNamesBeforeResume",
      "tool.execution.executedNamesAfterResume",
    ],
  },
  "aroundModel live/durable reconciliation": {
    adapterOperation: "driver.execute",
    capabilityRequirement: "framework.react-driver",
    checkIds: [
      "react-driver-af.around-model-post-stream-replacement",
      "react-driver-af.around-model-retry-final-response-durable",
    ],
    deliveryTicket: "KRT-AF003",
    disposition: "promote",
    evidenceUpdate:
      "Refresh framework compatibility evidence with live-event and durable-message reconciliation traces.",
    rationale:
      "The live-versus-durable aroundModel exception is portable only through explicit reconciliation evidence.",
    requiredEvidence: [
      "aroundModel.finalAssistantText",
      "aroundModel.messageStartCount",
      "aroundModel.streamedTextDone",
      "provider.generate.callCount",
    ],
  },
  "framework state schema": {
    adapterOperation: "runtime.context-transform; runtime.cancel-execution",
    authorityPacket:
      "boundaries/shared/contracts/core/spec/authority-packet.json",
    capabilityRequirement: "framework.runtime-api",
    checkIds: [
      "runtime-lifecycle-af.cancel-running-idempotent-fails-once",
      "runtime-lifecycle-af.cancel-running-stages-partial-status",
      "runtime-lifecycle-af.context-transform-preserves-source-checkpoint",
      "runtime-lifecycle-af.context-transform-creates-new-tree-heads",
      "runtime-lifecycle-af.context-transform-driver-sees-rewritten-context",
    ],
    conformancePlan:
      "boundaries/framework/conformance/plans/runtime-api-lifecycle-extended.json",
    deliveryTicket: "KRT-AF001",
    disposition: "promote",
    evidenceUpdate:
      "Refresh framework compatibility evidence with runtime.status.partial and context-engineering tree-head observations; Rust framework remains non-applicable.",
    fixture:
      "boundaries/framework/conformance/scenarios/runtime-api-scenarios.json",
    rationale:
      "The full TypeScript state layout stays implementation-local, but runtime.status.partial and context-engineering new-tree/source-checkpoint observations are portable runtime-api behavior.",
    requiredEvidence: [
      "cancellation.runtimeStatusPartial",
      "cancellation.partialAssistantText",
      "context.sourceMessageCount",
      "context.rewrittenMessageCount",
      "context.createdNewHead",
      "context.snapshotMessageCounts",
      "context.driverObservedMessageCount",
    ],
  },
  "handoff and context engineering": {
    adapterOperation: "runtime.orchestration.execution-inheritance",
    capabilityRequirement: "framework.orchestration",
    checkIds: [
      "runtime-orchestration-af.handoff-resolution-not-history-entry",
      "runtime-orchestration-af.handoff-last-output-only-builder",
      "runtime-orchestration-af.handoff-rejects-multiple-intents",
    ],
    deliveryTicket: "KRT-AF005",
    disposition: "promote",
    evidenceUpdate:
      "Refresh framework compatibility evidence for promoted orchestration handoff observations; Rust framework remains non-applicable.",
    rationale:
      "Handoff behavior is selected for runtime-api orchestration promotion; static config snapshotting and extension scoping stay implementation-defined.",
    requiredEvidence: [
      "orchestration.surfaces.handoffHistoryControlEntryAbsent",
      "orchestration.surfaces.handoffInvalidCompositionError.code",
      "orchestration.surfaces.handoffLastOutputOnlyNoSourceSignal",
      "orchestration.surfaces.handoffLastOutputOnlyText",
    ],
  },
  "kernel appendix validation matrix": {
    adapterOperation: "kernel.protocol.edge-validation",
    capabilityRequirement: "kernel.edge-validation",
    checkIds: [
      "kernel-protocol-af.schema-register-rejects-duplicate-path",
      "kernel-protocol-af.tree-create-rejects-missing-required-path",
      "kernel-protocol-af.tree-diff-rejects-schema-mismatch",
      "kernel-protocol-af.run-create-rejects-busy-branch",
      "kernel-protocol-af.run-begin-step-rejects-out-of-order-step",
      "kernel-protocol-af.run-complete-rejects-missing-event-object",
      "kernel-protocol-af.branch-set-head-rejects-lateral-lineage",
    ],
    deliveryTicket: "KRT-AF006",
    disposition: "promote",
    evidenceUpdate:
      "Refresh TypeScript memory, TypeScript SQLite, and Rust kernel compatibility evidence with check-level edge outcomes.",
    rationale:
      "Portable appendix legality claims receive negative checks; SQLite physical storage behavior remains excluded.",
    requiredEvidence: [
      "protocolEdgeValidation.branch.lateralHeadCode",
      "protocolEdgeValidation.run.busyBranchCode",
      "protocolEdgeValidation.run.missingEventObjectCode",
      "protocolEdgeValidation.run.outOfOrderStepCode",
      "protocolEdgeValidation.schema.duplicatePathCode",
      "protocolEdgeValidation.tree.missingRequiredPathCode",
      "protocolEdgeValidation.tree.schemaMismatchCode",
    ],
  },
  "kernel recovery edge states": {
    adapterOperation:
      "kernel.restart-recovery.close-reopen-checkpoint; kernel.run-liveness.stale-preemption; kernel.run-liveness.expired-listing",
    capabilityRequirement: "kernel.restart-recovery; kernel.run-liveness",
    checkIds: [
      "kernel-restart-af.invalid-staged-result-reexecutes",
      "kernel-restart-af.expired-running-requires-preemption",
      "kernel-restart-af.paused-run-excluded-from-stale-preemption",
    ],
    conformancePlan:
      "boundaries/kernel/conformance/plans/kernel-restart-recovery.json; boundaries/kernel/conformance/plans/kernel-run-liveness.json",
    deliveryTicket: "KRT-AF006",
    disposition: "promote",
    evidenceUpdate:
      "Refresh SQLite restart-recovery evidence and report memory/Rust support according to advertised capabilities.",
    rationale:
      "Only portable restart/recovery edge states are promoted; backend crash-injection mechanics remain adapter-local observations.",
    requiredEvidence: [
      "listing.pausedRunListed",
      "listing.pausedRunStatus",
      "preemption.leaseCleared",
      "preemption.preemptionReason",
      "preemption.runStatus",
      "restartRecovery.recoveredLastCompletedStepId",
      "restartRecovery.recoveredUncommittedCount",
      "restartRecovery.uncommittedNotPromoted",
    ],
  },
  "runtime loop policy": {
    adapterOperation: "driver.execute",
    capabilityRequirement: "framework.driver-api",
    checkIds: ["driver-api-af.invalid-loop-policy-tool-call-hard-fail"],
    deliveryTicket: "KRT-AF003",
    disposition: "promote",
    evidenceUpdate:
      "Refresh framework compatibility evidence with invalid_loop_policy error envelope.",
    rationale:
      "Invalid tool-call loop-policy combinations are shared driver-seam behavior.",
    requiredEvidence: ["driver.resolutionType", "result.error.code"],
  },
  "shared framework type shapes": {
    adapterOperation:
      "runtime.provider-generate; runtime.validate-structured-output",
    capabilityRequirement: "framework.runtime-api",
    checkIds: [
      "runtime-callable-af.content-tool-call-input-parsed",
      "runtime-callable-af.content-structured-data-parsed",
      "runtime-callable-af.input-signal-empty-parts-rejected",
      "runtime-callable-af.structured-output-default-draft07",
    ],
    deliveryTicket: "KRT-AF004",
    disposition: "promote",
    evidenceUpdate:
      "Refresh framework compatibility evidence for runtime-api type-shape checks; generated runtime-api artifacts remain the type projection anchor.",
    rationale:
      "Only boundary-visible runtime type-shape claims are promoted; TypeScript package layout and state internals stay local.",
    requiredEvidence: [
      "provider.generate.response.parts.0.input.query",
      "provider.generate.response.parts.0.data.answer",
      "inputSignal.error.code",
      "inputSignal.accepted",
      "validation.dialect",
    ],
  },
  "stream adapter package topology": {
    adapterOperation: "N/A",
    capabilityRequirement: "N/A",
    checkIds: [],
    deliveryTicket: "KRT-AF001",
    disposition: "exclude",
    evidenceUpdate:
      "No shared conformance update; package topology remains TypeScript implementation-line evidence.",
    rationale:
      "Package names, AG-UI pinning, and tee helper topology are implementation/package-management evidence, not portable runtime semantics.",
    requiredEvidence: [],
  },
  "structured output contract": {
    adapterOperation:
      "runtime.provider-stream; runtime.validate-structured-output",
    capabilityRequirement:
      "framework.runtime-api; providers.rejects-native-strict-structured-output",
    checkIds: [
      "runtime-callable-af.structured-stream-synthesizes-delta-before-done",
      "runtime-callable-af.structured-validation-hard-fail-code",
      "runtime-callable-af.structured-provider-native-type-hidden",
    ],
    deliveryTicket: "KRT-AF004",
    disposition: "promote",
    evidenceUpdate:
      "Refresh framework and provider compatibility evidence for neutral structured-output failure and streaming behavior.",
    rationale:
      "Shared checks assert provider-neutral structured-output semantics without standardizing provider-native mechanics.",
    requiredEvidence: [
      "provider.generate.partKeys.0",
      "provider.stream.structuredDeltaIndex",
      "provider.stream.structuredDoneIndex",
      "validation.error.code",
      "validation.resolutionType",
    ],
  },
  "tool and approval contracts": {
    adapterOperation: "runtime.tool-execute; runtime.approval-resolve",
    authorityPacket:
      "boundaries/shared/contracts/core/spec/authority-packet.json",
    capabilityRequirement:
      "framework.runtime-api; providers.framework-owned-tool-execution",
    checkIds: [
      "tool-contracts-af.tool-call-id-owned-by-framework",
      "tool-contracts-af.tool-failure-produces-error-result-not-run-fail",
      "tool-contracts-af.approval-message-attaches-to-tool-result",
    ],
    conformancePlan:
      "boundaries/framework/conformance/plans/tool-contracts-extended.json",
    deliveryTicket: "KRT-AF004",
    disposition: "promote",
    evidenceUpdate:
      "Refresh framework and provider compatibility evidence for tool execution and approval-boundary traces.",
    rationale:
      "The portable surface is framework-owned call/result/error shape, not provider-family-specific metadata.",
    requiredEvidence: [
      "provider.stream.response.parts.0.providerMetadata.providerCallId",
      "provider.stream.toolCallIdOwnedByFramework",
      "tool.execution.toolResults.0.isError",
      "tool.execution.toolResults.0.output.error",
      "toolExecution.status.phase",
      "approval.messageAttachment",
    ],
  },
  "tool parallelism and event ordering": {
    adapterOperation: "runtime.tool-execute",
    authorityPacket:
      "boundaries/shared/contracts/core/spec/authority-packet.json",
    capabilityRequirement: "framework.runtime-api",
    checkIds: [
      "tool-contracts-af.tool-parallel-wave-starts-before-results",
      "tool-contracts-af.mixed-approval-gated-tool-start-after-resume",
    ],
    conformancePlan:
      "boundaries/framework/conformance/plans/tool-contracts-extended.json",
    deliveryTicket: "KRT-AF004",
    disposition: "promote",
    evidenceUpdate:
      "Refresh framework compatibility evidence with event-order traces and durable result ordering.",
    rationale:
      "Parallel wave and mixed approval ordering are high-risk interleavings selected for portable conformance.",
    requiredEvidence: [
      "tool.execution.eventTypes",
      "tool.execution.parallelWaveStartedBeforeResults",
      "approval.resumedEventTypes",
      "approval.gatedToolStartAfterResume",
    ],
  },
  "worker subtree event forwarding": {
    adapterOperation: "runtime.orchestration.nested-attribution",
    capabilityRequirement: "framework.orchestration",
    checkIds: ["runtime-orchestration-af.worker-forwarded-event-source"],
    deliveryTicket: "KRT-AF005",
    disposition: "promote",
    evidenceUpdate:
      "Refresh framework compatibility evidence with forwarded worker source attribution.",
    rationale:
      "Forwarded worker events are promoted only as attributed event observations, not as a worker scheduler contract.",
    requiredEvidence: [
      "orchestration.nested.rootGrandchildSource.agent",
      "orchestration.nested.rootGrandchildSource.threadId",
      "orchestration.nested.rootGrandchildSource.workerId",
    ],
  },
};

const PROMOTED_CLASSIFICATIONS = new Set<MatrixClassification>([
  "implementation-local-evidence",
  "missing-conformance-follow-up",
]);

const EPIC_AF_FOLLOW_UP_PREFIX = "KRT-AF";

async function main(): Promise<void> {
  const options = readCliOptions(process.argv.slice(2));
  const matrix = readCoverageMatrix(
    JSON.parse(await readFile(MATRIX_PATH, "utf8")) as unknown
  );
  const plannedSurfaces = createPlannedSurfaces(matrix.entries);
  const plan: GapPlan = {
    generatedBy: "bun tools/scripts/epic-af-conformance-gap-plan.ts",
    matrixPath: MATRIX_PATH,
    promoteNowClaims: plannedSurfaces
      .filter((surface) => surface.disposition === "promote")
      .reduce((count, surface) => count + surface.claimIds.length, 0),
    surfaces: plannedSurfaces,
  };

  const artifacts = [
    {
      content: `${renderJson(plan)}\n`,
      path: PLAN_JSON_PATH,
    },
    {
      content: renderMarkdown(plan),
      path: PLAN_MD_PATH,
    },
  ];

  if (options.check) {
    await checkGeneratedArtifacts(artifacts);
    const implementedChecks = await readImplementedCheckEvidence();
    checkPromotedCheckIdsAreImplemented(plan, implementedChecks);
    checkPromotedEvidenceIsDeclared(plan, implementedChecks);
    checkPromotedSurfacesAreConcrete(plan);
    return;
  }

  for (const artifact of artifacts) {
    await writeGeneratedFile(artifact.path, artifact.content);
  }
}

function readCliOptions(args: readonly string[]): CliOptions {
  const options = {
    check: false,
  };

  for (const arg of args) {
    if (arg === "--check") {
      options.check = true;
      continue;
    }

    throw new Error(`unknown Epic AF gap plan argument ${arg}`);
  }

  return options;
}

async function checkGeneratedArtifacts(
  artifacts: readonly Array<{ content: string; path: string }>
): Promise<void> {
  const drifted: string[] = [];

  for (const artifact of artifacts) {
    const current = await readFile(artifact.path, "utf8");

    if (current !== artifact.content) {
      drifted.push(artifact.path);
    }
  }

  if (drifted.length > 0) {
    throw new Error(
      `Epic AF gap plan artifacts are stale; regenerate with bun run docs:af-gap-plan: ${drifted.join(", ")}`
    );
  }
}

function checkPromotedCheckIdsAreImplemented(
  plan: GapPlan,
  implementedChecks: ReadonlyMap<string, ReadonlySet<string>>
): void {
  const missingCheckIds = plan.surfaces
    .filter((surface) => surface.disposition === "promote")
    .flatMap((surface) => surface.checkIds)
    .filter((checkId) => !implementedChecks.has(checkId));

  if (missingCheckIds.length > 0) {
    throw new Error(
      `Epic AF gap plan references promoted checks that are missing from boundary conformance plans: ${uniqueSorted(missingCheckIds).join(", ")}`
    );
  }
}

function checkPromotedEvidenceIsDeclared(
  plan: GapPlan,
  implementedChecks: ReadonlyMap<string, ReadonlySet<string>>
): void {
  const missingEvidence: string[] = [];

  for (const surface of plan.surfaces) {
    if (surface.disposition !== "promote") {
      continue;
    }

    const declaredEvidence = new Set<string>();

    for (const checkId of surface.checkIds) {
      for (const path of implementedChecks.get(checkId) ?? []) {
        declaredEvidence.add(path);
      }
    }

    for (const path of surface.requiredEvidence) {
      if (!declaredEvidence.has(path)) {
        missingEvidence.push(`${surface.surface}: ${path}`);
      }
    }
  }

  if (missingEvidence.length > 0) {
    throw new Error(
      `Epic AF promoted surfaces reference evidence not declared by their planned checks: ${missingEvidence.join(", ")}`
    );
  }
}

function checkPromotedSurfacesAreConcrete(plan: GapPlan): void {
  const ambiguous = plan.surfaces
    .filter((surface) => surface.disposition === "promote")
    .filter(
      (surface) =>
        surface.authorityPacket === "N/A" ||
        surface.conformancePlan === "N/A" ||
        surface.fixture === "N/A" ||
        surface.adapterOperation === "N/A" ||
        surface.capabilityRequirement === "N/A" ||
        surface.checkIds.length === 0 ||
        surface.requiredEvidence.length === 0
    )
    .map((surface) => surface.surface);

  if (ambiguous.length > 0) {
    throw new Error(
      `Epic AF promoted surfaces must map to concrete packet, plan, fixture, operation, capability, checks, and evidence: ${ambiguous.join(", ")}`
    );
  }
}

async function readImplementedCheckEvidence(): Promise<
  Map<string, Set<string>>
> {
  const checks = new Map<string, Set<string>>();

  for (const planPath of await findConformancePlanPaths(BOUNDARIES_ROOT)) {
    const plan = JSON.parse(await readFile(planPath, "utf8")) as unknown;

    if (!(isRecord(plan) && Array.isArray(plan.checks))) {
      continue;
    }

    for (const check of plan.checks) {
      if (isRecord(check) && typeof check.checkId === "string") {
        checks.set(check.checkId, readEvidencePaths(check));
      }
    }
  }

  return checks;
}

function readEvidencePaths(check: Record<string, unknown>): Set<string> {
  const evidence = check.evidence;

  if (!Array.isArray(evidence)) {
    return new Set();
  }

  return new Set(
    evidence.filter((entry): entry is string => typeof entry === "string")
  );
}

async function findConformancePlanPaths(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths: string[] = [];

  for (const entry of entries) {
    const entryPath = join(directory, entry.name);

    if (entry.isDirectory()) {
      paths.push(...(await findConformancePlanPaths(entryPath)));
      continue;
    }

    if (
      entry.isFile() &&
      entry.name.endsWith(".json") &&
      entryPath.includes("/conformance/plans/")
    ) {
      paths.push(entryPath);
    }
  }

  return paths.sort();
}

function createPlannedSurfaces(
  entries: readonly CoverageEntry[]
): PlannedSurface[] {
  const selected = entries.filter((entry) => {
    const plan = SURFACE_PLANS[entry.surface];
    return (
      plan !== undefined &&
      (plan.disposition === "exclude" ||
        PROMOTED_CLASSIFICATIONS.has(entry.classification) ||
        entry.followUpTicket.startsWith(EPIC_AF_FOLLOW_UP_PREFIX))
    );
  });
  const grouped = new Map<string, CoverageEntry[]>();

  for (const entry of selected) {
    const plan = SURFACE_PLANS[entry.surface];
    if (plan === undefined) {
      throw new Error(
        `Epic AF gap plan lacks surface mapping: ${entry.surface}`
      );
    }

    const group = grouped.get(entry.surface) ?? [];
    group.push(entry);
    grouped.set(entry.surface, group);
  }

  return [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([surface, surfaceEntries]) => {
      const first = surfaceEntries[0];
      if (first === undefined) {
        throw new Error(`Epic AF gap plan found empty surface ${surface}`);
      }

      const surfacePlan = SURFACE_PLANS[surface];

      return {
        ...surfacePlan,
        adapterCapability: first.adapterCapability,
        authorityPacket: surfacePlan.authorityPacket ?? first.authorityPacket,
        claimIds: uniqueSorted(surfaceEntries.map((entry) => entry.claimId)),
        classifications: uniqueSorted(
          surfaceEntries.map((entry) => entry.classification)
        ),
        compatibilityEvidence: first.compatibilityEvidence,
        conformancePlan: surfacePlan.conformancePlan ?? first.conformancePlan,
        fixture: surfacePlan.fixture ?? first.fixture,
        generatedArtifact: first.generatedArtifact,
        matrixFollowUpTickets: uniqueSorted(
          surfaceEntries.map((entry) => entry.followUpTicket)
        ),
        surface,
      };
    });
}

function renderMarkdown(plan: GapPlan): string {
  const lines = [
    "# Epic AF Conformance Gap Plan",
    "",
    "This plan is generated from the Epic AD docs-to-authority coverage matrix. It is planning evidence, not a semantic oracle: authority packets, boundary-owned conformance plans, fixtures, adapter observations, and checked-in compatibility evidence remain the machine-readable sources used by runners.",
    "",
    `- Generated by: \`${plan.generatedBy}\``,
    `- Matrix source: \`${plan.matrixPath}\``,
    `- Promoted claim rows selected for AF checks: ${plan.promoteNowClaims}`,
    "",
    "## Surface Decisions",
    "",
  ];

  for (const surface of plan.surfaces) {
    lines.push(`### ${surface.surface}`);
    lines.push("");
    lines.push(`- Disposition: \`${surface.disposition}\``);
    lines.push(`- Delivery ticket: \`${surface.deliveryTicket}\``);
    lines.push(
      `- Matrix follow-up tickets: ${inlineList(surface.matrixFollowUpTickets)}`
    );
    lines.push(`- Claim IDs: ${inlineList(surface.claimIds)}`);
    lines.push(`- Authority packet: \`${surface.authorityPacket}\``);
    lines.push(`- Conformance plan: \`${surface.conformancePlan}\``);
    lines.push(`- Fixture or scenario: \`${surface.fixture}\``);
    lines.push(`- Adapter operation: \`${surface.adapterOperation}\``);
    lines.push(
      `- Capability requirement: \`${surface.capabilityRequirement}\``
    );
    lines.push(`- Required evidence: ${inlineList(surface.requiredEvidence)}`);
    lines.push(`- Planned check IDs: ${inlineList(surface.checkIds)}`);
    lines.push(`- Evidence update: ${surface.evidenceUpdate}`);
    lines.push(`- Rationale: ${surface.rationale}`);
    lines.push("");
  }

  lines.push("## Guardrails");
  lines.push("");
  lines.push(
    "- Runner and adapter code must not receive expected event sequences, expected phase traces, or pass/fail decisions from this plan."
  );
  lines.push(
    "- Every promoted check must declare required evidence in its conformance plan and must be backed by adapter observations only."
  );
  lines.push(
    "- Unsupported implementations remain non-applicable through capability selection; no AF check may target an implementation ID or language directly."
  );
  lines.push(
    "- Excluded implementation-local surfaces stay out of shared conformance until a later TechSpec/Tasks revision promotes them explicitly."
  );

  while (lines.at(-1) === "") {
    lines.pop();
  }

  return `${lines.join("\n")}\n`;
}

function inlineList(values: readonly string[]): string {
  if (values.length === 0) {
    return "`N/A`";
  }

  return values.map((value) => `\`${value}\``).join(", ");
}

function renderJson(value: unknown): string {
  return renderJsonValue(value, 0, 0);
}

function renderJsonValue(
  value: unknown,
  depth: number,
  inlinePrefixLength: number
): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return renderJsonArray(value, depth, inlinePrefixLength);
  }

  if (!isRecord(value)) {
    throw new Error(`cannot render unsupported JSON value ${String(value)}`);
  }

  return renderJsonObject(value, depth);
}

function renderJsonArray(
  values: readonly unknown[],
  depth: number,
  inlinePrefixLength: number
): string {
  if (values.length === 0) {
    return "[]";
  }

  const inline = `[${values
    .map((value) => renderJsonValue(value, depth, inlinePrefixLength))
    .join(", ")}]`;
  if (
    values.every(isJsonPrimitive) &&
    inlinePrefixLength + inline.length <= 90
  ) {
    return inline;
  }

  const childIndent = "  ".repeat(depth + 1);
  const currentIndent = "  ".repeat(depth);
  const lines = values.map(
    (value) => `${childIndent}${renderJsonValue(value, depth + 1, 0)}`
  );

  return `[\n${lines.join(",\n")}\n${currentIndent}]`;
}

function renderJsonObject(
  value: Record<string, unknown>,
  depth: number
): string {
  const entries = Object.entries(value);

  if (entries.length === 0) {
    return "{}";
  }

  const childIndent = "  ".repeat(depth + 1);
  const currentIndent = "  ".repeat(depth);
  const lines = entries.map(([key, entry]) => {
    const prefix = `${childIndent}${JSON.stringify(key)}: `;
    const renderedEntry = renderJsonValue(entry, depth + 1, prefix.length);
    return `${prefix}${renderedEntry}`;
  });

  return `{\n${lines.join(",\n")}\n${currentIndent}}`;
}

function isJsonPrimitive(value: unknown): boolean {
  return (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  );
}

async function writeGeneratedFile(
  path: string,
  content: string
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

function uniqueSorted<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort();
}

function readCoverageMatrix(value: unknown): CoverageMatrix {
  if (!(isRecord(value) && Array.isArray(value.entries))) {
    throw new Error(`${MATRIX_PATH} must contain an entries array`);
  }

  return {
    entries: value.entries.map(readCoverageEntry),
  };
}

function readCoverageEntry(value: unknown): CoverageEntry {
  const record = readRecord(value, "coverage entry");
  return {
    adapterCapability: readString(record, "adapterCapability"),
    authorityPacket: readString(record, "authorityPacket"),
    claimId: readString(record, "claimId"),
    classification: readClassification(record.classification),
    compatibilityEvidence: readString(record, "compatibilityEvidence"),
    conformancePlan: readString(record, "conformancePlan"),
    fixture: readString(record, "fixture"),
    followUpTicket: readString(record, "followUpTicket"),
    generatedArtifact: readString(record, "generatedArtifact"),
    sourceFile: readString(record, "sourceFile"),
    surface: readString(record, "surface"),
  };
}

function readClassification(value: unknown): MatrixClassification {
  if (
    value === "authority-backed-conformance-covered" ||
    value === "explicitly-deferred" ||
    value === "implementation-defined" ||
    value === "implementation-local-evidence" ||
    value === "missing-conformance-follow-up"
  ) {
    return value;
  }

  throw new Error(`unsupported matrix classification ${String(value)}`);
}

function readRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object`);
  }

  return value;
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];

  if (typeof value !== "string") {
    throw new Error(`coverage entry ${key} must be a string`);
  }

  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

try {
  await main();
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
