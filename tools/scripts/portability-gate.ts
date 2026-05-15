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
}

interface PortabilityGateFailure {
  message: string;
  rule: string;
}

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const BOUNDARIES_ROOT = resolve(REPO_ROOT, "boundaries");
const INVENTORY_PATH = resolve(
  REPO_ROOT,
  "constitution/support/live/epic-al-portable-surface-conformance-gap-inventory.md"
);
const MANIFEST_FILE_NAME = "authority-packet.json";
const ADAPTER_MANIFEST_FILE_NAME = "adapter.json";

const EXECUTABLE_VERIFICATION_KINDS: ReadonlySet<string> = new Set([
  "schema-validation",
  "openapi-validation",
  "conformance-plan",
  "interop-smoke",
  "vocabulary-check",
]);

/**
 * Expected packet topology after Epic AL closure. Each entry binds a packetId
 * to its authority packet path. Adding or removing a packet here is the
 * machine-enforced signal that AL inventory scope changed — drift between
 * this table and disk is the gate's primary failure mode.
 */
const EXPECTED_PACKET_TOPOLOGY: ReadonlyArray<{
  packetId: string;
  packetPath: string;
  classification: "portable" | "interop" | "telemetry";
}> = [
  {
    packetId: "tuvren.shared.core-types",
    packetPath:
      "boundaries/shared/contracts/core-types/spec/authority-packet.json",
    classification: "portable",
  },
  {
    packetId: "tuvren.kernel.protocol",
    packetPath:
      "boundaries/kernel/contracts/protocol/spec/authority-packet.json",
    classification: "portable",
  },
  {
    packetId: "tuvren.framework.runtime-api",
    packetPath:
      "boundaries/framework/contracts/runtime-api/spec/authority-packet.json",
    classification: "portable",
  },
  {
    packetId: "tuvren.framework.event-stream",
    packetPath:
      "boundaries/framework/contracts/event-stream/spec/authority-packet.json",
    classification: "portable",
  },
  {
    packetId: "tuvren.framework.event-stream-sse",
    packetPath:
      "boundaries/framework/contracts/event-stream-sse/spec/authority-packet.json",
    classification: "portable",
  },
  {
    packetId: "tuvren.framework.driver-api",
    packetPath:
      "boundaries/framework/contracts/driver-api/spec/authority-packet.json",
    classification: "portable",
  },
  {
    packetId: "tuvren.framework.react-driver",
    packetPath:
      "boundaries/framework/contracts/react-driver/spec/authority-packet.json",
    classification: "portable",
  },
  {
    packetId: "tuvren.framework.tool-contracts",
    packetPath:
      "boundaries/framework/contracts/tool-contracts/spec/authority-packet.json",
    classification: "portable",
  },
  {
    packetId: "tuvren.providers.provider-api",
    packetPath:
      "boundaries/providers/contracts/provider-api/spec/authority-packet.json",
    classification: "portable",
  },
  {
    packetId: "tuvren.kernel.interop-grpc",
    packetPath: "boundaries/kernel/interop/grpc/spec/authority-packet.json",
    classification: "interop",
  },
  {
    packetId: "tuvren.framework.interop-rust-kernel",
    packetPath:
      "boundaries/framework/interop/rust-kernel/spec/authority-packet.json",
    classification: "interop",
  },
  {
    packetId: "tuvren.telemetry.semconv",
    packetPath: "boundaries/telemetry/semconv/spec/authority-packet.json",
    classification: "telemetry",
  },
];

/**
 * Standing implementation-specific exceptions per Tasks.md §1 and Epic AL
 * inventory §4. These surfaces MUST NOT acquire a STANDALONE authority packet
 * whose `surface` field names them, since that would promote them to portable
 * authority. The check looks at packet `surface` strings rather than binding
 * projection paths because exception implementations are allowed to appear as
 * downstream projections of their portable parent contracts (the AI SDK
 * bridge IS a binding projection of `tuvren.providers.provider-api`).
 */
const STANDING_EXCEPTION_SURFACES: readonly {
  label: string;
  forbiddenSurfaceNames: readonly string[];
}[] = [
  {
    label: "AG-UI projection (@tuvren/stream-agui)",
    forbiddenSurfaceNames: ["ag-ui", "stream-agui", "event-stream-agui"],
  },
  {
    label: "TypeScript AI SDK bridge (@tuvren/provider-bridge-ai-sdk)",
    forbiddenSurfaceNames: [
      "ai-sdk-bridge",
      "provider-bridge-ai-sdk",
      "provider-ai-sdk",
    ],
  },
];

/**
 * Sources whose existence the inventory's gap closure relies on. The gate
 * fails if any source is missing — for example, deleting the kernel CDDL
 * grammar without also revising the kernel-protocol packet must be a loud
 * portability gate failure rather than a silent freshness regression.
 */
const REQUIRED_AUTHORITATIVE_SOURCES: ReadonlyArray<{
  packetId: string;
  sourcePath: string;
  rationale: string;
}> = [
  {
    packetId: "tuvren.kernel.protocol",
    sourcePath:
      "boundaries/kernel/contracts/protocol/spec/cddl/kernel-records.cddl",
    rationale:
      "KRT-AL002 G2: kernel CDDL grammar must remain registered authority",
  },
  {
    packetId: "tuvren.framework.tool-contracts",
    sourcePath:
      "boundaries/framework/contracts/tool-contracts/spec/typespec/main.tsp",
    rationale: "KRT-AL002 G1: tool-contracts TypeSpec source",
  },
  {
    packetId: "tuvren.framework.event-stream-sse",
    sourcePath:
      "boundaries/framework/contracts/event-stream-sse/spec/typespec/main.tsp",
    rationale: "KRT-AL002 G3: SSE projection TypeSpec source",
  },
  {
    packetId: "tuvren.framework.event-stream-sse",
    sourcePath:
      "boundaries/framework/conformance/fixtures/event-stream-sse-traces.json",
    rationale: "KRT-AL002 G3: WHATWG-normative SSE byte-trace fixtures",
  },
  {
    packetId: "tuvren.framework.event-stream-sse",
    sourcePath: "boundaries/framework/conformance/plans/event-stream-sse.json",
    rationale: "KRT-AL002 G3: SSE conformance plan",
  },
  {
    packetId: "tuvren.kernel.interop-grpc",
    sourcePath:
      "boundaries/kernel/interop/grpc/proto/tuvren/kernel/interop/v1/kernel_services.proto",
    rationale: "KRT-AL002 G4: kernel gRPC services proto",
  },
  {
    packetId: "tuvren.kernel.interop-grpc",
    sourcePath:
      "boundaries/kernel/interop/grpc/proto/tuvren/kernel/interop/v1/kernel_types.proto",
    rationale: "KRT-AL002 G4: kernel gRPC types proto",
  },
  {
    packetId: "tuvren.framework.interop-rust-kernel",
    sourcePath:
      "boundaries/framework/interop/rust-kernel/scenarios/suite-manifest.json",
    rationale: "KRT-AL002 G5: rust-kernel interop suite manifest",
  },
  {
    packetId: "tuvren.framework.interop-rust-kernel",
    sourcePath:
      "boundaries/framework/interop/rust-kernel/schemas/suite-manifest.schema.json",
    rationale:
      "KRT-AL002 G5: rust-kernel interop suite manifest JSON Schema (authoritative source for the manifest shape)",
  },
  {
    packetId: "tuvren.telemetry.semconv",
    sourcePath: "telemetry/semconv/tuvren-runtime.yaml",
    rationale: "KRT-AL002 G6: telemetry semconv YAML",
  },
];

await main();

async function main(): Promise<void> {
  const failures = await runPortabilityGate();

  if (failures.length > 0) {
    console.error("portability gate failed:");
    for (const failure of failures) {
      console.error(`  [${failure.rule}] ${failure.message}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(
    `portability gate passed (${EXPECTED_PACKET_TOPOLOGY.length} packets, ${STANDING_EXCEPTION_SURFACES.length} standing exceptions, ${REQUIRED_AUTHORITATIVE_SOURCES.length} required sources)`
  );
}

async function runPortabilityGate(): Promise<PortabilityGateFailure[]> {
  const failures: PortabilityGateFailure[] = [];
  const onDiskManifests = await loadAllManifests();
  const adapterManifests = await loadAllAdapterManifests();
  const expectedPacketIds = new Set(
    EXPECTED_PACKET_TOPOLOGY.map((entry) => entry.packetId)
  );
  const expectedPaths = new Set(
    EXPECTED_PACKET_TOPOLOGY.map((entry) => entry.packetPath)
  );

  failures.push(...checkInventoryExists());
  failures.push(...checkExpectedTopologyIsUnique());
  failures.push(
    ...checkExpectedPacketsPresent(expectedPacketIds, onDiskManifests)
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
  failures.push(...checkStandingExceptions(onDiskManifests));
  failures.push(...checkRequiredSources(onDiskManifests));
  failures.push(...checkAdapterCoverage(onDiskManifests, adapterManifests));

  return failures;
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

function checkExpectedTopologyIsUnique(): PortabilityGateFailure[] {
  // The expected-topology table is the gate's source of truth, so a typo or
  // copy-paste mistake that duplicates a packetId or packetPath would silently
  // narrow what we enforce. Catch that here rather than letting it propagate.
  const failures: PortabilityGateFailure[] = [];
  const seenPacketIds = new Set<string>();
  const seenPaths = new Set<string>();

  for (const entry of EXPECTED_PACKET_TOPOLOGY) {
    if (seenPacketIds.has(entry.packetId)) {
      failures.push({
        rule: "expected-topology-unique",
        message: `EXPECTED_PACKET_TOPOLOGY lists packetId ${entry.packetId} more than once`,
      });
    } else {
      seenPacketIds.add(entry.packetId);
    }

    if (seenPaths.has(entry.packetPath)) {
      failures.push({
        rule: "expected-topology-unique",
        message: `EXPECTED_PACKET_TOPOLOGY lists packetPath ${entry.packetPath} more than once`,
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
  const paths = await findFilesByName(
    BOUNDARIES_ROOT,
    ADAPTER_MANIFEST_FILE_NAME
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
  if (!existsSync(directory)) {
    return [];
  }

  const entries = await readdir(directory, { withFileTypes: true });
  const paths: string[] = [];

  for (const entry of entries) {
    const entryPath = resolve(directory, entry.name);

    if (entry.isDirectory()) {
      paths.push(...(await findFilesByName(entryPath, fileName)));
      continue;
    }

    if (entry.isFile() && entry.name === fileName) {
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

function checkExpectedPacketsPresent(
  expectedPacketIds: ReadonlySet<string>,
  onDisk: ReadonlyMap<string, AuthorityPacketManifest>
): PortabilityGateFailure[] {
  const failures: PortabilityGateFailure[] = [];
  const seenPacketIds = new Set(
    [...onDisk.values()].map((manifest) => manifest.packetId)
  );

  for (const expected of EXPECTED_PACKET_TOPOLOGY) {
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
  onDisk: ReadonlyMap<string, AuthorityPacketManifest>
): PortabilityGateFailure[] {
  const failures: PortabilityGateFailure[] = [];

  for (const exception of STANDING_EXCEPTION_SURFACES) {
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
  onDisk: ReadonlyMap<string, AuthorityPacketManifest>
): PortabilityGateFailure[] {
  const failures: PortabilityGateFailure[] = [];
  const manifestsByPacketId = new Map<string, AuthorityPacketManifest>();

  for (const manifest of onDisk.values()) {
    manifestsByPacketId.set(manifest.packetId, manifest);
  }

  for (const required of REQUIRED_AUTHORITATIVE_SOURCES) {
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

    const declared = manifest.authoritativeSources.some(
      (source) => source.path === required.sourcePath
    );

    if (!declared) {
      failures.push({
        rule: "required-sources",
        message: `${required.rationale}: ${required.sourcePath} exists on disk but is not declared under ${required.packetId}.authoritativeSources`,
      });
    }
  }

  return failures;
}
