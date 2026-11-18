import { expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  collectSourceVerifierInputs,
  computeSourceVerifierDigests,
  createDependencyDigestCache,
  digestVerifierAuthority,
  digestWorkspaceInputs,
} from "./provenance.ts";

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
  const legacyOwned = [
    "spec/kernel/legacy/authority-packet.json",
    "spec/conformance/kernel/legacy-operations.json",
    "spec/conformance/kernel/plans/kernel-protocol-core.json",
    "spec/conformance/kernel/plans/kernel-protocol-extended.json",
    "spec/conformance/kernel/plans/kernel-run-liveness.json",
    "spec/conformance/kernel/plans/kernel-restart-recovery.json",
    "spec/conformance/kernel/plans/kernel-scope-isolation.json",
    "spec/conformance/kernel/plans/kernel-reclamation.json",
    "spec/conformance/kernel/fixtures/canonical-turn-tree-schema.json",
    "spec/conformance/kernel/fixtures/kernel-protocol-deterministic.json",
    "spec/conformance/kernel/fixtures/kernel-protocol-logical.json",
  ];
  const canonicalInputs = await collectSourceVerifierInputs([
    "spec/kernel/authority-packet.json",
  ]);
  const canonicalFiles = [
    ...canonicalInputs.authority,
    ...canonicalInputs.packets,
    ...canonicalInputs.plans,
    ...canonicalInputs.catalogs,
    ...canonicalInputs.profiles,
    ...canonicalInputs.controls,
    ...canonicalInputs.fixtures,
    ...canonicalInputs.registers,
  ].map((file) => path.relative(process.cwd(), file));
  for (const legacyPath of legacyOwned) {
    expect(canonicalFiles).not.toContain(path.resolve(legacyPath));
    expect(canonicalFiles.some((file) => file.endsWith(legacyPath))).toBe(
      false
    );
  }

  const selectingInputs = await collectSourceVerifierInputs([
    "spec/kernel/authority-packet.json",
    "spec/kernel/legacy/authority-packet.json",
  ]);
  const selectingFiles = selectingInputs.authority.map((file) =>
    path.relative(process.cwd(), file)
  );
  for (const legacyPath of legacyOwned) {
    expect(selectingFiles.some((file) => file.endsWith(legacyPath))).toBe(true);
  }

  const canonicalDigests = await computeSourceVerifierDigests([
    "spec/kernel/authority-packet.json",
  ]);
  const selectingDigests = await computeSourceVerifierDigests([
    "spec/kernel/authority-packet.json",
    "spec/kernel/legacy/authority-packet.json",
  ]);
  expect(selectingDigests.verifierAuthority).not.toBe(
    canonicalDigests.verifierAuthority
  );
  expect(selectingDigests.plans).not.toBe(canonicalDigests.plans);
  expect(selectingDigests.catalogs).not.toBe(canonicalDigests.catalogs);
});
