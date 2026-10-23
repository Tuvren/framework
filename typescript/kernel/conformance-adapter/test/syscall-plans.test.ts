import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { JsonRpcAdapterClient } from "../../../../tools/conformance/harness/adapter-client.ts";
import { JsonRpcAdapterError } from "../../../../tools/conformance/harness/adapter-error.ts";
import {
  assertCertificationEnforcement,
  assessConformancePlans,
  loadCertificationAuthority,
} from "../../../../tools/conformance/plan-compiler/certification-assessment.ts";
import { loadConformancePlan } from "../../../../tools/conformance/plan-compiler/index.ts";
import * as hostSupport from "../src/host-support.ts";

const plans = ["core", "extended"].map(
  (name) => `spec/conformance/kernel/plans/kernel-protocol-${name}-syscall.json`
);

test("syscall protocol plans enforce certification with explicit trace projections", async () => {
  const assessments = await assessConformancePlans(
    plans,
    await loadCertificationAuthority(["spec/kernel/authority-packet.json"])
  );
  expect(assessments.map((assessment) => assessment.mode)).toEqual([
    "enforcing",
    "enforcing",
  ]);
  expect(assessments.flatMap((assessment) => assessment.violations)).toEqual(
    []
  );
  const compiledPlans = await Promise.all(plans.map(loadConformancePlan));
  for (const { plan } of compiledPlans) {
    expect(plan.applicability.capabilities).toContain("kernel.syscall");
    for (const check of plan.checks) {
      expect(check.steps?.length).toBeGreaterThan(0);
      for (const step of check.steps ?? []) {
        expect(step.arguments).toBeDefined();
        expect(step.capture).toBeDefined();
        expect(step.claimIds?.length).toBeGreaterThan(0);
      }
    }
  }
});

test("syscall bindings preserve native bytes, null, error codes, and instance isolation", async () => {
  const { createSyscallBindings } = await import("../src/host-syscalls.ts");
  const bridge = createSyscallBindings({
    adapterId: "syscall-test",
    backend: "memory",
    capabilities: ["kernel.syscall"],
  });
  const first = await bridge.createInstance();
  const second = await bridge.createInstance();
  try {
    const bytes = { $bytes: "00ff80" };
    const put = await bridge.dispatch(
      "kernel.store.put",
      { blob: bytes },
      first
    );
    expect(put.kind).toBe("result");
    if (
      put.kind !== "result" ||
      typeof put.value !== "object" ||
      put.value === null ||
      !("result" in put.value)
    ) {
      throw new Error("missing store result");
    }
    const hash = put.value.result;
    expect(await bridge.dispatch("kernel.store.get", { hash }, first)).toEqual({
      kind: "result",
      value: { result: bytes },
    });
    expect(await bridge.dispatch("kernel.store.get", { hash }, second)).toEqual(
      { kind: "result", value: { result: null } }
    );
    const malformed = await Promise.allSettled([
      bridge.dispatch(
        "kernel.store.put",
        { blob: { $bytes: "00", extra: true } },
        first
      ),
      bridge.dispatch(
        "kernel.store.put",
        {
          blob: {
            $map: [
              ["x", 1],
              ["x", 2],
            ],
          },
        },
        first
      ),
    ]);
    expect(malformed.map((entry) => entry.status)).toEqual([
      "rejected",
      "rejected",
    ]);
    for (const entry of malformed) {
      if (entry.status === "rejected") {
        const reason: unknown = entry.reason;
        expect(reason).toBeInstanceOf(TypeError);
      }
    }
    const rejected = await bridge.dispatch(
      "kernel.schema.register",
      {
        schema: {
          incorporationRules: [],
          paths: [
            { collection: "single", path: "a" },
            { collection: "single", path: "a" },
          ],
          schemaId: "duplicate",
        },
      },
      first
    );
    expect(rejected.kind).toBe("error");
    if (rejected.kind === "error") {
      expect(rejected.error.code).toBe("duplicate_schema_path");
      expect(rejected.error.details).toEqual({ path: "a" });
    }
  } finally {
    await bridge.destroyInstance(first);
    await bridge.destroyInstance(second);
  }
});

test.each(["explicit", "capability", "arguments"])(
  "enforces a violating syscall trace through %s",
  async (mode) => {
    const authority = await loadCertificationAuthority([
      "spec/kernel/authority-packet.json",
    ]);
    const compiled = await loadConformancePlan(plans[0] ?? "");
    const check = compiled.plan.checks.find(
      (entry) => entry.checkId === "kernel.syscall.protocol.modify_composition"
    );
    if (check === undefined) {
      throw new Error("missing composition check");
    }
    const changed = structuredClone(check);
    if (mode !== "arguments") {
      changed.steps = changed.steps?.map(
        ({ arguments: _arguments, ...step }) => step
      );
    }
    changed.assertions = [
      {
        equals: true,
        field: "$.trace.compose.result.undeclared",
        kind: "resultField",
      },
    ];
    const directory = await mkdtemp(path.join(tmpdir(), "db004-enforcement-"));
    const file = path.join(directory, "plan.json");
    try {
      const { certificationRules, ...implicitPlan } = compiled.plan;
      const plan = {
        ...implicitPlan,
        ...(mode === "explicit" ? { certificationRules } : {}),
        applicability: {
          capabilities: [
            mode === "capability" ? "kernel.syscall" : "kernel.protocol",
          ],
        },
        checks: [changed],
        fixtures: {},
      };
      await writeFile(file, JSON.stringify(plan));
      const assessments = await assessConformancePlans([file], authority);
      expect(assessments[0]?.mode).toBe("enforcing");
      expect(
        assessments[0]?.violations.map((violation) => violation.rule)
      ).toContain("observation-path");
      expect(
        assessments[0]?.violations.map((violation) => violation.rule)
      ).toContain("literal-boolean");
      expect(() => {
        assertCertificationEnforcement(assessments);
      }).toThrow();
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }
);

test("adapter argument validation throws instead of returning a native error", async () => {
  const { createSyscallBindings } = await import("../src/host-syscalls.ts");
  const bridge = createSyscallBindings({
    adapterId: "validation-test",
    backend: "memory",
    capabilities: ["kernel.syscall"],
  });
  const handle = await bridge.createInstance();
  try {
    const [outcome] = await Promise.allSettled([
      bridge.dispatch("kernel.node.walkBack", { fromHash: 42 }, handle),
    ]);
    expect(outcome?.status).toBe("rejected");
    if (outcome?.status === "rejected") {
      expect(outcome.reason).toBeInstanceOf(TypeError);
    }
  } finally {
    await bridge.destroyInstance(handle);
  }
});

test.each(["lossless", "unsafe integer", "cyclic cause"])(
  "native errors cross the bridge with %s encoding",
  async (mode) => {
    const { createSyscallBindings } = await import("../src/host-syscalls.ts");
    const cause = Object.assign(new Error("native cause"), {
      code: "cause_code",
      details: { bytes: Uint8Array.of(255), count: 42n },
    });
    const error = Object.assign(new Error("native failure", { cause }), {
      code: "native_code",
      details: {
        bytes: Uint8Array.of(0, 128),
        count:
          mode === "unsafe integer"
            ? 9_007_199_254_740_993n
            : 9_007_199_254_740_991n,
      },
    });
    if (mode === "cyclic cause") {
      cause.cause = error;
    }
    const original = hostSupport.createConformanceRuntimeKernel;
    const factory = spyOn(
      hostSupport,
      "createConformanceRuntimeKernel"
    ).mockImplementation((config, options) => {
      const kernel = original(config, options);
      spyOn(kernel.store, "put").mockRejectedValue(error);
      return kernel;
    });
    const bridge = createSyscallBindings({
      adapterId: "native-error-test",
      backend: "memory",
      capabilities: ["kernel.syscall"],
    });
    const handle = await bridge.createInstance();
    try {
      const dispatched = bridge.dispatch(
        "kernel.store.put",
        { blob: { $bytes: "00" } },
        handle
      );
      if (mode === "lossless") {
        const outcome = await dispatched;
        const serialized = JSON.stringify(outcome);
        const decoded: unknown = JSON.parse(serialized);
        expect(decoded).toEqual({
          error: {
            cause: {
              code: "cause_code",
              details: { bytes: { $bytes: "ff" }, count: 42 },
              message: "native cause",
            },
            code: "native_code",
            details: {
              bytes: { $bytes: "0080" },
              count: 9_007_199_254_740_991,
            },
            message: "native failure",
          },
          kind: "error",
        });
      } else {
        const [outcome] = await Promise.allSettled([dispatched]);
        expect(outcome?.status).toBe("rejected");
        if (outcome?.status === "rejected") {
          const reason: unknown = outcome.reason;
          expect(reason).toBeInstanceOf(TypeError);
          if (reason instanceof Error) {
            expect(reason.message).toContain(
              mode === "cyclic cause"
                ? "cyclic native error cause"
                : "safe-integer"
            );
          }
        }
      }
    } finally {
      factory.mockRestore();
      await bridge.destroyInstance(handle);
    }
  }
);

test("invalid syscall arguments become JSON-RPC adapter_host_error", async () => {
  const client = new JsonRpcAdapterClient({
    command: ["bun", "typescript/kernel/conformance-adapter/src/host.ts"],
    cwd: path.resolve(import.meta.dirname, "../../../.."),
  });
  try {
    await client.initialize("tuvren.kernel.protocol", "0.1.0");
    const handle = await client.createInstance({});
    try {
      let failure: unknown;
      try {
        await client.dispatch(
          "kernel.node.walkBack",
          { fromHash: 42 },
          {},
          handle
        );
      } catch (error: unknown) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(JsonRpcAdapterError);
      if (failure instanceof JsonRpcAdapterError) {
        expect(failure.envelope.code).toBe("adapter_host_error");
      }
    } finally {
      await client.destroyInstance(handle);
    }
  } finally {
    await client.shutdown();
  }
});

test("successful native results with invalid encoding throw adapter errors", async () => {
  const { createSyscallBindings } = await import("../src/host-syscalls.ts");
  const original = hostSupport.createConformanceRuntimeKernel;
  const factory = spyOn(
    hostSupport,
    "createConformanceRuntimeKernel"
  ).mockImplementation((config, options) => {
    const kernel = original(config, options);
    spyOn(kernel.schema, "get").mockResolvedValue({
      incorporationRules: [],
      paths: [
        {
          collection: "single",
          metadata: { invalid: Number.NaN },
          path: "value",
        },
      ],
      schemaId: "invalid",
    });
    return kernel;
  });
  const bridge = createSyscallBindings({
    adapterId: "encoding-test",
    backend: "memory",
    capabilities: ["kernel.syscall"],
  });
  const handle = await bridge.createInstance();
  try {
    const [outcome] = await Promise.allSettled([
      bridge.dispatch("kernel.schema.get", { schemaId: "invalid" }, handle),
    ]);
    expect(outcome?.status).toBe("rejected");
    if (outcome?.status === "rejected") {
      expect(outcome.reason).toBeInstanceOf(TypeError);
    }
  } finally {
    factory.mockRestore();
    await bridge.destroyInstance(handle);
  }
});
