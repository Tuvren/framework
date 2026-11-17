import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { readAdapterManifest } from "../harness/run-plans.ts";
import { readCertificationManifest } from "./certification-manifest.ts";
import { assertCompatibilityCertificates } from "./compatibility-certificates.ts";
import type { CompatibilityCertificate } from "./compatibility-certificates.ts";
import { computeSourceCertificateDigests } from "./provenance.ts";

const committedRows = async (): Promise<CompatibilityCertificate[]> => {
  const matrix = JSON.parse(
    await readFile("reports/compatibility/compatibility-matrix.json", "utf8")
  ) as { certificates: CompatibilityCertificate[] };
  return matrix.certificates;
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
