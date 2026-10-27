import { expect, test } from "bun:test";

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
