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
 *
 * Epic AL portability gate.
 *
 * Enforces the Epic AL portable-surface inventory's closed state:
 *  - Every surface classified `portable` in the inventory owns a registered
 *    authority packet with at least one executable verification path.
 *  - Standing implementation-specific exceptions (AG-UI, AI-SDK bridge) do
 *    not silently acquire a packet without an explicit Tasks.md/TechSpec
 *    revision.
 *  - The active set of authority packets matches the inventory exactly —
 *    new packets must arrive through an inventory revision so portability
 *    scope cannot drift below or above the documented surface.
 *  - Cross-implementation authority sources required by the inventory (the
 *    kernel CDDL grammar, the SSE TypeSpec, the tool-contracts TypeSpec, the
 *    telemetry semconv YAML) exist on disk and are referenced by their
 *    owning packet.
 *
 * The gate reads its expected topology, standing exceptions, and required
 * authoritative sources from the machine-readable inventory companion at
 * `.constitution/reports/epic-al-portability-inventory.json`. That JSON
 * is the canonical machine projection of the human inventory MD, so the gate
 * fails when either the JSON or the on-disk packet topology drifts from the
 * other. Hardcoded constants are deliberately not maintained in this file:
 * changing the inventory must be a one-step edit to the JSON sidecar (and
 * the human MD it accompanies), not a separate edit to the gate script.
 *
 * This script replaces `docs:af-gap-plan:check` as the canonical portability
 * proxy in `verify.ts` and `package.json`. The AF gap plan and the AL gap
 * inventory remain checked-in evidence; this gate enforces that the live
 * packet topology has not drifted from the inventory's closed state.
 */

import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface AuthorityPacketManifest {
  authoritativeSources: Array<{ format: string; path: string }>;
  bindingProjections?: Record<string, string>;
  boundary: string;
  conformancePlans?: Array<{ path: string; planId: string }>;
  packetId: string;
  surface: string;
  verificationPaths: Array<{ kind: string; target: string }>;
  version: string;
}

interface AdapterManifest {
  adapterId: string;
  authorityPackets: string[];
  boundary: string;
  capabilities?: readonly string[];
}

interface PortabilityGateFailure {
  message: string;
  rule: string;
}

interface InventoryExpectedPacket {
  classification: "portable" | "interop" | "telemetry";
  inventorySection?: string;
  packetId: string;
  packetPath: string;
}

interface InventoryStandingException {
  forbiddenSurfaceNames: readonly string[];
  inventorySection?: string;
  label: string;
}

interface InventoryRequiredSource {
  inventorySection?: string;
  packetId: string;
  rationale: string;
  sourceFormat: string;
  sourcePath: string;
}

interface PortabilityInventoryManifest {
  expectedPackets: readonly InventoryExpectedPacket[];
  manifestId: string;
  manifestVersion: string;
  requiredAuthoritativeSources: readonly InventoryRequiredSource[];
  standingExceptions: readonly InventoryStandingException[];
}

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const BOUNDARIES_ROOT = resolve(REPO_ROOT, "boundaries");
const INVENTORY_PATH = resolve(
  REPO_ROOT,
  ".constitution/reports/epic-al-portable-surface-conformance-gap-inventory.md"
);
const INVENTORY_MANIFEST_PATH = resolve(
  REPO_ROOT,
  ".constitution/reports/epic-al-portability-inventory.json"
);
const INVENTORY_MANIFEST_ID = "epic-al.portability-inventory";
const ALLOWED_CLASSIFICATIONS: ReadonlySet<string> = new Set([
  "portable",
  "interop",
  "telemetry",
]);
const MANIFEST_FILE_NAME = "authority-packet.json";
// Adapter manifests in this repo follow two naming patterns: a default
// `adapter.json` and per-variant `adapter-<variant>.json` (e.g.
// `adapter-sqlite.json`, `adapter-postgres.json`). Discovery must match both
// so the adapter-coverage rule sees every measured lane — earlier waves only
// matched the default name and silently skipped the variant adapters, which
// is the exact "non-default adapter loses a packet without tripping the gate"
// regression wave 5 flagged.
const ADAPTER_MANIFEST_NAME_PATTERN = /^adapter(?:-[A-Za-z0-9._-]+)?\.json$/u;

const EXECUTABLE_VERIFICATION_KINDS: ReadonlySet<string> = new Set([
  "schema-validation",
  "openapi-validation",
  "conformance-plan",
  "interop-smoke",
  "vocabulary-check",
]);

await main();

async function main(): Promise<void> {
  const inventoryLoad = await loadInventoryManifest();

  if (inventoryLoad.failures.length > 0) {
    console.error("portability gate failed:");
    for (const failure of inventoryLoad.failures) {
      console.error(`  [${failure.rule}] ${failure.message}`);
    }
    process.exitCode = 1;
    return;
  }

  const inventory = inventoryLoad.manifest;

  if (inventory === undefined) {
    console.error(
      "portability gate failed: inventory manifest could not be loaded"
    );
    process.exitCode = 1;
    return;
  }

  const failures = await runPortabilityGate(inventory);

  if (failures.length > 0) {
    console.error("portability gate failed:");
    for (const failure of failures) {
      console.error(`  [${failure.rule}] ${failure.message}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(
    `portability gate passed (${inventory.expectedPackets.length} packets, ${inventory.standingExceptions.length} standing exceptions, ${inventory.requiredAuthoritativeSources.length} required sources)`
  );
}

async function runPortabilityGate(
  inventory: PortabilityInventoryManifest
): Promise<PortabilityGateFailure[]> {
  const failures: PortabilityGateFailure[] = [];
  const onDiskManifests = await loadAllManifests();
  const adapterManifests = await loadAllAdapterManifests();
  const expectedPacketIds = new Set(
    inventory.expectedPackets.map((entry) => entry.packetId)
  );
  const expectedPaths = new Set(
    inventory.expectedPackets.map((entry) => entry.packetPath)
  );

  failures.push(...checkInventoryExists());
  failures.push(...(await checkInventoryMdJsonConsistency(inventory)));
  failures.push(...checkExpectedTopologyIsUnique(inventory));
  failures.push(
    ...checkExpectedPacketsPresent(
      inventory,
      expectedPacketIds,
      onDiskManifests
    )
  );
  failures.push(
    ...checkNoUnexpectedPackets(
      expectedPaths,
      expectedPacketIds,
      onDiskManifests
    )
  );
  failures.push(...checkPacketIdUniqueness(onDiskManifests));
  failures.push(...checkExecutableVerification(onDiskManifests));
  failures.push(...checkStandingExceptions(inventory, onDiskManifests));
  failures.push(...checkRequiredSources(inventory, onDiskManifests));
  failures.push(...checkAdapterCoverage(onDiskManifests, adapterManifests));
  failures.push(
    ...(await checkPlanApplicabilityHasAdapter(
      onDiskManifests,
      adapterManifests
    ))
  );
  failures.push(
    ...(await checkAdapterCapabilityCoveredByPlan(adapterManifests))
  );

  return failures;
}

interface InventoryLoadResult {
  failures: PortabilityGateFailure[];
  manifest: PortabilityInventoryManifest | undefined;
}

async function loadInventoryManifest(): Promise<InventoryLoadResult> {
  if (!existsSync(INVENTORY_MANIFEST_PATH)) {
    return {
      failures: [
        {
          rule: "inventory-manifest",
          message: `machine-readable inventory companion missing at ${relative(REPO_ROOT, INVENTORY_MANIFEST_PATH)}; this JSON is the gate's source of truth and must accompany the human inventory MD`,
        },
      ],
      manifest: undefined,
    };
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(await readFile(INVENTORY_MANIFEST_PATH, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      failures: [
        {
          rule: "inventory-manifest",
          message: `inventory manifest at ${relative(REPO_ROOT, INVENTORY_MANIFEST_PATH)} is not parseable JSON: ${detail}`,
        },
      ],
      manifest: undefined,
    };
  }

  const validation = validateInventoryManifestShape(parsed);

  if (validation.failures.length > 0) {
    return { failures: validation.failures, manifest: undefined };
  }

  return { failures: [], manifest: validation.manifest };
}

interface InventoryShapeValidation {
  failures: PortabilityGateFailure[];
  manifest: PortabilityInventoryManifest | undefined;
}

function validateInventoryManifestShape(
  raw: unknown
): InventoryShapeValidation {
  const failures: PortabilityGateFailure[] = [];

  if (!isRecord(raw)) {
    return {
      failures: [
        {
          rule: "inventory-manifest",
          message:
            "inventory manifest must be a JSON object with manifestId, manifestVersion, expectedPackets, standingExceptions, and requiredAuthoritativeSources",
        },
      ],
      manifest: undefined,
    };
  }

  if (raw.manifestId !== INVENTORY_MANIFEST_ID) {
    failures.push({
      rule: "inventory-manifest",
      message: `inventory manifest manifestId must equal "${INVENTORY_MANIFEST_ID}"; got ${JSON.stringify(raw.manifestId)}`,
    });
  }

  if (typeof raw.manifestVersion !== "string") {
    failures.push({
      rule: "inventory-manifest",
      message: "inventory manifest manifestVersion must be a string",
    });
  }

  const expectedPackets = validateExpectedPackets(raw.expectedPackets);
  failures.push(...expectedPackets.failures);

  const standingExceptions = validateStandingExceptions(raw.standingExceptions);
  failures.push(...standingExceptions.failures);

  const requiredSources = validateRequiredSources(
    raw.requiredAuthoritativeSources
  );
  failures.push(...requiredSources.failures);

  if (failures.length > 0) {
    return { failures, manifest: undefined };
  }

  return {
    failures,
    manifest: {
      expectedPackets: expectedPackets.entries,
      manifestId: raw.manifestId as string,
      manifestVersion: raw.manifestVersion as string,
      requiredAuthoritativeSources: requiredSources.entries,
      standingExceptions: standingExceptions.entries,
    },
  };
}

function validateExpectedPackets(value: unknown): {
  entries: InventoryExpectedPacket[];
  failures: PortabilityGateFailure[];
} {
  const failures: PortabilityGateFailure[] = [];
  const entries: InventoryExpectedPacket[] = [];

  if (!Array.isArray(value)) {
    failures.push({
      rule: "inventory-manifest",
      message: "inventory manifest expectedPackets must be an array",
    });
    return { entries, failures };
  }

  for (const [index, entry] of value.entries()) {
    if (!isRecord(entry)) {
      failures.push({
        rule: "inventory-manifest",
        message: `expectedPackets[${index}] must be an object`,
      });
      continue;
    }

    if (typeof entry.packetId !== "string") {
      failures.push({
        rule: "inventory-manifest",
        message: `expectedPackets[${index}].packetId must be a string`,
      });
      continue;
    }

    if (typeof entry.packetPath !== "string") {
      failures.push({
        rule: "inventory-manifest",
        message: `expectedPackets[${index}].packetPath must be a string`,
      });
      continue;
    }

    if (
      typeof entry.classification !== "string" ||
      !ALLOWED_CLASSIFICATIONS.has(entry.classification)
    ) {
      failures.push({
        rule: "inventory-manifest",
        message: `expectedPackets[${index}].classification must be one of ${[...ALLOWED_CLASSIFICATIONS].join(", ")}`,
      });
      continue;
    }

    entries.push({
      classification: entry.classification as
        | "portable"
        | "interop"
        | "telemetry",
      inventorySection:
        typeof entry.inventorySection === "string"
          ? entry.inventorySection
          : undefined,
      packetId: entry.packetId,
      packetPath: entry.packetPath,
    });
  }

  return { entries, failures };
}

function validateStandingExceptions(value: unknown): {
  entries: InventoryStandingException[];
  failures: PortabilityGateFailure[];
} {
  const failures: PortabilityGateFailure[] = [];
  const entries: InventoryStandingException[] = [];

  if (!Array.isArray(value)) {
    failures.push({
      rule: "inventory-manifest",
      message: "inventory manifest standingExceptions must be an array",
    });
    return { entries, failures };
  }

  for (const [index, entry] of value.entries()) {
    if (!isRecord(entry)) {
      failures.push({
        rule: "inventory-manifest",
        message: `standingExceptions[${index}] must be an object`,
      });
      continue;
    }

    if (typeof entry.label !== "string") {
      failures.push({
        rule: "inventory-manifest",
        message: `standingExceptions[${index}].label must be a string`,
      });
      continue;
    }

    if (
      !(
        Array.isArray(entry.forbiddenSurfaceNames) &&
        entry.forbiddenSurfaceNames.every((name) => typeof name === "string")
      )
    ) {
      failures.push({
        rule: "inventory-manifest",
        message: `standingExceptions[${index}].forbiddenSurfaceNames must be a non-empty array of strings`,
      });
      continue;
    }

    entries.push({
      forbiddenSurfaceNames: entry.forbiddenSurfaceNames as string[],
      inventorySection:
        typeof entry.inventorySection === "string"
          ? entry.inventorySection
          : undefined,
      label: entry.label,
    });
  }

  return { entries, failures };
}

function validateRequiredSources(value: unknown): {
  entries: InventoryRequiredSource[];
  failures: PortabilityGateFailure[];
} {
  const failures: PortabilityGateFailure[] = [];
  const entries: InventoryRequiredSource[] = [];

  if (!Array.isArray(value)) {
    failures.push({
      rule: "inventory-manifest",
      message:
        "inventory manifest requiredAuthoritativeSources must be an array",
    });
    return { entries, failures };
  }

  for (const [index, entry] of value.entries()) {
    if (!isRecord(entry)) {
      failures.push({
        rule: "inventory-manifest",
        message: `requiredAuthoritativeSources[${index}] must be an object`,
      });
      continue;
    }

    if (
      typeof entry.packetId !== "string" ||
      typeof entry.sourcePath !== "string" ||
      typeof entry.rationale !== "string" ||
      typeof entry.sourceFormat !== "string"
    ) {
      failures.push({
        rule: "inventory-manifest",
        message: `requiredAuthoritativeSources[${index}] must declare string packetId, sourcePath, rationale, and sourceFormat`,
      });
      continue;
    }

    entries.push({
      inventorySection:
        typeof entry.inventorySection === "string"
          ? entry.inventorySection
          : undefined,
      packetId: entry.packetId,
      rationale: entry.rationale,
      sourceFormat: entry.sourceFormat,
      sourcePath: entry.sourcePath,
    });
  }

  return { entries, failures };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function checkAdapterCoverage(
  onDisk: ReadonlyMap<string, AuthorityPacketManifest>,
  adapterManifests: ReadonlyMap<string, AdapterManifest>
): PortabilityGateFailure[] {
  // A packet that declares `conformancePlans` must be referenced by *every*
  // adapter manifest of the matching boundary, not just one. The shared
  // runner discovers plans per adapter manifest (`tools/conformance/runner/
  // run.ts:606-620`), so a packet that one adapter references but another
  // omits silently disappears from the omitting adapter's measured evidence
  // even though the portability gate would still pass. For a cross-
  // implementation portability gate, "at least one adapter somewhere in the
  // boundary" is too weak — every measured implementation lane has to see
  // the plan.
  const failures: PortabilityGateFailure[] = [];
  const adaptersByBoundary = new Map<string, AdapterManifest[]>();

  for (const adapter of adapterManifests.values()) {
    const existing = adaptersByBoundary.get(adapter.boundary);

    if (existing === undefined) {
      adaptersByBoundary.set(adapter.boundary, [adapter]);
    } else {
      existing.push(adapter);
    }
  }

  for (const [packetPath, manifest] of onDisk.entries()) {
    const planCount = manifest.conformancePlans?.length ?? 0;

    if (planCount === 0) {
      continue;
    }

    const adapters = adaptersByBoundary.get(manifest.boundary) ?? [];

    if (adapters.length === 0) {
      failures.push({
        rule: "adapter-coverage",
        message: `packet ${manifest.packetId} declares ${planCount} conformance plan(s) but no adapter manifest exists for boundary ${manifest.boundary}; the shared runner cannot discover this packet's plans`,
      });
      continue;
    }

    const missingAdapters = adapters.filter(
      (adapter) => !adapter.authorityPackets.includes(packetPath)
    );

    if (missingAdapters.length > 0) {
      const missingAdapterIds = missingAdapters
        .map((adapter) => adapter.adapterId)
        .sort()
        .join(", ");

      failures.push({
        rule: "adapter-coverage",
        message: `packet ${manifest.packetId} at ${packetPath} declares ${planCount} conformance plan(s) but is not referenced by every ${manifest.boundary}-boundary adapter manifest; add ${packetPath} to: ${missingAdapterIds}`,
      });
    }
  }

  return failures;
}

function checkExpectedTopologyIsUnique(
  inventory: PortabilityInventoryManifest
): PortabilityGateFailure[] {
  // The inventory manifest is the gate's source of truth, so a typo or
  // copy-paste mistake that duplicates a packetId or packetPath would silently
  // narrow what we enforce. Catch that here rather than letting it propagate.
  const failures: PortabilityGateFailure[] = [];
  const seenPacketIds = new Set<string>();
  const seenPaths = new Set<string>();

  for (const entry of inventory.expectedPackets) {
    if (seenPacketIds.has(entry.packetId)) {
      failures.push({
        rule: "expected-topology-unique",
        message: `inventory manifest lists packetId ${entry.packetId} more than once`,
      });
    } else {
      seenPacketIds.add(entry.packetId);
    }

    if (seenPaths.has(entry.packetPath)) {
      failures.push({
        rule: "expected-topology-unique",
        message: `inventory manifest lists packetPath ${entry.packetPath} more than once`,
      });
    } else {
      seenPaths.add(entry.packetPath);
    }
  }

  return failures;
}

async function loadAllManifests(): Promise<
  Map<string, AuthorityPacketManifest>
> {
  const manifests = new Map<string, AuthorityPacketManifest>();
  const paths = await findFilesByName(BOUNDARIES_ROOT, MANIFEST_FILE_NAME);

  for (const manifestPath of paths) {
    const manifest = JSON.parse(
      await readFile(manifestPath, "utf8")
    ) as AuthorityPacketManifest;
    manifests.set(relative(REPO_ROOT, manifestPath), manifest);
  }

  return manifests;
}

async function loadAllAdapterManifests(): Promise<
  Map<string, AdapterManifest>
> {
  const manifests = new Map<string, AdapterManifest>();
  const paths = await findFiles(BOUNDARIES_ROOT, (name) =>
    ADAPTER_MANIFEST_NAME_PATTERN.test(name)
  );

  for (const manifestPath of paths) {
    const manifest = JSON.parse(
      await readFile(manifestPath, "utf8")
    ) as AdapterManifest;
    manifests.set(relative(REPO_ROOT, manifestPath), manifest);
  }

  return manifests;
}

async function findFilesByName(
  directory: string,
  fileName: string
): Promise<string[]> {
  return await findFiles(directory, (name) => name === fileName);
}

async function findFiles(
  directory: string,
  matches: (fileName: string) => boolean
): Promise<string[]> {
  if (!existsSync(directory)) {
    return [];
  }

  const entries = await readdir(directory, { withFileTypes: true });
  const paths: string[] = [];

  for (const entry of entries) {
    const entryPath = resolve(directory, entry.name);

    if (entry.isDirectory()) {
      paths.push(...(await findFiles(entryPath, matches)));
      continue;
    }

    if (entry.isFile() && matches(entry.name)) {
      paths.push(entryPath);
    }
  }

  return paths.sort();
}

function checkInventoryExists(): PortabilityGateFailure[] {
  if (existsSync(INVENTORY_PATH)) {
    return [];
  }

  return [
    {
      rule: "inventory-presence",
      message: `Epic AL inventory missing at ${relative(REPO_ROOT, INVENTORY_PATH)}; portability gate requires the inventory as the human-readable closure record.`,
    },
  ];
}

async function checkInventoryMdJsonConsistency(
  inventory: PortabilityInventoryManifest
): Promise<PortabilityGateFailure[]> {
  // The previous version of this gate only checked that the human MD inventory
  // existed on disk. That made the JSON sidecar the gate's source of truth but
  // left the MD free to silently drift — a reviewer could rename a packet or
  // add a new standing exception in JSON without touching the MD (or vice
  // versa) and the gate would still pass.
  //
  // Two anchor classes catch the narrative drift cases without over-fitting
  // to prose phrasing:
  //   - Every packetId in JSON must appear verbatim in the MD. PacketIds are
  //     dot-namespaced identifiers (`tuvren.foo.bar`); they are stable, short,
  //     and unambiguous, so a literal substring match is appropriate.
  //   - Every standing exception in JSON must have at least one of its
  //     `forbiddenSurfaceNames` mentioned verbatim in the MD. Those names
  //     are the actual package/surface identifiers the exception protects
  //     against, so they're the right anchor — strict enough to catch the
  //     "added a new exception in JSON, forgot to document it" case, loose
  //     enough to let the MD pick whichever forbidden name reads most
  //     naturally.
  //
  // Source-path drift is intentionally NOT checked here. The MD does not
  // reliably name every required source by literal path (some paths are
  // paraphrased in prose for readability). On-disk source path presence and
  // packet-registration are already enforced by `checkRequiredSources`, which
  // is the structural guard for that class of drift. Packet-path drift is
  // similarly caught by `checkExpectedPacketsPresent`.
  if (!existsSync(INVENTORY_PATH)) {
    return [];
  }

  const mdContent = await readFile(INVENTORY_PATH, "utf8");
  const failures: PortabilityGateFailure[] = [];
  const inventoryRel = relative(REPO_ROOT, INVENTORY_PATH);

  for (const entry of inventory.expectedPackets) {
    if (!mdContent.includes(entry.packetId)) {
      failures.push({
        rule: "inventory-md-json-consistency",
        message: `inventory JSON lists packetId ${entry.packetId} but ${inventoryRel} does not mention it; paired-edit drift — revise the MD and JSON together`,
      });
    }
  }

  for (const exception of inventory.standingExceptions) {
    const anyMentioned = exception.forbiddenSurfaceNames.some((name) =>
      mdContent.includes(name)
    );

    if (!anyMentioned) {
      failures.push({
        rule: "inventory-md-json-consistency",
        message: `inventory JSON declares standing exception "${exception.label}" with forbidden surfaces [${exception.forbiddenSurfaceNames.join(", ")}] but ${inventoryRel} does not mention any of them; paired-edit drift — document the exception in the MD or remove it from the JSON`,
      });
    }
  }

  return failures;
}

async function checkPlanApplicabilityHasAdapter(
  onDisk: ReadonlyMap<string, AuthorityPacketManifest>,
  adapterManifests: ReadonlyMap<string, AdapterManifest>
): Promise<PortabilityGateFailure[]> {
  // A conformance plan that names capabilities under `applicability.capabilities`
  // is only reachable as applicable evidence when at least one adapter in the
  // packet's boundary advertises every one of those capabilities. If no
  // adapter does, the plan's checks run as `nonApplicable` on every measured
  // lane and the portability claim collapses to "the plan exists" rather
  // than "the surface is measured." Wave 5 flagged exactly this for the SSE
  // plan: the packet had been promoted to portable but no framework adapter
  // declared `framework.event-stream-sse`, so every SSE check in compatibility
  // evidence was nonApplicable. Catch the structural gap here.
  const failures: PortabilityGateFailure[] = [];
  const adaptersByBoundary = new Map<string, AdapterManifest[]>();

  for (const adapter of adapterManifests.values()) {
    const existing = adaptersByBoundary.get(adapter.boundary);

    if (existing === undefined) {
      adaptersByBoundary.set(adapter.boundary, [adapter]);
    } else {
      existing.push(adapter);
    }
  }

  for (const [packetPath, manifest] of onDisk.entries()) {
    const plans = manifest.conformancePlans ?? [];

    if (plans.length === 0) {
      continue;
    }

    const adapters = adaptersByBoundary.get(manifest.boundary) ?? [];

    for (const plan of plans) {
      const planCapabilities = await readPlanApplicabilityCapabilities(
        plan.path
      );

      if (planCapabilities.length === 0) {
        continue;
      }

      const advertisingAdapter = adapters.find(
        (adapter) =>
          adapter.authorityPackets.includes(packetPath) &&
          planCapabilities.every((capability) =>
            isAdapterCapability(adapter, capability)
          )
      );

      if (advertisingAdapter === undefined) {
        failures.push({
          rule: "plan-applicability-has-adapter",
          message: `plan ${plan.planId} at ${plan.path} requires applicability capabilities ${planCapabilities.sort().join(", ")} but no ${manifest.boundary}-boundary adapter advertises that full set; the portability promotion of ${manifest.packetId} would record zero applicable evidence`,
        });
      }
    }
  }

  return failures;
}

async function readPlanApplicabilityCapabilities(
  planPath: string
): Promise<readonly string[]> {
  // Returns the union of plan-level applicability capabilities and every
  // check-level `capabilities` array. The shared runner decides applicability
  // from that exact union (`tools/conformance/runner/run.ts:663-665`), so an
  // earlier gate version that only read `plan.applicability.capabilities`
  // would miss check-scoped capability gaps — a check tagged with a
  // capability no adapter advertises would run as `nonApplicable` forever
  // and the portability claim would silently regress without the gate
  // flagging it.
  const absolutePath = resolve(REPO_ROOT, planPath);

  if (!existsSync(absolutePath)) {
    return [];
  }

  const plan = JSON.parse(await readFile(absolutePath, "utf8")) as {
    applicability?: { capabilities?: unknown };
    checks?: Array<{ capabilities?: unknown }>;
  };
  const collected = new Set<string>();

  for (const capability of toStringArray(plan.applicability?.capabilities)) {
    collected.add(capability);
  }

  for (const check of plan.checks ?? []) {
    for (const capability of toStringArray(check.capabilities)) {
      collected.add(capability);
    }
  }

  return [...collected];
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((entry): entry is string => typeof entry === "string");
}

async function checkAdapterCapabilityCoveredByPlan(
  adapterManifests: ReadonlyMap<string, AdapterManifest>
): Promise<PortabilityGateFailure[]> {
  // Every adapter-advertised capability must appear in at least one plan
  // check (either plan-level applicability or check-level capabilities)
  // anywhere in the workspace. Wave 5 briefly let
  // `compatibility-report.ts` count adapter-only capabilities as part of
  // "full coverage" so unmeasured surfaces (e.g. an aspirational
  // `trace.lifecycle` claim) would still flip the lane to `full_pass`.
  // That weakened the meaning of `full_pass`. Wave 6 reverts that and
  // catches the gap structurally here: a capability advertised by an
  // adapter but mentioned by zero plan checks forces an explicit decision —
  // remove the capability from the adapter manifest or add a plan that
  // exercises it. Cross-boundary roles (e.g. the framework adapter
  // advertising `providers.framework-owned-approval-boundary` so the
  // providers boundary's plans can dispatch on it) still pass because the
  // capability is mentioned by SOME plan even when it lives in a
  // different boundary.
  const failures: PortabilityGateFailure[] = [];
  const planCapabilities = await collectAllPlanCapabilities();

  for (const adapter of adapterManifests.values()) {
    const declared = adapter.capabilities ?? [];

    for (const capability of declared) {
      if (!planCapabilities.has(capability)) {
        failures.push({
          rule: "adapter-capability-covered-by-plan",
          message: `adapter ${adapter.adapterId} advertises capability ${capability} but no conformance plan in the workspace exercises it; remove it from the adapter manifest or add a plan check that asserts on the capability`,
        });
      }
    }
  }

  return failures;
}

async function collectAllPlanCapabilities(): Promise<Set<string>> {
  // Walk every authority packet's `conformancePlans` rather than relying on
  // a directory naming convention. That keeps the coverage inventory aligned
  // with what `tools/conformance/plan-compiler/index.ts` actually compiles —
  // a plan file outside a packet's reach wouldn't be measured by any lane,
  // so its capabilities don't count as coverage either.
  const capabilities = new Set<string>();
  const packets = await loadAllManifests();

  for (const manifest of packets.values()) {
    for (const plan of manifest.conformancePlans ?? []) {
      for (const capability of await readPlanApplicabilityCapabilities(
        plan.path
      )) {
        capabilities.add(capability);
      }
    }
  }

  return capabilities;
}

function isAdapterCapability(
  adapter: AdapterManifest,
  capability: string
): boolean {
  return adapter.capabilities?.includes(capability) ?? false;
}

function checkExpectedPacketsPresent(
  inventory: PortabilityInventoryManifest,
  expectedPacketIds: ReadonlySet<string>,
  onDisk: ReadonlyMap<string, AuthorityPacketManifest>
): PortabilityGateFailure[] {
  const failures: PortabilityGateFailure[] = [];
  const seenPacketIds = new Set(
    [...onDisk.values()].map((manifest) => manifest.packetId)
  );

  for (const expected of inventory.expectedPackets) {
    const manifest = onDisk.get(expected.packetPath);

    if (manifest === undefined) {
      failures.push({
        rule: "expected-packet-present",
        message: `expected packet ${expected.packetId} missing at ${expected.packetPath}`,
      });
      continue;
    }

    if (manifest.packetId !== expected.packetId) {
      failures.push({
        rule: "expected-packet-present",
        message: `packet at ${expected.packetPath} declares packetId ${manifest.packetId}; inventory expects ${expected.packetId}`,
      });
    }
  }

  for (const expected of expectedPacketIds) {
    if (!seenPacketIds.has(expected)) {
      failures.push({
        rule: "expected-packet-present",
        message: `inventory expects packetId ${expected} but no on-disk packet declares it`,
      });
    }
  }

  return failures;
}

function checkNoUnexpectedPackets(
  expectedPaths: ReadonlySet<string>,
  expectedPacketIds: ReadonlySet<string>,
  onDisk: ReadonlyMap<string, AuthorityPacketManifest>
): PortabilityGateFailure[] {
  const failures: PortabilityGateFailure[] = [];

  for (const [path, manifest] of onDisk.entries()) {
    // The path check is the primary guard: it catches an extra
    // authority-packet.json planted at any location that the inventory does
    // not name, even when that file reuses an already-expected packetId.
    // The packetId check then catches any new manifest that lands at an
    // expected-looking path but declares a fresh portable surface the
    // inventory has not promoted.
    if (!expectedPaths.has(path)) {
      failures.push({
        rule: "no-unexpected-packets",
        message: `authority-packet.json at ${path} is not listed in EXPECTED_PACKET_TOPOLOGY; revise the AL inventory and the expected-topology table together before adding new cross-implementation surfaces (declared packetId: ${manifest.packetId})`,
      });
      continue;
    }

    if (!expectedPacketIds.has(manifest.packetId)) {
      failures.push({
        rule: "no-unexpected-packets",
        message: `packet ${manifest.packetId} at ${path} is not listed in the AL inventory's expected topology; revise the inventory and EXPECTED_PACKET_TOPOLOGY together before adding new cross-implementation surfaces`,
      });
    }
  }

  return failures;
}

function checkPacketIdUniqueness(
  onDisk: ReadonlyMap<string, AuthorityPacketManifest>
): PortabilityGateFailure[] {
  // Two manifests at different paths must not share the same packetId, or
  // tooling that resolves a packet by id would silently pick whichever file
  // wins the directory walk. This guard catches that even when both paths
  // happen to be in `expectedPaths` (e.g., a copy-paste at one expected
  // location of another expected packet's id).
  const failures: PortabilityGateFailure[] = [];
  const pathsByPacketId = new Map<string, string[]>();

  for (const [path, manifest] of onDisk.entries()) {
    const existing = pathsByPacketId.get(manifest.packetId);

    if (existing === undefined) {
      pathsByPacketId.set(manifest.packetId, [path]);
    } else {
      existing.push(path);
    }
  }

  for (const [packetId, paths] of pathsByPacketId.entries()) {
    if (paths.length > 1) {
      failures.push({
        rule: "packet-id-uniqueness",
        message: `packetId ${packetId} is declared at multiple paths: ${paths.sort().join(", ")}`,
      });
    }
  }

  return failures;
}

function checkExecutableVerification(
  onDisk: ReadonlyMap<string, AuthorityPacketManifest>
): PortabilityGateFailure[] {
  const failures: PortabilityGateFailure[] = [];

  for (const [path, manifest] of onDisk.entries()) {
    const executable = manifest.verificationPaths.some((verificationPath) =>
      EXECUTABLE_VERIFICATION_KINDS.has(verificationPath.kind)
    );

    if (!executable) {
      failures.push({
        rule: "executable-verification",
        message: `packet ${manifest.packetId} at ${path} has no executable verification path; portable packets require schema-validation, openapi-validation, conformance-plan, interop-smoke, or vocabulary-check`,
      });
    }
  }

  return failures;
}

function checkStandingExceptions(
  inventory: PortabilityInventoryManifest,
  onDisk: ReadonlyMap<string, AuthorityPacketManifest>
): PortabilityGateFailure[] {
  const failures: PortabilityGateFailure[] = [];

  for (const exception of inventory.standingExceptions) {
    const forbidden = new Set(exception.forbiddenSurfaceNames);

    for (const [path, manifest] of onDisk.entries()) {
      if (forbidden.has(manifest.surface)) {
        failures.push({
          rule: "standing-exceptions-unchanged",
          message: `packet ${manifest.packetId} at ${path} owns surface "${manifest.surface}" which is the Epic AL standing exception ${exception.label}; standing exceptions may not be promoted to portable authority without an explicit Tasks.md/TechSpec revision`,
        });
      }
    }
  }

  return failures;
}

function checkRequiredSources(
  inventory: PortabilityInventoryManifest,
  onDisk: ReadonlyMap<string, AuthorityPacketManifest>
): PortabilityGateFailure[] {
  const failures: PortabilityGateFailure[] = [];
  const manifestsByPacketId = new Map<string, AuthorityPacketManifest>();

  for (const manifest of onDisk.values()) {
    manifestsByPacketId.set(manifest.packetId, manifest);
  }

  for (const required of inventory.requiredAuthoritativeSources) {
    if (!existsSync(resolve(REPO_ROOT, required.sourcePath))) {
      failures.push({
        rule: "required-sources",
        message: `${required.rationale}: required source ${required.sourcePath} is missing on disk`,
      });
      continue;
    }

    const manifest = manifestsByPacketId.get(required.packetId);

    if (manifest === undefined) {
      failures.push({
        rule: "required-sources",
        message: `${required.rationale}: packet ${required.packetId} is not present on disk; cannot verify source registration`,
      });
      continue;
    }

    const declaredSource = manifest.authoritativeSources.find(
      (source) => source.path === required.sourcePath
    );

    if (declaredSource === undefined) {
      failures.push({
        rule: "required-sources",
        message: `${required.rationale}: ${required.sourcePath} exists on disk but is not declared under ${required.packetId}.authoritativeSources`,
      });
      continue;
    }

    // Verifying the source-registration format catches the case where a
    // packet author registers a required source under the wrong format
    // (e.g. tagging the kernel CDDL grammar as `text` instead of `cddl`,
    // or the SSE TypeSpec as `typespec` after a refactor that should have
    // moved it to a new format). Tooling that walks
    // `authoritativeSources[*].format` would silently skip the
    // mis-registered source, so the portability claim could pass while
    // the named authority no longer routes through its declared
    // verification path.
    if (declaredSource.format !== required.sourceFormat) {
      failures.push({
        rule: "required-sources",
        message: `${required.rationale}: ${required.sourcePath} is registered under ${required.packetId}.authoritativeSources with format "${declaredSource.format}"; inventory requires format "${required.sourceFormat}"`,
      });
    }
  }

  return failures;
}
