import { expect, test } from "bun:test";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { readAdapterManifest } from "../harness/run-plans.ts";
import {
  collectSourceVerifierInputs,
  computeSourceVerifierDigests,
  createDependencyDigestCache,
  digestVerifierAuthority,
  digestWorkspaceInputs,
} from "./provenance.ts";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const LEGACY_PACKET = "spec/kernel/legacy/authority-packet.json";
const KERNEL_LANES: readonly (readonly [string, boolean])[] = [
  ["go/kernel-conformance-adapter/adapter.json", true],
  ["python/kernel-conformance-adapter/adapter.json", true],
  ["dart/kernel-conformance-adapter/adapter.json", true],
  ["typescript/kernel/conformance-adapter/adapter.json", false],
  ["rust/kernel-conformance-adapter/adapter.json", false],
];

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const legacyPacketDocument = async (): Promise<Record<string, unknown>> => {
  const value: unknown = JSON.parse(
    await readFile(path.join(ROOT, LEGACY_PACKET), "utf8")
  );
  if (!isPlainObject(value)) {
    throw new Error("invalid legacy packet");
  }
  return value;
};

const legacyOwnedFiles = async (): Promise<string[]> => {
  const packet = await legacyPacketDocument();
  const owned = [path.join(ROOT, LEGACY_PACKET)];
  const catalog = packet.operationCatalog;
  if (typeof catalog !== "string") {
    throw new Error("legacy packet has no operation catalog");
  }
  owned.push(path.join(ROOT, catalog));
  const plans = packet.conformancePlans;
  if (!Array.isArray(plans)) {
    throw new Error("legacy packet has no conformance plans");
  }
  for (const entry of plans) {
    if (!isPlainObject(entry) || typeof entry.path !== "string") {
      throw new Error("invalid legacy plan entry");
    }
    const planPath = path.join(ROOT, entry.path);
    owned.push(planPath);
    const plan: unknown = JSON.parse(await readFile(planPath, "utf8"));
    if (!isPlainObject(plan)) {
      throw new Error(`invalid legacy plan ${entry.path}`);
    }
    for (const key of ["fixtures", "scenarios"] as const) {
      const fixtures = plan[key];
      if (fixtures === undefined) {
        continue;
      }
      if (!isPlainObject(fixtures)) {
        throw new Error(`invalid fixture section in ${entry.path}`);
      }
      for (const fixture of Object.values(fixtures)) {
        if (typeof fixture !== "string") {
          throw new Error(`invalid fixture path in ${entry.path}`);
        }
        owned.push(path.resolve(path.dirname(planPath), fixture));
      }
    }
  }
  return owned;
};

const laneInputs = (inputs: {
  authority: readonly string[];
  catalogs: readonly string[];
  controls: readonly string[];
  fixtures: readonly string[];
  packets: readonly string[];
  plans: readonly string[];
  profiles: readonly string[];
  registers: readonly string[];
}): string[] => [
  ...inputs.authority,
  ...inputs.packets,
  ...inputs.plans,
  ...inputs.catalogs,
  ...inputs.profiles,
  ...inputs.controls,
  ...inputs.fixtures,
  ...inputs.registers,
];

test("dependency links cover resolved workspace contents", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "provenance-test-"));
  try {
    const source = path.join(directory, "package");
    const modules = path.join(directory, "node_modules");
    await mkdir(source);
    await mkdir(modules);
    await writeFile(path.join(source, "index.ts"), "first");
    const link = path.join(modules, "package");
    await symlink(source, link, "dir");
    const before = await digestWorkspaceInputs([link], directory);
    const cachedDigest = createDependencyDigestCache(modules, directory);
    const beforeCached = await cachedDigest();
    await writeFile(path.join(source, "index.ts"), "second");
    expect(await digestWorkspaceInputs([link], directory)).not.toBe(before);
    expect(await cachedDigest()).not.toBe(beforeCached);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("verifier-authority digests cover explicitly selected register content and references", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "register-provenance-"));
  try {
    const register = path.join(directory, "register.json");
    const packet = path.join(directory, "packet.json");
    await writeFile(register, "{}\n");
    await writeFile(packet, "packet");
    const before = await digestVerifierAuthority([packet], [register]);
    await writeFile(register, '{"claim":"reason"}\n');
    expect(await digestVerifierAuthority([packet], [register])).not.toBe(
      before
    );
    expect(await digestVerifierAuthority([packet], [])).not.toBe(before);

    const actualPacket: unknown = JSON.parse(
      await readFile("spec/kernel/authority-packet.json", "utf8")
    );
    if (
      typeof actualPacket !== "object" ||
      actualPacket === null ||
      Array.isArray(actualPacket) ||
      !("undetectedRegisters" in actualPacket)
    ) {
      throw new Error("invalid packet");
    }
    const references = actualPacket.undetectedRegisters;
    if (
      typeof references !== "object" ||
      references === null ||
      Array.isArray(references)
    ) {
      throw new Error("missing registers");
    }
    await writeFile(packet, JSON.stringify(actualPacket));
    const actual = await computeSourceVerifierDigests([packet]);
    const actualInputs = await collectSourceVerifierInputs([packet]);
    for (const registerPath of Object.values(references)) {
      if (typeof registerPath !== "string") {
        throw new Error("invalid register path");
      }
      expect(actualInputs.registers).toContain(path.resolve(registerPath));
    }
    const changed = {
      ...actualPacket,
      undetectedRegisters: {
        ...references,
        "kernel.persistent-reopen":
          "tools/conformance/meta-conformance/fixtures/undetected-stale.json",
      },
    };
    await writeFile(packet, JSON.stringify(changed));
    const drift = await computeSourceVerifierDigests([packet]);
    const inputs = await collectSourceVerifierInputs([packet]);
    const selectedRegister = path.resolve(
      "tools/conformance/meta-conformance/fixtures/undetected-stale.json"
    );
    expect(inputs.registers).toContain(selectedRegister);
    const authorityInputs = [
      ...inputs.authority,
      ...inputs.packets,
      ...inputs.plans,
      ...inputs.catalogs,
      ...inputs.profiles,
      ...inputs.controls,
      ...inputs.fixtures,
    ];
    expect(
      await digestVerifierAuthority(authorityInputs, inputs.registers)
    ).toBe(drift.verifierAuthority);
    expect(
      await digestVerifierAuthority(
        authorityInputs,
        inputs.registers.filter((file) => file !== selectedRegister)
      )
    ).not.toBe(drift.verifierAuthority);
    const scratchRegisters = inputs.registers.map((file) =>
      file === selectedRegister ? register : file
    );
    const beforeContentDrift = await digestVerifierAuthority(
      authorityInputs,
      scratchRegisters
    );
    await writeFile(register, '{"claim":"changed"}\n');
    expect(
      await digestVerifierAuthority(authorityInputs, scratchRegisters)
    ).not.toBe(beforeContentDrift);
    expect(drift.verifierAuthority).not.toBe(actual.verifierAuthority);
    expect(drift.profiles).toBe(actual.profiles);
    expect(drift.controls).toBe(actual.controls);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("verifier authority includes legacy packet paths only for adapters that select the legacy packet", async () => {
  const legacyOwned = await legacyOwnedFiles();
  let selecting:
    | Awaited<ReturnType<typeof computeSourceVerifierDigests>>
    | undefined;
  let canonical:
    | Awaited<ReturnType<typeof computeSourceVerifierDigests>>
    | undefined;
  for (const [manifestPath, selectsLegacy] of KERNEL_LANES) {
    const manifest = await readAdapterManifest(manifestPath);
    expect(manifest.authorityPackets.includes(LEGACY_PACKET)).toBe(
      selectsLegacy
    );
    const inputs = await collectSourceVerifierInputs(manifest.authorityPackets);
    const selected = new Set(
      laneInputs(inputs).map((file) => path.relative(ROOT, file))
    );
    for (const legacyPath of legacyOwned) {
      expect(selected.has(path.relative(ROOT, legacyPath))).toBe(selectsLegacy);
    }
    const digests = await computeSourceVerifierDigests(
      manifest.authorityPackets
    );
    if (selectsLegacy) {
      selecting = digests;
    } else {
      canonical = digests;
    }
  }
  if (selecting === undefined || canonical === undefined) {
    throw new Error("missing kernel lanes");
  }
  expect(canonical.verifierAuthority).not.toBe(selecting.verifierAuthority);
  expect(canonical.packet).not.toBe(selecting.packet);
  expect(canonical.plans).not.toBe(selecting.plans);
  expect(canonical.catalogs).not.toBe(selecting.catalogs);
  expect(canonical.fixtures).not.toBe(selecting.fixtures);
});

test("mutating a legacy-only input changes only selecting adapters' aggregate digest", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "provenance-legacy-mutation-")
  );
  try {
    const packet = await legacyPacketDocument();
    const plans = packet.conformancePlans;
    const first = Array.isArray(plans) ? plans[0] : undefined;
    if (!isPlainObject(first) || typeof first.path !== "string") {
      throw new Error("missing legacy plan for the mutation");
    }
    const target = path.join(ROOT, first.path);
    const lanes: {
      inputFiles: string[];
      manifest: { authorityPackets: readonly string[] };
      selectsLegacy: boolean;
    }[] = [];
    for (const [manifestPath, selectsLegacy] of KERNEL_LANES) {
      const manifest = await readAdapterManifest(manifestPath);
      lanes.push({
        inputFiles: laneInputs(
          await collectSourceVerifierInputs(manifest.authorityPackets)
        ),
        manifest,
        selectsLegacy,
      });
    }
    const files = new Set<string>();
    for (const lane of lanes) {
      for (const file of lane.inputFiles) {
        files.add(file);
      }
    }
    const mapped = (file: string): string =>
      path.join(directory, path.relative(ROOT, file));
    for (const file of files) {
      await mkdir(path.dirname(mapped(file)), { recursive: true });
      await copyFile(file, mapped(file));
    }
    const snapshots: { before: string; lane: (typeof lanes)[number] }[] = [];
    for (const lane of lanes) {
      const digests = await computeSourceVerifierDigests(
        lane.manifest.authorityPackets
      );
      const before = await digestWorkspaceInputs(
        lane.inputFiles.map(mapped),
        directory
      );
      expect(before).toBe(digests.verifierAuthority);
      snapshots.push({ before, lane });
    }
    expect(
      lanes.some(
        (lane) => lane.selectsLegacy && lane.inputFiles.includes(target)
      )
    ).toBe(true);
    expect(
      lanes.some(
        (lane) => !lane.selectsLegacy && lane.inputFiles.includes(target)
      )
    ).toBe(false);
    await writeFile(
      mapped(target),
      `${await readFile(mapped(target), "utf8")}\n`
    );
    for (const { before, lane } of snapshots) {
      const after = await digestWorkspaceInputs(
        lane.inputFiles.map(mapped),
        directory
      );
      if (lane.selectsLegacy) {
        expect(after).not.toBe(before);
      } else {
        expect(after).toBe(before);
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
