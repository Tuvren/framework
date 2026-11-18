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

import { describe, expect, test } from "bun:test";

import {
  checkAdapterCoverage,
  checkExpectedPacketsPresent,
  checkNoUnexpectedPackets,
} from "./portability-gate.ts";

const LEGACY_PACKET_PATH = "spec/kernel/legacy/authority-packet.json";
const CANONICAL_PACKET_PATH = "spec/kernel/authority-packet.json";

const canonicalPacket = () => ({
  authoritativeSources: [],
  boundary: "kernel",
  conformancePlans: [
    {
      path: "spec/conformance/kernel/plans/kernel-codec.json",
      planId: "codec",
    },
  ],
  packetId: "tuvren.kernel.protocol",
  surface: "protocol",
  verificationPaths: [
    {
      kind: "conformance-plan",
      target: "spec/conformance/kernel/plans/kernel-codec.json",
    },
  ],
  version: "1.0.0",
});

const legacyPacket = (transitionalAdapters?: readonly string[]) => ({
  ...canonicalPacket(),
  conformancePlans: [
    {
      path: "spec/conformance/kernel/plans/kernel-protocol-core.json",
      planId: "core",
    },
  ],
  packetId: "tuvren.kernel.legacy",
  verificationPaths: [
    {
      kind: "conformance-plan",
      target: "spec/conformance/kernel/plans/kernel-protocol-core.json",
    },
  ],
  version: "0.1.0",
  ...(transitionalAdapters === undefined ? {} : { transitionalAdapters }),
});

const adapter = (
  adapterId: string,
  authorityPackets: readonly string[],
  boundary = "kernel"
) => ({
  adapterId,
  authorityPackets,
  boundary,
  capabilities: [] as string[],
});

const TRANSITIONAL_ADAPTERS = [
  "go/kernel-conformance-adapter/adapter.json",
  "python/kernel-conformance-adapter/adapter.json",
  "dart/kernel-conformance-adapter/adapter.json",
] as const;

const legacyAdapterManifests = () =>
  new Map(
    TRANSITIONAL_ADAPTERS.map((manifestPath) => [
      manifestPath,
      adapter(manifestPath, [CANONICAL_PACKET_PATH, LEGACY_PACKET_PATH]),
    ])
  );

const canonicalAdapterManifests = () =>
  new Map([
    [
      "typescript/kernel/conformance-adapter/adapter.json",
      adapter("typescript-kernel", [CANONICAL_PACKET_PATH]),
    ],
    [
      "rust/kernel-conformance-adapter/adapter.json",
      adapter("rust-kernel", [CANONICAL_PACKET_PATH]),
    ],
  ]);

const allAdapterManifests = () =>
  new Map([...legacyAdapterManifests(), ...canonicalAdapterManifests()]);

describe("transitional adapter coverage", () => {
  test("passes when exactly the declared transitionalAdapters reference the packet", () => {
    const failures = checkAdapterCoverage(
      new Map([[LEGACY_PACKET_PATH, legacyPacket([...TRANSITIONAL_ADAPTERS])]]),
      allAdapterManifests()
    );

    expect(failures).toEqual([]);
  });

  test("fails when a declared transitional adapter drops the packet", () => {
    const manifests = allAdapterManifests();
    const dart = manifests.get("dart/kernel-conformance-adapter/adapter.json");
    if (dart === undefined) {
      throw new Error("fixture adapter missing");
    }
    manifests.set("dart/kernel-conformance-adapter/adapter.json", {
      ...dart,
      authorityPackets: [CANONICAL_PACKET_PATH],
    });

    const failures = checkAdapterCoverage(
      new Map([[LEGACY_PACKET_PATH, legacyPacket([...TRANSITIONAL_ADAPTERS])]]),
      manifests
    );

    expect(failures).toHaveLength(1);
    expect(failures[0]?.rule).toBe("adapter-coverage");
    expect(failures[0]?.message).toContain("missing references");
    expect(failures[0]?.message).toContain(
      "dart/kernel-conformance-adapter/adapter.json"
    );
  });

  test("fails when an adapter outside the declared set references the packet", () => {
    const manifests = allAdapterManifests();
    const rust = manifests.get("rust/kernel-conformance-adapter/adapter.json");
    if (rust === undefined) {
      throw new Error("fixture adapter missing");
    }
    manifests.set("rust/kernel-conformance-adapter/adapter.json", {
      ...rust,
      authorityPackets: [CANONICAL_PACKET_PATH, LEGACY_PACKET_PATH],
    });

    const failures = checkAdapterCoverage(
      new Map([[LEGACY_PACKET_PATH, legacyPacket([...TRANSITIONAL_ADAPTERS])]]),
      manifests
    );

    expect(failures).toHaveLength(1);
    expect(failures[0]?.rule).toBe("adapter-coverage");
    expect(failures[0]?.message).toContain("unexpected references");
    expect(failures[0]?.message).toContain(
      "rust/kernel-conformance-adapter/adapter.json"
    );
  });

  test("keeps boundary-wide coverage for ordinary packets", () => {
    const failures = checkAdapterCoverage(
      new Map([[CANONICAL_PACKET_PATH, canonicalPacket()]]),
      allAdapterManifests()
    );

    expect(failures).toEqual([]);
  });

  test("still fails when an ordinary packet loses a boundary adapter", () => {
    const manifests = new Map([
      [
        "typescript/kernel/conformance-adapter/adapter.json",
        adapter("typescript-kernel", [CANONICAL_PACKET_PATH]),
      ],
      [
        "rust/kernel-conformance-adapter/adapter.json",
        adapter("rust-kernel", []),
      ],
    ]);

    const failures = checkAdapterCoverage(
      new Map([[CANONICAL_PACKET_PATH, canonicalPacket()]]),
      manifests
    );

    expect(failures).toHaveLength(1);
    expect(failures[0]?.message).toContain(
      "not referenced by every kernel-boundary adapter manifest"
    );
    expect(failures[0]?.message).toContain("rust-kernel");
  });
});

describe("expected packet topology", () => {
  const inventoryEntry = {
    classification: "portable" as const,
    packetId: "tuvren.kernel.legacy",
    packetPath: LEGACY_PACKET_PATH,
  };

  test("fails when the inventory names a packet that is missing on disk", () => {
    const failures = checkExpectedPacketsPresent(
      { expectedPackets: [inventoryEntry] },
      new Set(["tuvren.kernel.legacy"]),
      new Map([[CANONICAL_PACKET_PATH, canonicalPacket()]])
    );

    expect(failures).toHaveLength(2);
    expect(failures[0]?.message).toContain(
      `expected packet tuvren.kernel.legacy missing at ${LEGACY_PACKET_PATH}`
    );
    expect(failures[1]?.message).toContain(
      "inventory expects packetId tuvren.kernel.legacy but no on-disk packet declares it"
    );
  });

  test("fails when an on-disk packet is absent from the inventory", () => {
    const failures = checkNoUnexpectedPackets(
      new Set([CANONICAL_PACKET_PATH]),
      new Set(["tuvren.kernel.protocol"]),
      new Map([
        [CANONICAL_PACKET_PATH, canonicalPacket()],
        [LEGACY_PACKET_PATH, legacyPacket()],
      ])
    );

    expect(failures).toHaveLength(1);
    expect(failures[0]?.rule).toBe("no-unexpected-packets");
    expect(failures[0]?.message).toContain(
      "is not listed in EXPECTED_PACKET_TOPOLOGY"
    );
  });

  test("fails when an expected path declares a different packetId", () => {
    const failures = checkExpectedPacketsPresent(
      { expectedPackets: [inventoryEntry] },
      new Set(["tuvren.kernel.legacy"]),
      new Map([[LEGACY_PACKET_PATH, canonicalPacket()]])
    );

    expect(failures).toHaveLength(2);
    expect(failures[0]?.message).toContain(
      "declares packetId tuvren.kernel.protocol; inventory expects tuvren.kernel.legacy"
    );
    expect(failures[1]?.message).toContain(
      "inventory expects packetId tuvren.kernel.legacy but no on-disk packet declares it"
    );
  });
});
