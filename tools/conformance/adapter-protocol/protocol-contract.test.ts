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
import { readFile } from "node:fs/promises";

import {
  assertAdapterProtocolContracts,
  findAdapterManifests,
  MISMATCHED_PARAMETER_FRAMES,
  PINNED_0_1_0_REQUESTS,
  PINNED_0_2_0_MANIFEST,
  PINNED_0_2_0_NOTIFICATIONS,
  PINNED_0_2_0_REQUESTS,
  PINNED_0_2_0_RESULTS,
  validateAdapterDefinition,
  validateAdapterFrame,
  validateAdapterManifest,
} from "./protocol-contract.ts";

const methodsOf = (frames: readonly { method: string }[]): string[] =>
  frames.map((frame) => frame.method).toSorted();

describe("adapter protocol 0.1.0 compatibility", () => {
  test("covers and accepts every 0.1.0 request", () => {
    expect(methodsOf(PINNED_0_1_0_REQUESTS)).toEqual(
      [
        "createInstance",
        "destroyInstance",
        "dispatch",
        "events",
        "initialize",
        "inspectState",
        "shutdown",
      ].toSorted()
    );

    for (const frame of PINNED_0_1_0_REQUESTS) {
      expect(validateAdapterFrame("request", frame)).toEqual([]);
    }
  });

  test("accepts every checked-in adapter manifest", async () => {
    const manifests = await findAdapterManifests();

    expect(manifests.length).toBeGreaterThan(0);
    await Promise.all(
      manifests.map(async (manifestPath) => {
        const manifest: unknown = JSON.parse(
          await readFile(manifestPath, "utf-8")
        );
        expect(validateAdapterManifest(manifest)).toEqual([]);
      })
    );
  });

  test("accepts 0.1.0 capabilities without the 0.2.0 fields", () => {
    expect(
      validateAdapterDefinition("AdapterCapabilities", {
        adapterId: "a",
        capabilities: [],
        packetId: "p",
        planVersion: "0.1.0",
      })
    ).toEqual([]);
  });
});

describe("adapter protocol 0.2.0", () => {
  test("covers and accepts every pinned request", () => {
    expect(methodsOf(PINNED_0_2_0_REQUESTS)).toEqual(
      [
        "armFault",
        "awaitOperation",
        "cancelOperation",
        "createInstance",
        "openInstance",
        "pull",
        "setClock",
        "startOperation",
        "subscribe",
      ].toSorted()
    );

    for (const frame of PINNED_0_2_0_REQUESTS) {
      expect(validateAdapterFrame("request", frame)).toEqual([]);
    }
  });

  test("covers and accepts every pinned notification", () => {
    expect(methodsOf(PINNED_0_2_0_NOTIFICATIONS)).toEqual(
      ["event", "eventsEnd", "faultReached"].toSorted()
    );

    for (const frame of PINNED_0_2_0_NOTIFICATIONS) {
      expect(validateAdapterFrame("notification", frame)).toEqual([]);
    }
  });

  test("accepts every pinned result shape", () => {
    for (const [definition, value] of PINNED_0_2_0_RESULTS) {
      expect(validateAdapterDefinition(definition, value)).toEqual([]);
    }
  });

  test.each(MISMATCHED_PARAMETER_FRAMES.map((entry) => [entry.label, entry]))(
    "rejects %s",
    (_label, entry) => {
      expect(
        validateAdapterFrame(entry.kind, entry.frame).length
      ).toBeGreaterThan(0);
    }
  );

  test("rejects result shapes with mismatched names", () => {
    expect(
      validateAdapterDefinition("StartOperationResult", { handle: "op-1" })
    ).not.toEqual([]);
    expect(
      validateAdapterDefinition("SubscribeResult", { subscriptionId: "s-1" })
    ).not.toEqual([]);
    expect(
      validateAdapterDefinition("ArmFaultResult", { id: "t-1" })
    ).not.toEqual([]);
    expect(
      validateAdapterDefinition("AdapterCapabilities", {
        adapterId: "a",
        capabilities: [],
        packetId: "p",
        planVersion: "0.1.0",
        storageKinds: ["s3-bucket"],
      })
    ).not.toEqual([]);
  });

  test("accepts a 0.2.0 manifest and rejects unknown storage, versions, and fields", () => {
    expect(validateAdapterManifest(PINNED_0_2_0_MANIFEST)).toEqual([]);

    for (const manifest of [
      { ...PINNED_0_2_0_MANIFEST, storage: "s3-bucket" },
      {
        ...PINNED_0_2_0_MANIFEST,
        protocol: { ...PINNED_0_2_0_MANIFEST.protocol, version: "0.3.0" },
      },
      {
        ...PINNED_0_2_0_MANIFEST,
        profiles: ["kernel.memory", "kernel.memory"],
      },
      { ...PINNED_0_2_0_MANIFEST, executable: "" },
      { ...PINNED_0_2_0_MANIFEST, mutant: "kernel.accept-stale-head" },
    ]) {
      expect(validateAdapterManifest(manifest)).not.toEqual([]);
    }
  });

  test("passes the validator's contract assertions", () => {
    expect(() => {
      assertAdapterProtocolContracts();
    }).not.toThrow();
  });
});
