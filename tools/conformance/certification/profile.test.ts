import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { spawn } from "bun";

import { PINNED_CERTIFICATION_EVIDENCE } from "../../scripts/conformance/certification-schema-examples.ts";
import { assertConformanceEvidence } from "../../scripts/lib/conformance-contract.ts";
import { selectCheck } from "../harness/check-selection.ts";
import { readAdapterManifest, readPlans } from "../harness/run-plans.ts";
import { finishCertificate } from "./bundle.ts";
import {
  assertCertificateUndetectedClaims,
  assertProfileCapabilities,
  assertProfileClaimInventory,
  findProfileSelectionFailures,
  readClaimedProfiles,
  readProfileAuthority,
  readProfileUndetectedClaims,
  readUndetectedRegister,
} from "./profile.ts";

test("real profile bundles round-trip and validate the packet-resolved register", async () => {
  const adapterPath =
    "typescript/kernel/conformance-adapter/adapter-sqlite.json";
  const manifest = await readAdapterManifest(adapterPath);
  const profiles = (await readProfileAuthority(manifest.authorityPackets)).get(
    "tuvren.kernel.protocol"
  );
  if (profiles === undefined) {
    throw new Error("missing kernel profiles");
  }
  for (const profile of profiles) {
    const expected = await readProfileUndetectedClaims(
      manifest.authorityPackets,
      profile
    );
    const register = await readUndetectedRegister(
      "spec/kernel/authority-packet.json",
      profile.profileId
    );
    expect(
      Object.fromEntries(
        expected.map(({ claimId, reason }) => [claimId, reason])
      )
    ).toEqual(register);
    expect(expected.length > 0).toBe(profile.profileId === "kernel.memory");
    const fields = await finishCertificate(
      {
        adapter: adapterPath,
        capabilities: [],
        checks: [],
        packets: [],
        plans: [],
      },
      manifest,
      profile,
      [],
      [],
      "not_applicable",
      undefined
    );
    expect(fields.undetectedClaims).toEqual(expected);
    if (expected.length > 0) {
      await expect(
        finishCertificate(
          {
            adapter: adapterPath,
            capabilities: [],
            checks: [],
            packets: [],
            plans: [],
          },
          manifest,
          profile,
          [],
          [],
          "not_applicable",
          undefined,
          { undetectedClaims: [] }
        )
      ).rejects.toThrow("register");
    }
    const bundle: unknown = JSON.parse(
      JSON.stringify({ ...PINNED_CERTIFICATION_EVIDENCE, ...fields })
    );
    assertConformanceEvidence(bundle, profile.profileId);
    await expect(
      assertCertificateUndetectedClaims(
        bundle,
        manifest.authorityPackets,
        profile
      )
    ).resolves.toEqual(expected);
    const original = { ...PINNED_CERTIFICATION_EVIDENCE, ...fields };
    const omitted = { ...original };
    Reflect.deleteProperty(omitted, "undetectedClaims");
    expect(() => assertConformanceEvidence(omitted, profile.profileId)).toThrow(
      "undetectedClaims"
    );
    const first = expected[0];
    const invalid = [
      [...expected, { claimId: "unrelated", reason: "gap" }],
      ...(first === undefined
        ? []
        : [
            expected.slice(1),
            [{ ...first, reason: "changed" }, ...expected.slice(1)],
            [...expected, first],
          ]),
    ];
    for (const undetectedClaims of invalid) {
      await expect(
        assertCertificateUndetectedClaims(
          { ...original, undetectedClaims },
          manifest.authorityPackets,
          profile
        )
      ).rejects.toThrow("register");
    }
  }
});

test("a complete profile run rejects a missing required capability", () => {
  const profiles = [
    {
      profileId: "example.profile",
      requiredCapabilities: ["required"],
      claimIds: [],
      faultPoints: [],
      negativeControls: [],
      requiredEvidence: [],
    },
  ];
  expect(() => assertProfileCapabilities(profiles, [], true)).toThrow(
    "required"
  );
  expect(() =>
    assertProfileCapabilities(profiles, ["required"], true)
  ).not.toThrow();
  expect(() => assertProfileCapabilities(profiles, [], false)).not.toThrow();
});

test("a claimed profile rejects a non-applicable required check", async () => {
  const adapter = await readAdapterManifest(
    "typescript/kernel/conformance-adapter/adapter.json"
  );
  const [profile] = await readClaimedProfiles(
    adapter,
    adapter.authorityPackets
  );
  if (profile === undefined) {
    throw new Error("missing memory profile");
  }
  const plans = await readPlans(adapter, { packets: [], plans: [] });
  const required = plans
    .flatMap(({ checks }) => checks)
    .find(({ check }) =>
      check.claimIds?.some((claim) => profile.claimIds.includes(claim))
    );
  if (required === undefined) {
    throw new Error("missing profile check");
  }
  expect(
    findProfileSelectionFailures([profile], plans, [
      {
        checkId: required.check.checkId,
        selected: false,
        reason: "missing capabilities: required",
      },
    ])
  ).toContainEqual({
    profileId: profile.profileId,
    requiredCheckId: required.check.checkId,
    reason: "missing capabilities: required",
  });
});

test("the composite capability retains legacy coverage without selecting it for Rust", async () => {
  const adapters = [
    "go/kernel-conformance-adapter/adapter.json",
    "python/kernel-conformance-adapter/adapter.json",
    "dart/kernel-conformance-adapter/adapter.json",
    "typescript/kernel/conformance-adapter/adapter.json",
    "typescript/kernel/conformance-adapter/adapter-mutant.json",
    "typescript/kernel/conformance-adapter/adapter-postgres.json",
    "typescript/kernel/conformance-adapter/adapter-sqlite.json",
    "rust/kernel-conformance-adapter/adapter.json",
    "rust/kernel-conformance-adapter/adapter-mutant.json",
  ];
  const catalog: unknown = JSON.parse(
    await readFile("spec/conformance/kernel/operations.json", "utf8")
  );
  expect(catalog).toEqual(
    expect.objectContaining({
      operations: expect.arrayContaining([
        expect.objectContaining({
          operationId: "kernel.protocol.edge-validation",
          capability: "kernel.edge-validation.composite",
        }),
      ]),
    })
  );

  for (const path of adapters) {
    const adapter = await readAdapterManifest(path);
    const plans = await readPlans(adapter, { packets: [], plans: [] });
    const legacy = plans.flatMap((plan) =>
      plan.checks.filter(({ check }) =>
        check.checkId.startsWith("kernel-protocol-af.")
      )
    );
    expect(legacy).toHaveLength(7);
    expect(
      legacy.every(({ check }) =>
        check.capabilities?.includes("kernel.edge-validation.composite")
      )
    ).toBe(true);
    const selected = legacy.filter(
      ({ check }) =>
        selectCheck({
          adapter: new Set(adapter.capabilities),
          checkId: check.checkId,
          protocolVersion: adapter.protocol.version,
          requested: new Set(),
          required: check.capabilities ?? [],
          steps: check.steps,
        }).selected
    );
    expect(selected).toHaveLength(path.startsWith("rust/") ? 0 : 7);
    expect(adapter.capabilities).toContain("kernel.edge-validation");
  }
});

test("packet overrides resolve claimed profiles and their authority together", async () => {
  const adapter = await readAdapterManifest(
    "typescript/kernel/conformance-adapter/adapter.json"
  );
  const overridden = {
    ...adapter,
    authorityPackets: ["spec/core/authority-packet.json"],
  };
  const packets = ["spec/kernel/authority-packet.json"];
  const profiles = await readClaimedProfiles(overridden, packets);
  const authority = await readProfileAuthority(packets);
  const plans = await readPlans(overridden, { packets, plans: [] });
  expect(profiles).toHaveLength(1);
  for (const profile of profiles) {
    expect(() =>
      assertProfileClaimInventory(profile, plans, authority)
    ).not.toThrow();
  }
});

test("each kernel profile has an exact two-way claim inventory", async () => {
  const adapter = await readAdapterManifest(
    "typescript/kernel/conformance-adapter/adapter-sqlite.json"
  );
  const authority = await readProfileAuthority(adapter.authorityPackets);
  const profiles = authority.get("tuvren.kernel.protocol");
  if (profiles === undefined) {
    throw new Error("missing kernel profiles");
  }
  expect(
    profiles.map(({ profileId, claimIds }) => [profileId, claimIds.length])
  ).toEqual([
    ["kernel.memory", 147],
    ["kernel.persistent-reopen", 6],
    ["kernel.process-crash", 4],
    ["kernel.shared-backend", 3],
  ]);
  const plans = await readPlans(adapter, { packets: [], plans: [] });
  for (const profile of profiles) {
    expect(() =>
      assertProfileClaimInventory(profile, plans, authority)
    ).not.toThrow();
    for (const claim of profile.claimIds) {
      expect(() =>
        assertProfileClaimInventory(
          {
            ...profile,
            claimIds: profile.claimIds.filter((id) => id !== claim),
          },
          plans,
          authority
        )
      ).toThrow(claim);
    }
    expect(() =>
      assertProfileClaimInventory(
        {
          ...profile,
          claimIds: [...profile.claimIds, "kernel.syscall.invented"],
        },
        plans,
        authority
      )
    ).toThrow("kernel.syscall.invented");
  }
});

test("a complete harness run rejects a changed durable inventory before launching the adapter", async () => {
  const adapter = await readAdapterManifest(
    "typescript/kernel/conformance-adapter/adapter-sqlite.json"
  );
  const authority = await readProfileAuthority(adapter.authorityPackets);
  const profiles = authority.get("tuvren.kernel.protocol");
  if (profiles === undefined) {
    throw new Error("missing kernel profiles");
  }
  const packet: unknown = JSON.parse(
    await readFile("spec/kernel/authority-packet.json", "utf8")
  );
  if (typeof packet !== "object" || packet === null || Array.isArray(packet)) {
    throw new Error("invalid kernel packet");
  }
  const directory = await mkdtemp(path.join(tmpdir(), "profile-inventory-"));
  try {
    const packetPath = path.join(directory, "packet.json");
    const profilesPath = path.join(directory, "profiles.json");
    const adapterPath = path.join(directory, "adapter.json");
    await writeFile(
      packetPath,
      JSON.stringify({ ...packet, certificationProfiles: profilesPath })
    );
    await writeFile(
      adapterPath,
      JSON.stringify({
        ...adapter,
        authorityPackets: [packetPath],
        executable: path.join(directory, "must-not-launch"),
        profiles: ["kernel.persistent-reopen"],
      })
    );
    const missingClaim = "kernel.syscall.reopen.pending_state";
    const orphan = "kernel.syscall.reopen.orphan";
    for (const kind of ["missing", "orphan"] as const) {
      await writeFile(
        profilesPath,
        JSON.stringify({
          profiles: profiles.map((profile) =>
            profile.profileId === "kernel.persistent-reopen"
              ? {
                  ...profile,
                  claimIds:
                    kind === "missing"
                      ? profile.claimIds.filter(
                          (claim) => claim !== missingClaim
                        )
                      : [...profile.claimIds, orphan],
                }
              : profile
          ),
        })
      );
      const child = spawn(
        [
          process.execPath,
          "tools/conformance/harness/run.ts",
          "--adapter",
          adapterPath,
        ],
        { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" }
      );
      const [code, stderr] = await Promise.all([
        child.exited,
        new Response(child.stderr).text(),
        new Response(child.stdout).text(),
      ]);
      expect(code).toBe(1);
      expect(stderr).toContain("claim inventory mismatch");
      expect(stderr).toContain(kind === "missing" ? missingClaim : orphan);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

test("shared checks have one owner even when another profile has their capabilities", async () => {
  const adapter = await readAdapterManifest(
    "typescript/kernel/conformance-adapter/adapter-postgres.json"
  );
  const authority = await readProfileAuthority(adapter.authorityPackets);
  const profiles = authority.get("tuvren.kernel.protocol") ?? [];
  const memory = profiles.find((entry) => entry.profileId === "kernel.memory");
  const reopen = profiles.find(
    (entry) => entry.profileId === "kernel.persistent-reopen"
  );
  const crash = profiles.find(
    (entry) => entry.profileId === "kernel.process-crash"
  );
  const shared = profiles.find(
    (entry) => entry.profileId === "kernel.shared-backend"
  );
  if (
    memory === undefined ||
    reopen === undefined ||
    crash === undefined ||
    shared === undefined
  ) {
    throw new Error("missing kernel profile");
  }
  const plans = await readPlans(adapter, { packets: [], plans: [] });
  const coreClaim = "kernel.syscall.scope-isolation.own_content";
  const reopenClaim = "kernel.syscall.reopen.pending_state";
  const sharedClaim = "kernel.syscall.shared_writer.race";
  for (const [profile, claim] of [
    [reopen, coreClaim],
    [crash, reopenClaim],
    [shared, reopenClaim],
    [reopen, sharedClaim],
  ] as const) {
    expect(() =>
      assertProfileClaimInventory(
        { ...profile, claimIds: [...profile.claimIds, claim] },
        plans,
        authority
      )
    ).toThrow(claim);
  }
  expect(memory.claimIds).toContain(coreClaim);
  expect(reopen.claimIds).toContain(reopenClaim);
  expect(shared.claimIds).toContain(sharedClaim);
});

test("inventory includes step claims and rejects claims whose checks are missing", async () => {
  const adapter = await readAdapterManifest(
    "typescript/kernel/conformance-adapter/adapter-sqlite.json"
  );
  const authority = await readProfileAuthority(adapter.authorityPackets);
  const profile = authority
    .get("tuvren.kernel.protocol")
    ?.find((entry) => entry.profileId === "kernel.persistent-reopen");
  if (profile === undefined) {
    throw new Error("missing reopen profile");
  }
  const plans = await readPlans(adapter, { packets: [], plans: [] });
  const claim = "kernel.syscall.reopen.pending_state";
  const withoutCheck = plans.map((plan) => ({
    ...plan,
    checks: plan.checks.filter(({ check }) => !check.claimIds?.includes(claim)),
  }));
  expect(() =>
    assertProfileClaimInventory(profile, withoutCheck, authority)
  ).toThrow(claim);

  const stepClaim = "kernel.syscall.reopen.new_step_claim";
  const withStepClaim = plans.map((plan) => ({
    ...plan,
    checks: plan.checks.map((compiled) => {
      const { check } = compiled;
      if (!check.claimIds?.includes(claim)) {
        return compiled;
      }
      return {
        ...compiled,
        check: {
          ...check,
          steps: (check.steps ?? []).map((step, index) =>
            index === 0
              ? { ...step, claimIds: [...(step.claimIds ?? []), stepClaim] }
              : step
          ),
        },
      };
    }),
  }));
  expect(() =>
    assertProfileClaimInventory(profile, withStepClaim, authority)
  ).toThrow(stepClaim);
  expect(() =>
    assertProfileClaimInventory(
      { ...profile, claimIds: [...profile.claimIds, stepClaim] },
      withStepClaim,
      authority
    )
  ).not.toThrow();
});

test("inventory does not accept checks from another packet or duplicate ownership", async () => {
  const adapter = await readAdapterManifest(
    "typescript/kernel/conformance-adapter/adapter-postgres.json"
  );
  const authority = await readProfileAuthority(adapter.authorityPackets);
  const profiles = authority.get("tuvren.kernel.protocol") ?? [];
  const reopen = profiles.find(
    (entry) => entry.profileId === "kernel.persistent-reopen"
  );
  if (reopen === undefined) {
    throw new Error("missing reopen profile");
  }
  const plans = await readPlans(adapter, { packets: [], plans: [] });
  const reopenPlan = plans.find((plan) =>
    plan.checks.some(({ check }) =>
      check.claimIds?.includes("kernel.syscall.reopen.pending_state")
    )
  );
  if (reopenPlan === undefined) {
    throw new Error("missing reopen plan");
  }
  const foreignClaim = "kernel.syscall.foreign";
  const foreignPlan = {
    ...reopenPlan,
    plan: { ...reopenPlan.plan, packetId: "other.packet" },
    checks: reopenPlan.checks.map((compiled) => ({
      ...compiled,
      check: { ...compiled.check, claimIds: [foreignClaim], steps: [] },
    })),
  };
  expect(() =>
    assertProfileClaimInventory(
      { ...reopen, claimIds: [...reopen.claimIds, foreignClaim] },
      [...plans, foreignPlan],
      authority
    )
  ).toThrow(foreignClaim);

  const sharedClaim = "kernel.syscall.shared_writer.race";
  const duplicateClaim = "kernel.syscall.reopen.pending_state";
  const conflicting = plans.map((plan) => ({
    ...plan,
    checks: plan.checks.map((compiled) => ({
      ...compiled,
      check: compiled.check.claimIds?.includes(sharedClaim)
        ? {
            ...compiled.check,
            claimIds: [...compiled.check.claimIds, duplicateClaim],
          }
        : compiled.check,
    })),
  }));
  expect(() =>
    assertProfileClaimInventory(reopen, conflicting, authority)
  ).toThrow("conflicting profile ownership");
});

test("inventory fails closed when capability-based ownership is ambiguous", async () => {
  const adapter = await readAdapterManifest(
    "typescript/kernel/conformance-adapter/adapter-postgres.json"
  );
  const authority = await readProfileAuthority(adapter.authorityPackets);
  const profiles = authority.get("tuvren.kernel.protocol") ?? [];
  const shared = profiles.find(
    (entry) => entry.profileId === "kernel.shared-backend"
  );
  if (shared === undefined) {
    throw new Error("missing shared-backend profile");
  }
  const ambiguousAuthority = new Map(authority);
  ambiguousAuthority.set("tuvren.kernel.protocol", [
    ...profiles,
    {
      ...shared,
      profileId: "kernel.other",
      requiredCapabilities: [
        "kernel.syscall",
        "kernel.protocol",
        "kernel.persistence.durable",
        "kernel.barrier",
        "kernel.shared-lease-clock",
        "kernel.fault-injection",
      ],
    },
  ]);
  const plans = await readPlans(adapter, { packets: [], plans: [] });
  expect(() =>
    assertProfileClaimInventory(shared, plans, ambiguousAuthority)
  ).toThrow("ambiguous profile ownership");
});

test("memory codec inventory rejects omitted claims, capability, and unclaimed codec checks", async () => {
  const adapter = await readAdapterManifest(
    "typescript/kernel/conformance-adapter/adapter.json"
  );
  const authority = await readProfileAuthority(adapter.authorityPackets);
  const profile = authority
    .get("tuvren.kernel.protocol")
    ?.find(({ profileId }) => profileId === "kernel.memory");
  if (profile === undefined) {
    throw new Error("missing memory profile");
  }
  const plans = await readPlans(adapter, { packets: [], plans: [] });
  const codecs = plans.filter(({ plan }) =>
    plan.applicability.capabilities.includes("kernel.codec")
  );
  expect(codecs).toHaveLength(1);
  const claims = codecs.flatMap(({ checks }) =>
    checks.flatMap(({ check }) => check.claimIds ?? [])
  );
  expect(claims).toHaveLength(69);
  for (const claim of claims) {
    expect(() =>
      assertProfileClaimInventory(
        { ...profile, claimIds: profile.claimIds.filter((id) => id !== claim) },
        plans,
        authority
      )
    ).toThrow(claim);
  }
  expect(() =>
    assertProfileClaimInventory(
      {
        ...profile,
        requiredCapabilities: profile.requiredCapabilities.filter(
          (capability) => capability !== "kernel.codec"
        ),
      },
      plans,
      authority
    )
  ).toThrow("kernel.codec");
  expect(() =>
    assertProfileCapabilities(
      [profile],
      adapter.capabilities.filter(
        (capability) => capability !== "kernel.codec"
      ),
      true
    )
  ).toThrow("kernel.codec");
  const missing = plans.map((plan) =>
    plan.plan.applicability.capabilities.includes("kernel.codec")
      ? {
          ...plan,
          checks: plan.checks.map(({ check, ...compiled }) => ({
            ...compiled,
            check: {
              ...check,
              claimIds: [],
              steps: check.steps?.map((step) => ({ ...step, claimIds: [] })),
            },
          })),
        }
      : plan
  );
  expect(() =>
    assertProfileClaimInventory(profile, missing, authority)
  ).toThrow("requires codec claimIds");
});

test("memory scope inventory rejects omitted capabilities and cross-scope claims", async () => {
  const adapter = await readAdapterManifest(
    "typescript/kernel/conformance-adapter/adapter.json"
  );
  const [profile] = await readClaimedProfiles(
    adapter,
    adapter.authorityPackets
  );
  if (profile === undefined) {
    throw new Error("missing memory profile");
  }
  const plans = await readPlans(adapter, { packets: [], plans: [] });
  const authority = await readProfileAuthority(adapter.authorityPackets);
  for (const claim of [
    "kernel.scope-isolation.store_has_is_scope_confined",
    "kernel.scope-isolation.store_get_is_scope_confined",
    "kernel.scope-isolation.enumeration_is_scope_confined",
  ]) {
    expect(() =>
      assertProfileClaimInventory(
        { ...profile, claimIds: profile.claimIds.filter((id) => id !== claim) },
        plans,
        authority
      )
    ).toThrow(claim);
  }
  expect(() =>
    assertProfileClaimInventory(
      {
        ...profile,
        requiredCapabilities: profile.requiredCapabilities.filter(
          (id) => id !== "kernel.scope-isolation"
        ),
      },
      plans,
      authority
    )
  ).toThrow("kernel.scope-isolation");
  expect(() =>
    assertProfileCapabilities(
      [profile],
      adapter.capabilities.filter((id) => id !== "kernel.scope-isolation"),
      true
    )
  ).toThrow("kernel.scope-isolation");
});
