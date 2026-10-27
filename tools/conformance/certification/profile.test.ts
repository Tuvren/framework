import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

import { selectCheck } from "../harness/check-selection.ts";
import { readAdapterManifest, readPlans } from "../harness/run-plans.ts";
import {
  assertKernelMemoryClaimInventory,
  assertProfileCapabilities,
  readClaimedProfiles,
} from "./profile.ts";

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

test("the memory profile cannot omit or invent a syscall claim", async () => {
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
  expect(() => assertKernelMemoryClaimInventory(profile, plans)).not.toThrow();
  expect(() =>
    assertKernelMemoryClaimInventory(
      { ...profile, claimIds: profile.claimIds.slice(1) },
      plans
    )
  ).toThrow("missing");
  expect(() =>
    assertKernelMemoryClaimInventory(
      {
        ...profile,
        claimIds: [...profile.claimIds, "kernel.syscall.invented"],
      },
      plans
    )
  ).toThrow("unknown");
});
