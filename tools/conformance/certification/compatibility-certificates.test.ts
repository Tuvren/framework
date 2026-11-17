import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import Ajv2020 from "ajv/dist/2020.js";

import { readAdapterManifest } from "../harness/run-plans.ts";
import { readCertificationManifest } from "./certification-manifest.ts";
import { assertCompatibilityCertificates } from "./compatibility-certificates.ts";
import type { CompatibilityCertificate } from "./compatibility-certificates.ts";
import { readClaimedProfiles, readProfileUndetectedClaims } from "./profile.ts";
import { computeSourceCertificateDigests } from "./provenance.ts";

const committedRows = async (): Promise<CompatibilityCertificate[]> => {
  const matrix = JSON.parse(
    await readFile("reports/compatibility/compatibility-matrix.json", "utf8")
  ) as { certificates: CompatibilityCertificate[] };
  return matrix.certificates;
};

const currentRows = async (): Promise<CompatibilityCertificate[]> => {
  const fleet = await readCertificationManifest(
    "tools/conformance/certification/certified-projects.json"
  );
  const rows: CompatibilityCertificate[] = [];
  for (const entry of fleet.inventory) {
    const manifest = await readAdapterManifest(entry.adapter);
    const profiles = (
      await readClaimedProfiles(manifest, manifest.authorityPackets)
    ).filter((profile) =>
      fleet.certified.some(
        (certified) =>
          certified.project === entry.project &&
          certified.profile === profile.profileId
      )
    );
    if (profiles.length === 0) {
      continue;
    }
    let backend: string;
    switch (manifest.storage) {
      case "none":
        backend = "memory";
        break;
      case "sqlite-directory":
        backend = "sqlite";
        break;
      case "postgres-database":
        backend = "postgres";
        break;
      default:
        throw new Error("unknown storage");
    }
    const digests = await computeSourceCertificateDigests(
      manifest,
      entry.adapter
    );
    for (const profile of profiles) {
      rows.push({
        backend,
        digests,
        implementationId: manifest.implementationId,
        profile: profile.profileId,
        status: "certified",
        undetectedClaims: await readProfileUndetectedClaims(
          manifest.authorityPackets,
          profile
        ),
      });
    }
  }
  return rows;
};

test("committed certificate inventory and source digests match this checkout", async () => {
  const rows = await committedRows();
  await assertCompatibilityCertificates(rows);
  await expect(assertCompatibilityCertificates(rows.slice(1))).rejects.toThrow(
    "inventory"
  );
  await expect(
    assertCompatibilityCertificates([...rows, ...rows])
  ).rejects.toThrow("inventory");
});

test("rejects a stale source digest", async () => {
  const rows = await committedRows();
  const row = rows[0];
  if (row === undefined) {
    throw new Error("missing certified row");
  }
  row.digests.adapterManifest =
    row.digests.adapterManifest === "0".repeat(64)
      ? "1".repeat(64)
      : "0".repeat(64);
  await expect(assertCompatibilityCertificates(rows)).rejects.toThrow(
    "stale certificate digest adapterManifest"
  );
});

test("freshness rejects a changed verifier-authority digest", async () => {
  const fleet = await readCertificationManifest(
    "tools/conformance/certification/certified-projects.json"
  );
  const adapters = await Promise.all(
    fleet.inventory.map(async ({ adapter }) => ({
      adapter,
      manifest: await readAdapterManifest(adapter),
    }))
  );
  const storageByBackend: Record<string, string> = {
    memory: "none",
    sqlite: "sqlite-directory",
    postgres: "postgres-database",
  };
  const rows = await Promise.all(
    (await committedRows()).map(async (row) => {
      const entry = adapters.find(
        ({ manifest }) =>
          manifest.implementationId === row.implementationId &&
          manifest.storage === storageByBackend[row.backend]
      );
      if (entry === undefined) {
        throw new Error(
          `missing adapter for ${row.implementationId} ${row.backend}`
        );
      }
      return {
        ...row,
        digests: await computeSourceCertificateDigests(
          entry.manifest,
          entry.adapter
        ),
      };
    })
  );
  await assertCompatibilityCertificates(rows);
  const first = rows[0];
  if (first === undefined) {
    throw new Error("missing certified row");
  }
  first.digests.verifierAuthority =
    first.digests.verifierAuthority === "0".repeat(64)
      ? "1".repeat(64)
      : "0".repeat(64);
  await expect(assertCompatibilityCertificates(rows)).rejects.toThrow(
    "stale certificate digest verifierAuthority"
  );
});

test("rejects a machine-bound harness digest", async () => {
  const rows = (await committedRows()).map((row) => ({
    ...row,
    digests: { ...row.digests, harness: "a".repeat(64) },
  }));
  await expect(assertCompatibilityCertificates(rows)).rejects.toThrow(
    "machine-bound field"
  );
});

test("matrix schema requires closed entries for every certificate row", async () => {
  const schema: unknown = JSON.parse(
    await readFile(
      "reports/compatibility/compatibility-matrix.schema.json",
      "utf8"
    )
  );
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
    throw new Error("invalid matrix schema");
  }
  const validate = new Ajv2020({ strict: false }).compile(schema);
  const rows = await currentRows();
  const matrix = (certificates: unknown[]) => ({
    generatedAtMs: 0,
    sourceRevision: "test",
    suites: [],
    implementations: [],
    interop: [],
    certificates,
  });
  expect(validate(matrix(rows))).toBe(true);
  const first = rows[0];
  if (first === undefined) {
    throw new Error("missing row");
  }
  const omitted = { ...first };
  Reflect.deleteProperty(omitted, "undetectedClaims");
  for (const invalid of [
    omitted,
    { ...first, extra: true },
    { ...first, undetectedClaims: [{ claimId: "claim", reason: " " }] },
    {
      ...first,
      undetectedClaims: [{ claimId: "claim", reason: "gap", extra: true }],
    },
  ]) {
    expect(validate(matrix([invalid]))).toBe(false);
  }
});

test("matrix validation rejects omitted, altered, unrelated, and duplicate profile gaps", async () => {
  const rows = await currentRows();
  await assertCompatibilityCertificates(rows);
  const memory = rows.find(
    (row) => row.profile === "kernel.memory" && row.undetectedClaims.length > 0
  );
  const durable = rows.find((row) => row.profile === "kernel.process-crash");
  const first = memory?.undetectedClaims[0];
  if (memory === undefined || durable === undefined || first === undefined) {
    throw new Error("missing memory or durable certificate");
  }
  const invalidMemory = [
    [],
    memory.undetectedClaims.slice(1),
    [{ ...first, reason: "altered" }, ...memory.undetectedClaims.slice(1)],
    [...memory.undetectedClaims, { claimId: "unrelated", reason: "gap" }],
    [...memory.undetectedClaims, { ...first, reason: "different" }],
  ];
  for (const claims of invalidMemory) {
    await expect(
      assertCompatibilityCertificates(
        rows.map((row) =>
          row === memory ? { ...row, undetectedClaims: claims } : row
        )
      )
    ).rejects.toThrow("undetectedClaims");
  }
  await expect(
    assertCompatibilityCertificates(
      rows.map((row) =>
        row === durable
          ? {
              ...row,
              undetectedClaims: [{ claimId: "unrelated", reason: "gap" }],
            }
          : row
      )
    )
  ).rejects.toThrow("undetectedClaims");
  const omitted = { ...memory };
  Reflect.deleteProperty(omitted, "undetectedClaims");
  await expect(
    assertCompatibilityCertificates(
      rows.map((row) => (row === memory ? omitted : row))
    )
  ).rejects.toThrow("undetectedClaims");
});

test("source digest recomputation observes changed manifest bytes", async () => {
  const adapter = "typescript/kernel/conformance-adapter/adapter.json";
  const manifest = await readAdapterManifest(adapter);
  const rows = await committedRows();
  const row = rows.find(
    (entry) => entry.implementationId === manifest.implementationId
  );
  if (row === undefined) {
    throw new Error("missing certified row");
  }
  const directory = await mkdtemp(
    path.join(tmpdir(), "certificate-source-test-")
  );
  try {
    const copy = path.join(directory, "adapter.json");
    const source = await readFile(adapter, "utf8");
    await writeFile(copy, source);
    expect(
      (await computeSourceCertificateDigests(manifest, copy)).adapterManifest
    ).toBe(row.digests.adapterManifest);
    await writeFile(copy, `${source}\n`);
    expect(
      (await computeSourceCertificateDigests(manifest, copy)).adapterManifest
    ).not.toBe(row.digests.adapterManifest);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("committed rows contain only source-bound fields", async () => {
  for (const row of await committedRows()) {
    expect(Object.keys(row).toSorted()).toEqual([
      "backend",
      "digests",
      "implementationId",
      "profile",
      "status",
      "undetectedClaims",
    ]);
    expect(Object.keys(row.digests).toSorted()).toEqual([
      "adapterManifest",
      "catalogs",
      "controls",
      "fixtures",
      "packet",
      "plans",
      "profiles",
      "verifierAuthority",
    ]);
  }
});
