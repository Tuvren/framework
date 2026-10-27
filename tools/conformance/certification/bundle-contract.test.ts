import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { spawn } from "bun";

import { assertConformanceEvidence } from "../../scripts/lib/conformance-contract.ts";
import { readAdapterManifest, readPlans } from "../harness/run-plans.ts";
import { profileConditionalAssertions } from "../meta-conformance/claim-coverage.ts";
import { finishCertificate } from "./bundle.ts";
import {
  controlOutcomes,
  controlRunId,
  matchesControlRun,
} from "./control-link.ts";
import { readClaimedProfiles } from "./profile.ts";
import { computeCertificateDigests } from "./provenance.ts";
import type { VerifierDigests } from "./provenance.ts";

const root = path.resolve(import.meta.dirname, "../../..");
const adapters = [
  "typescript/kernel/conformance-adapter/adapter.json",
  "rust/kernel-conformance-adapter/adapter.json",
] as const;
const verifierFields = [
  "harness",
  "packet",
  "plans",
  "catalogs",
  "fixtures",
  "profiles",
  "controls",
  "verifierAuthority",
] as const;

const record = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("expected an object");
  }
  return Object.fromEntries(Object.entries(value));
};
const string = (value: unknown): string => {
  if (typeof value !== "string") {
    throw new TypeError("expected a string");
  }
  return value;
};
const run = async (
  args: string[]
): Promise<{ code: number; stdout: string; stderr: string }> => {
  const child = spawn(["bun", ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
};

const checkDesignatedFailures = (report: unknown, manifest: unknown): void => {
  const reports = record(report).reports;
  const controls = record(manifest).controls;
  if (!(Array.isArray(reports) && Array.isArray(controls))) {
    throw new TypeError("missing control results");
  }
  for (const value of reports) {
    const port = record(value);
    const adapter = string(record(port.control).adapter);
    if (!Array.isArray(port.mutants)) {
      throw new TypeError("missing mutant results");
    }
    for (const value of port.mutants) {
      const mutant = record(value);
      if (mutant.outcome !== "killed" || mutant.kind !== "implementation") {
        continue;
      }
      const control = controls
        .map(record)
        .find((entry) => entry.mutantId === mutant.mutantId);
      if (
        control === undefined ||
        !Array.isArray(control.designatedAssertions) ||
        !Array.isArray(mutant.designatedFailures)
      ) {
        throw new TypeError("missing designated assertion evidence");
      }
      expect(mutant.designatedFailures.length).toBeGreaterThan(0);
      if (adapter === adapters[0]) {
        for (const assertion of control.designatedAssertions) {
          expect(mutant.designatedFailures).toContain(assertion);
        }
      }
    }
  }
};

test("real fleet controls certify both complete bundles and reject changed verifier inputs", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "de006-bundle-"));
  try {
    const reportPath = path.join(directory, "controls.json");
    const controls = await run([
      "tools/conformance/meta-conformance/negative-controls.ts",
      "--port",
      "kernel",
      "--report-out",
      reportPath,
    ]);
    expect(controls.code, controls.stderr + controls.stdout).toBe(0);
    const report: unknown = JSON.parse(await readFile(reportPath, "utf8"));
    const controlManifest: unknown = JSON.parse(
      await readFile(
        path.join(root, "spec/conformance/kernel/negative-controls.json"),
        "utf8"
      )
    );
    checkDesignatedFailures(report, controlManifest);
    const controlRun = record(record(report).controlRun);
    expect(controlRun.status).toBe("pass");
    const controlRunIdentifier = string(controlRun.id);
    const controlDigests = record(controlRun.verifierDigests);
    const verifierDigests: VerifierDigests = {
      harness: string(controlDigests.harness),
      packet: string(controlDigests.packet),
      plans: string(controlDigests.plans),
      catalogs: string(controlDigests.catalogs),
      fixtures: string(controlDigests.fixtures),
      profiles: string(controlDigests.profiles),
      controls: string(controlDigests.controls),
      verifierAuthority: string(controlDigests.verifierAuthority),
    };
    const profiles = record(
      JSON.parse(
        await readFile(
          path.join(root, "spec/conformance/kernel/profiles.json"),
          "utf8"
        )
      )
    ).profiles;
    if (!Array.isArray(profiles)) {
      throw new TypeError("missing profiles");
    }
    const profile = profiles
      .map(record)
      .find((entry) => entry.profileId === "kernel.memory");
    if (
      profile === undefined ||
      !Array.isArray(profile.negativeControls) ||
      !Array.isArray(profile.claimIds)
    ) {
      throw new TypeError("missing memory profile obligations");
    }
    const negativeControls = profile.negativeControls.map(string);
    const claims = profile.claimIds.map(string);
    for (const adapter of adapters) {
      const evidencePath = path.join(
        directory,
        `${adapter.startsWith("rust/") ? "rust" : "typescript"}.json`
      );
      const result = await run([
        "tools/conformance/harness/run.ts",
        "--adapter",
        adapter,
        "--control-report",
        reportPath,
        "--require-certified",
        "--concurrency",
        "4",
        "--evidence-out",
        evidencePath,
        "--summary-only",
      ]);
      expect(result.code, result.stderr + result.stdout).toBe(0);
      const evidence: unknown = JSON.parse(
        await readFile(evidencePath, "utf8")
      );
      assertConformanceEvidence(evidence, adapter);
      const bundle = record(evidence);
      const digests = record(bundle.digests);
      expect(bundle.certificate).toEqual({
        complete: true,
        profile: "kernel.memory",
        status: "certified",
      });
      expect(bundle.negativeControlRunId).toBe(controlRunIdentifier);
      if (adapter === adapters[0]) {
        const manifest = await readAdapterManifest(adapter);
        const [claimed] = await readClaimedProfiles(
          manifest,
          manifest.authorityPackets
        );
        if (claimed === undefined) {
          throw new Error("missing claimed profile");
        }
        const options = {
          adapter,
          controlReport: reportPath,
          capabilities: [],
          checks: [],
          packets: [],
          plans: [],
        };
        const before = await computeCertificateDigests(manifest, adapter);
        const plans = await readPlans(manifest, { packets: [], plans: [] });
        const previousPath = process.env.PATH;
        process.env.PATH = "";
        try {
          const complete = await finishCertificate(
            options,
            manifest,
            claimed,
            plans,
            evidence.checkResults,
            evidence.status,
            before
          );
          expect(complete.certificate).toMatchObject({
            complete: true,
            status: "certified",
          });
          const incomplete = await finishCertificate(
            options,
            manifest,
            {
              ...claimed,
              requiredEvidence: [
                ...claimed.requiredEvidence,
                "trace.missing.result",
              ],
            },
            plans,
            evidence.checkResults,
            evidence.status,
            before
          );
          expect(incomplete.certificate).toMatchObject({
            complete: false,
            status: "uncertified",
          });
        } finally {
          if (previousPath === undefined) {
            delete process.env.PATH;
          } else {
            process.env.PATH = previousPath;
          }
        }
      }
      for (const field of verifierFields) {
        expect(digests[field]).toBe(controlDigests[field]);
      }
      expect(record(bundle.environment)).toMatchObject({
        backend: { kind: "memory", version: expect.any(String) },
        fingerprint: expect.any(String),
        toolchains: adapter.startsWith("rust/")
          ? {
              bun: expect.any(String),
              cargo: expect.any(String),
              rustc: expect.any(String),
            }
          : { bun: expect.any(String), typescript: expect.any(String) },
      });
      if (!adapter.startsWith("rust/")) {
        expect(
          record(record(bundle.environment).toolchains)
        ).not.toHaveProperty("cargo");
        expect(
          record(record(bundle.environment).toolchains)
        ).not.toHaveProperty("rustc");
      }
      for (const check of evidence.checkResults) {
        const details = record(check.details);
        expect(Array.isArray(details.schedule)).toBe(true);
        expect(record(details.storageIdentity).kind).toBe("none");
        expect(record(record(details.process).exit)).toHaveProperty("code");
      }
      if (adapter.startsWith("rust/")) {
        expect(digests.implementation).toBe(
          createHash("sha256")
            .update(
              await readFile(
                path.join(
                  root,
                  "target/debug/tuvren-kernel-rust-conformance-adapter"
                )
              )
            )
            .digest("hex")
        );
      }
      const expected = {
        adapter,
        adapterManifest: string(digests.adapterManifest),
        implementation: string(digests.implementation),
        profile: "kernel.memory",
        verifierDigests,
        negativeControls,
        conditionalAssertions: profileConditionalAssertions(
          claims,
          await readPlans(await readAdapterManifest(adapter), {
            packets: [],
            plans: [],
          })
        ),
      };
      expect(matchesControlRun(report, expected)).toBe(controlRunIdentifier);
      expect(
        matchesControlRun(report, {
          ...expected,
          implementation: "0".repeat(64),
        })
      ).toBeUndefined();
      expect(
        matchesControlRun(report, {
          ...expected,
          adapterManifest: "0".repeat(64),
        })
      ).toBeUndefined();
      for (const field of verifierFields) {
        const changed = structuredClone(report);
        const changedDigests = record(
          record(record(changed).controlRun).verifierDigests
        );
        changedDigests[field] = "0".repeat(64);
        const changedRun = record(record(changed).controlRun);
        changedRun.verifierDigests = changedDigests;
        const changedDocument = record(changed);
        changedDocument.controlRun = changedRun;
        expect(matchesControlRun(changedDocument, expected)).toBeUndefined();
      }
      const altered = record(structuredClone(report));
      if (
        !(Array.isArray(altered.reports) && Array.isArray(controlRun.adapters))
      ) {
        throw new TypeError("missing control runs");
      }
      const first = record(altered.reports[0]);
      if (!Array.isArray(first.mutants)) {
        throw new TypeError("missing mutants");
      }
      const mutant = record(first.mutants[0]);
      mutant.outcome = "survived";
      first.mutants = [mutant, ...first.mutants.slice(1)];
      altered.reports[0] = first;
      const alteredRun = record(altered.controlRun);
      alteredRun.outcomes = controlOutcomes(altered.reports);
      alteredRun.id = controlRunId({
        profile: "kernel.memory",
        status: "pass",
        verifierDigests,
        adapters: controlRun.adapters.map((value) => {
          const entry = record(value);
          return {
            adapter: string(entry.adapter),
            adapterManifest: string(entry.adapterManifest),
            implementation: string(entry.implementation),
          };
        }),
        outcomes: controlOutcomes(altered.reports),
      });
      altered.controlRun = alteredRun;
      expect(matchesControlRun(altered, expected)).toBeUndefined();
    }
    const filtered = await run([
      "tools/conformance/harness/run.ts",
      "--adapter",
      adapters[0],
      "--control-report",
      reportPath,
      "--check",
      "kernel.syscall.concurrent_writer.a_first",
      "--summary-only",
    ]);
    expect(filtered.code, filtered.stderr + filtered.stdout).toBe(0);
    expect(record(JSON.parse(filtered.stdout)).certificate).toMatchObject({
      status: "uncertified",
      complete: false,
    });
    const requiredFiltered = await run([
      "tools/conformance/harness/run.ts",
      "--adapter",
      adapters[0],
      "--control-report",
      reportPath,
      "--require-certified",
      "--check",
      "kernel.syscall.concurrent_writer.a_first",
      "--summary-only",
    ]);
    expect(requiredFiltered.code).toBe(1);
    const output = path.join(directory, "comparison");
    const comparison = await run([
      "tools/conformance/meta-conformance/disagreements.ts",
      "--adapter",
      adapters[0],
      "--adapter",
      adapters[1],
      "--capability",
      "kernel.syscall",
      "--output",
      output,
    ]);
    expect(comparison.code, comparison.stderr + comparison.stdout).toBe(0);
    const differences = record(
      JSON.parse(
        await readFile(path.join(output, "disagreements.json"), "utf8")
      )
    );
    expect(differences.counts).toMatchObject({
      disagreement: { differences: 0 },
      coverage: { differences: 0 },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 180_000);
