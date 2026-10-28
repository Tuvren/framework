import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { spawn } from "bun";

import { assertConformanceEvidence } from "../../scripts/lib/conformance-contract.ts";

const root = path.resolve(import.meta.dirname, "../../..");
const sqlite = "typescript/kernel/conformance-adapter/adapter-sqlite.json";
const postgres = "typescript/kernel/conformance-adapter/adapter-postgres.json";

const object = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("expected an object");
  }
  return Object.fromEntries(Object.entries(value));
};

const run = async (args: string[]) => {
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

test("a control report requires an explicit bundle destination", async () => {
  const result = await run([
    "tools/conformance/harness/run.ts",
    "--adapter",
    sqlite,
    "--control-report",
    "missing-report.json",
  ]);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("--control-report requires --evidence-out");
});

test("a SQLite adapter cannot claim the shared-backend profile without its server clock", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "df005-shared-profile-"));
  try {
    const manifest = object(JSON.parse(await readFile(sqlite, "utf8")));
    if (!Array.isArray(manifest.profiles)) {
      throw new TypeError("missing profiles");
    }
    manifest.profiles.push("kernel.shared-backend");
    const adapter = path.join(directory, "adapter.json");
    const evidence = path.join(directory, "evidence.json");
    await writeFile(adapter, JSON.stringify(manifest));
    const result = await run([
      "tools/conformance/harness/run.ts",
      "--adapter",
      adapter,
      "--evidence-out",
      evidence,
      "--summary-only",
    ]);
    expect(result.code).toBe(1);
    const bundle = object(JSON.parse(await readFile(evidence, "utf8")));
    expect(bundle.status).toBe("fail");
    expect(bundle.checkResults).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId:
            "profile.kernel.shared-backend.capability.clock.backend-server",
          status: "fail",
        }),
      ])
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);

test("compatibility records each certified backend and profile separately", async () => {
  const matrix = object(
    JSON.parse(
      await readFile("reports/compatibility/compatibility-matrix.json", "utf8")
    )
  );
  expect(matrix.certificates).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        implementationId: "typescript-kernel-sqlite",
        backend: "sqlite",
        profile: "kernel.persistent-reopen",
        status: "certified",
      }),
      expect.objectContaining({
        implementationId: "typescript-kernel-sqlite",
        backend: "sqlite",
        profile: "kernel.process-crash",
        status: "certified",
      }),
      expect.objectContaining({
        implementationId: "typescript-kernel-postgres",
        backend: "postgres",
        profile: "kernel.persistent-reopen",
        status: "certified",
      }),
      expect.objectContaining({
        implementationId: "typescript-kernel-postgres",
        backend: "postgres",
        profile: "kernel.process-crash",
        status: "certified",
      }),
      expect.objectContaining({
        implementationId: "typescript-kernel-postgres",
        backend: "postgres",
        profile: "kernel.shared-backend",
        status: "certified",
      }),
    ])
  );
  if (!Array.isArray(matrix.certificates)) {
    throw new TypeError("missing compatibility certificate rows");
  }
  expect(matrix.certificates.map(object)).not.toContainEqual(
    expect.objectContaining({
      implementationId: "typescript-kernel-sqlite",
      backend: "sqlite",
      profile: "kernel.shared-backend",
    })
  );
});

test("a durable claim fails when a required check is non-applicable", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "df005-profile-"));
  try {
    const manifest = object(JSON.parse(await readFile(sqlite, "utf8")));
    if (
      !(Array.isArray(manifest.capabilities) && Array.isArray(manifest.command))
    ) {
      throw new TypeError("invalid sqlite adapter manifest");
    }
    const missing = "kernel.persistence.durable";
    manifest.capabilities = manifest.capabilities.filter(
      (value) => value !== missing
    );
    const index = manifest.command.indexOf(missing);
    if (index < 1 || manifest.command[index - 1] !== "--capability") {
      throw new Error("missing durable capability argument");
    }
    manifest.command.splice(index - 1, 2);
    const adapter = path.join(directory, "adapter.json");
    const evidence = path.join(directory, "evidence.json");
    await writeFile(adapter, JSON.stringify(manifest));
    const result = await run([
      "tools/conformance/harness/run.ts",
      "--adapter",
      adapter,
      "--evidence-out",
      evidence,
      "--summary-only",
    ]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      "claimed profile kernel.persistent-reopen requires check kernel.syscall.reopen.close_reopen_checkpoint"
    );
    const bundle = object(JSON.parse(await readFile(evidence, "utf8")));
    expect(bundle.status).toBe("fail");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);

test("durable disagreement capture follows reopened and crashed processes", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "df005-disagreements-"));
  try {
    const result = await run([
      "tools/conformance/meta-conformance/disagreements.ts",
      "--adapter",
      sqlite,
      "--adapter",
      postgres,
      "--plan",
      "spec/conformance/kernel/plans/kernel-close-reopen-syscall.json",
      "--plan",
      "spec/conformance/kernel/plans/kernel-crash-recovery-durable-syscall.json",
      "--output",
      directory,
    ]);
    expect(result.code, result.stderr + result.stdout).toBe(0);
    const report = object(
      JSON.parse(
        await readFile(path.join(directory, "disagreements.json"), "utf8")
      )
    );
    const implementations = report.implementations;
    expect(implementations).toHaveLength(2);
    if (!Array.isArray(implementations)) {
      throw new TypeError("missing comparison implementations");
    }
    for (const implementation of implementations) {
      expect(object(implementation).summary).toMatchObject({
        applicableChecks: 5,
        failedChecks: 0,
      });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);

test("durable certificates share a run and link to matching profile control gates", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "df005-certificates-"));
  try {
    const reportPath = path.join(directory, "controls.json");
    const controls = await run([
      "tools/conformance/meta-conformance/negative-controls.ts",
      "--port",
      "kernel",
      "--profile",
      "kernel.persistent-reopen",
      "--profile",
      "kernel.process-crash",
      "--profile",
      "kernel.shared-backend",
      "--report-out",
      reportPath,
    ]);
    expect(controls.code, controls.stderr + controls.stdout).toBe(0);
    const report = object(JSON.parse(await readFile(reportPath, "utf8")));
    const controlRuns = report.controlRuns;
    if (!Array.isArray(controlRuns)) {
      throw new TypeError("missing per-profile control runs");
    }
    for (const [backend, adapter, profiles] of [
      ["sqlite", sqlite, ["kernel.persistent-reopen", "kernel.process-crash"]],
      [
        "postgres",
        postgres,
        [
          "kernel.persistent-reopen",
          "kernel.process-crash",
          "kernel.shared-backend",
        ],
      ],
    ] as const) {
      const output = path.join(directory, backend);
      await mkdir(output);
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
        path.join(output, "run.json"),
        "--summary-only",
      ]);
      expect(result.code, result.stderr + result.stdout).toBe(0);
      const bundles = await Promise.all(
        profiles.map(async (profile) => {
          const value: unknown = JSON.parse(
            await readFile(
              path.join(output, "certificates", `${profile}.json`),
              "utf8"
            )
          );
          assertConformanceEvidence(value, `${backend} ${profile}`);
          const bundle = object(value);
          expect(bundle.certificate).toEqual({
            profile,
            status: "certified",
            complete: true,
          });
          expect(typeof bundle.runId).toBe("string");
          const control = controlRuns.find(
            (entry: unknown) => object(entry).profile === profile
          );
          const controlRun = object(control);
          expect(controlRun.status).toBe("pass");
          expect(bundle.negativeControlRunId).toBe(controlRun.id);
          const verifier = object(controlRun.verifierDigests);
          const digests = object(bundle.digests);
          for (const field of [
            "harness",
            "packet",
            "plans",
            "catalogs",
            "fixtures",
            "profiles",
            "controls",
            "verifierAuthority",
          ]) {
            expect(digests[field]).toBe(verifier[field]);
          }
          if (!Array.isArray(bundle.selection)) {
            throw new TypeError("missing profile selection");
          }
          const outside =
            profile === "kernel.persistent-reopen"
              ? "kernel.syscall.process-crash.before_commit"
              : "kernel.syscall.reopen.close_reopen_checkpoint";
          expect(bundle.selection).toContainEqual({
            checkId: outside,
            selected: false,
            reason: "outside-profile",
          });
          const outsideCount = bundle.selection.filter(
            (entry: unknown) => object(entry).reason === "outside-profile"
          ).length;
          expect(object(bundle.summary).outsideProfileChecks).toBe(
            outsideCount
          );
          expect(outsideCount).toBeGreaterThan(0);
          const nonApplicable = bundle.nonApplicableCheckIds;
          if (!Array.isArray(nonApplicable)) {
            throw new TypeError("missing non-applicable checks");
          }
          expect(nonApplicable).not.toContain(outside);
          return bundle;
        })
      );
      for (const bundle of bundles.slice(1)) {
        expect(bundle.runId).toBe(bundles[0]?.runId);
        expect(bundle.digests).toEqual(bundles[0]?.digests);
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 600_000);
