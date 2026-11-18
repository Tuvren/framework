import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

import { parseOperationCatalog } from "../../plan-compiler/certification-rules.ts";
import { loadConformancePlan } from "../../plan-compiler/index.ts";
import { readAdapterManifest } from "../run-plans.ts";
import { runScheduledChecks } from "../run.ts";

const DATABASE_NAME = /^tuvren_cert_\d+_\d+_[a-f0-9]+$/u;
const exec = promisify(execFile);
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const field = (value: unknown, ...keys: readonly string[]): unknown => {
  let current = value;
  for (const key of keys) {
    if (typeof current !== "object" || current === null) {
      return undefined;
    }
    current = Reflect.get(current, key);
  }
  return current;
};

const expectReleased = async (database: string): Promise<void> => {
  expect(database).toMatch(DATABASE_NAME);
  const { stdout } = await exec("psql", [
    "-XAt",
    "-v",
    "ON_ERROR_STOP=1",
    "-d",
    "postgres",
    "-c",
    `SELECT count(*) FROM pg_database WHERE datname = '${database}'`,
  ]);
  expect(stdout.trim()).toBe("0");
};

test("the provisioned PostgreSQL clock bounds server observations and rejects fixed and shifted clocks", async () => {
  const manifest = await readAdapterManifest(
    "typescript/kernel/conformance-adapter/adapter-postgres.json"
  );
  const plan = await loadConformancePlan(
    "spec/conformance/kernel/plans/kernel-clock-skew-syscall.json"
  );
  plan.catalog = parseOperationCatalog(
    JSON.parse(
      await readFile("spec/conformance/kernel/operations.json", "utf8")
    ),
    "kernel catalog"
  );
  const original = plan.checks[0];
  if (original?.check.steps === undefined) {
    throw new Error("missing clock skew check");
  }

  for (const mode of ["server", "fixed", "shifted", "server"] as const) {
    const adapter =
      mode === "server"
        ? manifest
        : {
            ...manifest,
            executable: process.execPath,
            command: [
              process.execPath,
              "tools/conformance/harness/test/fixtures/server-clock-proxy.ts",
              mode,
              ...manifest.command,
            ],
          };
    const [entry] = await runScheduledChecks(
      adapter,
      [{ plan, compiledCheck: original, index: 0 }],
      1,
      () => "replay",
      true
    );
    const result = entry?.checkResult;
    expect(result?.status, JSON.stringify(result)).toBe(
      mode === "server" ? "pass" : "fail"
    );
    const measurements = result?.details?.serverClockMeasurements;
    const identity = result?.details?.storageIdentity;
    if (
      !Array.isArray(measurements) ||
      measurements.length !== 1 ||
      !record(measurements[0]) ||
      !record(identity) ||
      typeof identity.storageRef !== "string"
    ) {
      throw new Error(
        `missing clock measurement or storage identity: ${JSON.stringify(result)}`
      );
    }
    const measurement = measurements[0];
    expect(measurement.database).toBe(identity.storageRef);
    const observations = result?.details?.traceObservations;
    if (!Array.isArray(observations)) {
      throw new Error("missing trace observations");
    }
    const list = observations.find(
      (entry: unknown) => field(entry, "stepId") === "backendNow"
    );
    expect(measurement.threadId).toBe(
      field(list, "outcome", "value", "result", "threads", "0", "threadId")
    );
    expect(measurement.observedMs).toBe(
      field(list, "outcome", "value", "result", "threads", "0", "createdAtMs")
    );
    const { beforeMs, afterMs, observedMs } = measurement;
    if (
      typeof beforeMs !== "number" ||
      typeof afterMs !== "number" ||
      typeof observedMs !== "number"
    ) {
      throw new Error("invalid clock measurement");
    }
    expect(afterMs).toBeGreaterThanOrEqual(beforeMs);
    if (mode === "server") {
      expect(observedMs).toBeGreaterThanOrEqual(beforeMs);
      expect(observedMs).toBeLessThanOrEqual(afterMs);
    } else {
      expect(result?.failure?.classification).toBe("implementation");
      expect(result?.assertionResults).toContainEqual(
        expect.objectContaining({
          assertionId: `${original.check.checkId}.serverClock`,
          message: expect.stringContaining("outside PostgreSQL interval"),
          status: "fail",
        })
      );
      if (mode === "fixed") {
        expect(observedMs).toBe(10_000);
      } else {
        expect(observedMs - afterMs).toBeGreaterThan(afterMs - beforeMs);
      }
    }
    await expectReleased(identity.storageRef);
  }
}, 120_000);

test("server-clock verification follows a spawned process and refuses an unobserved selection", async () => {
  const manifest = await readAdapterManifest(
    "typescript/kernel/conformance-adapter/adapter-postgres.json"
  );
  const plan = await loadConformancePlan(
    "spec/conformance/kernel/plans/kernel-clock-skew-syscall.json"
  );
  plan.catalog = parseOperationCatalog(
    JSON.parse(
      await readFile("spec/conformance/kernel/operations.json", "utf8")
    ),
    "kernel catalog"
  );
  const original = plan.checks[0];
  if (original?.check.steps === undefined) {
    throw new Error("missing clock skew check");
  }
  const check = structuredClone(original.check);
  if (check.steps === undefined) {
    throw new Error("missing cloned steps");
  }
  for (const step of check.steps) {
    step.process = "second";
  }
  const serverClock = check.steps.find((step) => step.action === "setClock");
  if (serverClock?.arguments === undefined) {
    throw new Error("missing server clock selection");
  }
  serverClock.arguments.source = { $literal: "server" };
  const future = check.steps.findIndex(
    (step) => step.stepId === "threadfuture"
  );
  if (future < 0) {
    throw new Error("missing later thread creation");
  }
  check.steps.splice(future + 1, 0, {
    stepId: "reobserveThreads",
    process: "second",
    operation: "kernel.thread.list",
    arguments: {},
    assertions: [],
  });
  check.steps.unshift(
    {
      stepId: "spawn",
      action: "spawn",
      process: "second",
      operation: "kernel.process.spawn",
      arguments: {},
    },
    {
      stepId: "open",
      action: "openInstance",
      process: "second",
      operation: "kernel.instance.open",
      arguments: {},
    }
  );
  const [multi] = await runScheduledChecks(
    manifest,
    [{ plan, compiledCheck: { ...original, check }, index: 0 }],
    1,
    () => "replay",
    true
  );
  expect(multi?.checkResult.status, JSON.stringify(multi?.checkResult)).toBe(
    "pass"
  );
  expect(multi?.checkResult.details?.serverClockMeasurements).toHaveLength(4);
  expect(multi?.checkResult.details?.processes).toEqual(
    expect.arrayContaining([expect.objectContaining({ name: "second" })])
  );
  const multiStorage = field(
    multi?.checkResult.details,
    "storageIdentity",
    "storageRef"
  );
  if (typeof multiStorage !== "string") {
    throw new Error("missing multi-process storage identity");
  }
  await expectReleased(multiStorage);

  const shifted = {
    ...manifest,
    executable: process.execPath,
    command: [
      process.execPath,
      "tools/conformance/harness/test/fixtures/server-clock-proxy.ts",
      "shifted",
      ...manifest.command,
    ],
  };
  const [wrongProcessClock] = await runScheduledChecks(
    shifted,
    [{ plan, compiledCheck: { ...original, check }, index: 0 }],
    1,
    () => "replay",
    false
  );
  expect(wrongProcessClock?.checkResult).toMatchObject({
    status: "fail",
    failure: { classification: "implementation" },
    assertionResults: expect.arrayContaining([
      expect.objectContaining({
        assertionId: `${check.checkId}.serverClock`,
        message: expect.stringContaining("outside PostgreSQL interval"),
        status: "fail",
      }),
    ]),
  });
  const wrongStorage = wrongProcessClock?.checkResult.failure?.storageRef;
  if (typeof wrongStorage !== "string") {
    throw new Error("missing failed process storage identity");
  }
  await expectReleased(wrongStorage);

  const injected = structuredClone(original.check);
  const injectedClock = injected.steps?.find(
    (step) => step.action === "setClock"
  );
  if (injectedClock === undefined) {
    throw new Error("missing injected clock step");
  }
  injectedClock.arguments = {
    domain: "backend",
    source: "injected",
    nowMs: 10_000,
  };
  const [selfComparison] = await runScheduledChecks(
    manifest,
    [{ plan, compiledCheck: { ...original, check: injected }, index: 0 }],
    1,
    () => "replay",
    false
  );
  expect(
    selfComparison?.checkResult.status,
    JSON.stringify(selfComparison?.checkResult)
  ).toBe("pass");

  const restarted = structuredClone(original.check);
  if (restarted.steps === undefined) {
    throw new Error("missing restarted steps");
  }
  const expired = restarted.steps.findIndex(
    (step) => step.stepId === "threadexpired"
  );
  const backendNow = restarted.steps.findIndex(
    (step) => step.stepId === "backendNow"
  );
  if (expired < 0 || backendNow < 0) {
    throw new Error("missing restart insertion points");
  }
  restarted.steps.splice(expired + 1, 0, {
    stepId: "reopenedThreads",
    operation: "kernel.thread.list",
    arguments: {},
    assertions: [],
  });
  restarted.steps.splice(
    backendNow + 1,
    0,
    {
      stepId: "restart",
      action: "restart",
      operation: "kernel.process.restart",
      arguments: {},
    },
    {
      stepId: "reopen",
      action: "openInstance",
      operation: "kernel.instance.open",
      arguments: {},
    }
  );
  for (const mode of ["server", "reopened-shifted"] as const) {
    const adapter =
      mode === "server"
        ? manifest
        : {
            ...manifest,
            executable: process.execPath,
            command: [
              process.execPath,
              "tools/conformance/harness/test/fixtures/server-clock-proxy.ts",
              mode,
              ...manifest.command,
            ],
          };
    const [entry] = await runScheduledChecks(
      adapter,
      [{ plan, compiledCheck: { ...original, check: restarted }, index: 0 }],
      1,
      () => "replay",
      true
    );
    expect(entry?.checkResult.status, JSON.stringify(entry?.checkResult)).toBe(
      mode === "server" ? "pass" : "fail"
    );
    expect(entry?.checkResult.details?.serverClockMeasurements).toHaveLength(3);
    if (mode !== "server") {
      expect(entry?.checkResult.failure?.classification).toBe("implementation");
      expect(entry?.checkResult.assertionResults).toContainEqual(
        expect.objectContaining({
          assertionId: `${restarted.checkId}.serverClock`,
          message: expect.stringContaining("outside PostgreSQL interval"),
          status: "fail",
        })
      );
    }
    const database = field(
      entry?.checkResult.details,
      "storageIdentity",
      "storageRef"
    );
    if (typeof database !== "string") {
      throw new Error("missing restarted storage identity");
    }
    await expectReleased(database);
  }

  const unverifiedEpoch = structuredClone(restarted);
  unverifiedEpoch.steps = unverifiedEpoch.steps?.filter(
    (step) => step.stepId !== "reopenedThreads"
  );
  const [epochMissing] = await runScheduledChecks(
    manifest,
    [
      {
        plan,
        compiledCheck: { ...original, check: unverifiedEpoch },
        index: 0,
      },
    ],
    1,
    () => "replay",
    false
  );
  expect(epochMissing?.checkResult).toMatchObject({
    status: "fail",
    failure: { classification: "verification" },
    details: {
      verificationError: expect.stringContaining("no timed thread creation"),
    },
  });

  const unobserved = structuredClone(original.check);
  if (unobserved.steps === undefined) {
    throw new Error("missing cloned steps");
  }
  unobserved.steps = unobserved.steps.slice(0, 4);
  unobserved.assertions = [
    {
      kind: "resultField",
      field: "$.trace.threadrenewal.result.threadId",
      equals: "threadrenewal",
    },
  ];
  const [missing] = await runScheduledChecks(
    manifest,
    [
      {
        plan,
        compiledCheck: { ...original, check: unobserved, requiredEvidence: [] },
        index: 0,
      },
    ],
    1,
    () => "replay",
    false
  );
  expect(missing?.checkResult).toMatchObject({
    status: "fail",
    failure: { classification: "verification" },
    details: {
      verificationError: expect.stringContaining("no timed thread creation"),
    },
  });
}, 120_000);
