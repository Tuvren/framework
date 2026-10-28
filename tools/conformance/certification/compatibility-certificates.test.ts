import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

import { readAdapterManifest } from "../harness/run-plans.ts";
import { readCertificationManifest } from "./certification-manifest.ts";
import { assertCompatibilityCertificates } from "./compatibility-certificates.ts";
import type { CompatibilityCertificate } from "./compatibility-certificates.ts";
import { computeCertificateDigests } from "./provenance.ts";

test("compatibility checking rejects a stale certified row digest", async () => {
  const matrix = JSON.parse(
    await readFile("reports/compatibility/compatibility-matrix.json", "utf8")
  ) as { certificates: CompatibilityCertificate[] };
  const rows = structuredClone(matrix.certificates);
  const fleet = await readCertificationManifest(
    "tools/conformance/certification/certified-projects.json"
  );
  for (const entry of fleet.inventory) {
    if (
      !fleet.certified.some((certified) => certified.project === entry.project)
    ) {
      continue;
    }
    const manifest = await readAdapterManifest(entry.adapter);
    if (
      !rows.some((row) => row.implementationId === manifest.implementationId)
    ) {
      continue;
    }
    const current = await computeCertificateDigests(manifest, entry.adapter);
    for (const row of rows.filter(
      (candidate) => candidate.implementationId === manifest.implementationId
    )) {
      row.digests = current;
    }
  }
  await assertCompatibilityCertificates(rows);
  const row = rows[0];
  if (row === undefined) {
    throw new Error("missing certified row");
  }
  row.digests.adapterManifest = "0".repeat(64);
  await expect(assertCompatibilityCertificates(rows)).rejects.toThrow(
    "adapterManifest"
  );
}, 120_000);
