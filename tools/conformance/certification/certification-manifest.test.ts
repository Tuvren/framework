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
import nodePath from "node:path";

import {
  CERTIFICATION_MANIFEST_PATH,
  findCertifiedEntriesForAdapter,
  isMutantAdapterCommand,
  parseCertificationManifest,
  readCertificationManifest,
} from "./certification-manifest.ts";

const ROOT = nodePath.resolve(import.meta.dirname, "../../..");

const PREVIOUSLY_CERTIFIED = [
  [
    "framework-batteries-included-certification",
    "tuvren.framework.runtime-api.batteries-included",
  ],
  ["framework-typescript-certification", "tuvren.framework.promoted-authority"],
  ["kernel-dart-certification", "tuvren.kernel.protocol"],
  ["kernel-go-certification", "tuvren.kernel.protocol"],
  ["kernel-python-certification", "tuvren.kernel.protocol"],
  ["kernel-rust-certification", "kernel.memory"],
  ["kernel-typescript-certification", "kernel.memory"],
  ["kernel-typescript-postgres-certification", "kernel.persistent-reopen"],
  ["kernel-typescript-postgres-certification", "kernel.process-crash"],
  ["kernel-typescript-postgres-certification", "kernel.shared-backend"],
  ["kernel-typescript-sqlite-certification", "kernel.persistent-reopen"],
  ["kernel-typescript-sqlite-certification", "kernel.process-crash"],
  ["providers-typescript-certification", "tuvren.providers.provider-api"],
] as const;

const validManifest = {
  certified: [{ profile: "suite.a", project: "runner-a" }],
  inventory: [
    { adapter: "a/adapter.json", project: "runner-a", state: "pass" },
    { adapter: "b/adapter.json", project: "runner-b", state: "unsupported" },
  ],
  projects: ["runner-a", "runner-b"],
};

describe("checked-in certification manifest", () => {
  test("keeps the Rust framework in the inventory as unsupported and out of the certified list", async () => {
    const manifest = await readCertificationManifest(
      nodePath.join(ROOT, CERTIFICATION_MANIFEST_PATH)
    );

    expect(
      manifest.inventory.find(
        (entry) => entry.project === "framework-rust-certification"
      )
    ).toMatchObject({ state: "unsupported" });
    expect(manifest.certified.map((entry) => entry.project)).not.toContain(
      "framework-rust-certification"
    );
  });

  test("every previously certified project keeps a pass state and stays certified", async () => {
    const manifest = await readCertificationManifest(
      nodePath.join(ROOT, CERTIFICATION_MANIFEST_PATH)
    );
    for (const [project, profile] of PREVIOUSLY_CERTIFIED) {
      expect(
        manifest.inventory.find((entry) => entry.project === project)?.state
      ).toBe("pass");
      expect(manifest.certified).toContainEqual({ project, profile });
    }
  });

  test("each inventory state matches the checked-in compatibility evidence", async () => {
    const manifest = await readCertificationManifest(
      nodePath.join(ROOT, CERTIFICATION_MANIFEST_PATH)
    );

    const states = await Promise.all(
      manifest.inventory.map(async (entry) => {
        const evidence: unknown = JSON.parse(
          await readFile(
            nodePath.join(
              ROOT,
              `reports/compatibility/evidence/certification-harness.${entry.project}.json`
            ),
            "utf-8"
          )
        );
        return [
          entry.state,
          typeof evidence === "object" &&
          evidence !== null &&
          "status" in evidence
            ? evidence.status
            : undefined,
        ];
      })
    );

    for (const [declared, recorded] of states) {
      expect(declared).toBe(recorded);
    }
  });
});

describe("certification manifest contract", () => {
  test("accepts an inventory with a certified pass project", () => {
    expect(parseCertificationManifest(validManifest).certified).toEqual(
      validManifest.certified
    );
  });

  test.each([
    [
      "a certified project whose state is not pass",
      {
        ...validManifest,
        certified: [{ profile: "suite.b", project: "runner-b" }],
      },
      "runner-b",
    ],
    [
      "a certified project missing from the inventory",
      {
        ...validManifest,
        certified: [{ profile: "suite.c", project: "runner-c" }],
      },
      "runner-c",
    ],
    [
      "an inventory that diverges from the discovery projects",
      { ...validManifest, projects: ["runner-a"] },
      "runner-b",
    ],
    [
      "an unknown inventory state",
      {
        ...validManifest,
        inventory: [
          { adapter: "a/adapter.json", project: "runner-a", state: "green" },
          validManifest.inventory[1],
        ],
      },
      "state",
    ],
    [
      "a duplicate certified pair",
      {
        ...validManifest,
        certified: [validManifest.certified[0], validManifest.certified[0]],
      },
      "duplicate",
    ],
  ])("rejects %s", (_label, manifest, message) => {
    expect(() => parseCertificationManifest(manifest)).toThrow(message);
  });

  test("finds certified entries by resolved adapter path", () => {
    const manifest = parseCertificationManifest(validManifest);

    expect(
      findCertifiedEntriesForAdapter(
        manifest,
        nodePath.join(ROOT, "a/adapter.json"),
        ROOT
      )
    ).toEqual(validManifest.certified);
    expect(
      findCertifiedEntriesForAdapter(
        manifest,
        nodePath.join(ROOT, "b/adapter.json"),
        ROOT
      )
    ).toEqual([]);
  });
});

describe("mutant adapter manifests", () => {
  test.each([
    [["bun", "host.ts", "--mutant", "kernel.example"], true],
    [["bun", "host.ts", "--mutant-from-env"], true],
    [["bun", "host.ts", "--backend", "memory"], false],
    [["bun", "host.ts", "--adapter-id", "--mutant-like"], false],
  ])("classifies %j as mutant=%p", (command, expected) => {
    expect(isMutantAdapterCommand(command)).toBe(expected);
  });

  test("no inventory adapter manifest launches a mutant", async () => {
    const manifest = await readCertificationManifest(
      nodePath.join(ROOT, CERTIFICATION_MANIFEST_PATH)
    );

    const mutantAdapters = await Promise.all(
      manifest.inventory.map(async (entry) => {
        const adapter: unknown = JSON.parse(
          await readFile(nodePath.join(ROOT, entry.adapter), "utf-8")
        );
        const command =
          typeof adapter === "object" &&
          adapter !== null &&
          "command" in adapter &&
          Array.isArray(adapter.command)
            ? adapter.command.map(String)
            : [];
        return isMutantAdapterCommand(command) ? [entry.adapter] : [];
      })
    );

    expect(mutantAdapters.flat()).toEqual([]);
  });
});
