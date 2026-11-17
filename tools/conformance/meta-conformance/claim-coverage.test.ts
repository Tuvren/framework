import { expect, test } from "bun:test";

import "../certification/control-link.test.ts";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  readClaimedProfiles,
  readProfileAuthority,
  readUndetectedRegister,
  readUndetectedRegisterReferences,
} from "../certification/profile.ts";
import { readAdapterManifest, readPlans } from "../harness/run-plans.ts";
import {
  assertClaimCoverage,
  assertConditionalBranchCoverage,
  assertNegativeControlGate,
  claimAssertions,
  profileConditionalAssertions,
} from "./claim-coverage.ts";
import type { CoverageControl } from "./claim-coverage.ts";
import { NEGATIVE_CONTROL_PORTS } from "./negative-control-config.ts";
import { checkFleetGate } from "./negative-controls.ts";
import type { NegativeControlReport } from "./negative-controls.ts";

test("requires each profile claim to have a designated detector or a recorded reason", () => {
  const controls = [
    {
      claimIds: ["claim.detected"],
      designatedAssertions: ["check.1.resultField"],
      kind: "implementation",
      mutantId: "mutant.a",
      profiles: ["example.profile"],
    },
  ];
  const claims = ["claim.detected", "claim.undetected"];
  const checks = [
    {
      assertions: [
        { assertionId: "check.1.resultField", claimIds: ["claim.detected"] },
      ],
    },
    {
      assertions: [
        {
          assertionId: "uncovered.1.resultField",
          claimIds: ["claim.undetected"],
        },
      ],
    },
  ];
  expect(() =>
    assertClaimCoverage("example.profile", claims, controls, {}, checks)
  ).toThrow("claim.undetected");
  expect(() =>
    assertClaimCoverage(
      "example.profile",
      claims,
      controls,
      {
        "claim.undetected": "No mutant exercises this behavior.",
      },
      checks
    )
  ).not.toThrow();
  expect(() =>
    assertClaimCoverage(
      "other.profile",
      claims,
      controls,
      {
        "claim.undetected": "No mutant exercises this behavior.",
      },
      checks
    )
  ).toThrow("claim.detected");
  expect(() =>
    assertClaimCoverage(
      "example.profile",
      ["claim.detected"],
      [
        {
          claimIds: ["claim.detected"],
          designatedAssertions: ["different.1.resultField"],
          kind: "implementation",
          mutantId: "mutant.a",
          profiles: ["example.profile"],
        },
      ],
      {},
      checks
    )
  ).toThrow("claim.detected");
});

test("only a killed designated detector makes a profile register entry stale", () => {
  const controls = [
    {
      claimIds: ["claim.a"],
      designatedAssertions: ["check.1.resultField"],
      kind: "implementation",
      mutantId: "mutant.a",
      profiles: ["example.profile"],
    },
  ];
  const checks = [
    {
      assertions: [
        { assertionId: "check.1.resultField", claimIds: ["claim.a"] },
      ],
    },
  ];
  const reasons = { "claim.a": "Not detected yet." };
  expect(() =>
    assertClaimCoverage(
      "example.profile",
      ["claim.a"],
      controls,
      reasons,
      checks,
      new Map()
    )
  ).not.toThrow();
  expect(() =>
    assertClaimCoverage(
      "example.profile",
      ["claim.a"],
      controls,
      reasons,
      checks,
      new Map([["mutant.a", []]])
    )
  ).not.toThrow();
  expect(() =>
    assertClaimCoverage(
      "example.profile",
      ["claim.a"],
      controls,
      reasons,
      checks,
      new Map([["mutant.a", ["check.1.resultField"]]])
    )
  ).toThrow("stale detected claims: claim.a");
  expect(() =>
    assertClaimCoverage(
      "example.profile",
      ["claim.a"],
      controls,
      { "claim.unknown": "Unknown." },
      checks
    )
  ).toThrow("unknown claims: claim.unknown");
  expect(() =>
    assertClaimCoverage(
      "example.profile",
      ["claim.a"],
      controls,
      reasons,
      [{ assertions: [] }],
      new Map([["mutant.a", ["check.1.resultField"]]])
    )
  ).not.toThrow();
});

test("a supervisor processExit assertion cannot detect an implementation mutant", async () => {
  const plan = await (
    await import("../plan-compiler/index.ts")
  ).loadConformancePlan(
    "spec/conformance/kernel/plans/kernel-crash-recovery-durable-syscall.json"
  );
  const check = plan.checks[0]?.check;
  if (check === undefined) {
    throw new Error("missing crash check");
  }
  const exitAssertions = [
    `${check.checkId}.2.processExit`,
    `${check.checkId}.kill.2.processExit`,
  ];
  expect(() =>
    assertClaimCoverage(
      "kernel.process-crash",
      check.claimIds ?? [],
      [
        {
          claimIds: check.claimIds ?? [],
          designatedAssertions: exitAssertions,
          kind: "implementation",
          mutantId: "exit-only",
          profiles: ["kernel.process-crash"],
        },
      ],
      {},
      [{ assertions: claimAssertions(check) }]
    )
  ).toThrow("without a designated detecting control");
});

test("every conditional assertion must apply in a passing fleet run", () => {
  const required = ["check.a.1.resultField", "check.b.1.resultField"];
  const first = [
    { assertionId: required[0] ?? "", status: "pass", when: "applied" },
  ];
  const second = [
    { assertionId: required[1] ?? "", status: "pass", when: "not_applied" },
  ];
  expect(() =>
    assertConditionalBranchCoverage(required, [first, second])
  ).toThrow("check.b.1.resultField");
  expect(() =>
    assertConditionalBranchCoverage(required, [
      first,
      [{ ...second[0], when: "applied", status: "pass" }],
    ])
  ).not.toThrow();
});

test("a nonexistent assertion with a matching check prefix is not a detector", () => {
  expect(() =>
    assertClaimCoverage(
      "example.profile",
      ["claim.detected"],
      [
        {
          claimIds: ["claim.detected"],
          designatedAssertions: ["check.999.resultField"],
          kind: "implementation",
          mutantId: "mutant.a",
          profiles: ["example.profile"],
        },
      ],
      {},
      [
        {
          assertions: [
            {
              assertionId: "check.1.resultField",
              claimIds: ["claim.detected"],
            },
          ],
        },
      ]
    )
  ).toThrow("claim.detected");
});

test("the fleet gate requires a real kill and rejects invalid runs", () => {
  const baseline = { status: "pass", postBaseline: { status: "pass" } };
  const passing = {
    control: baseline,
    counted: true,
    mutants: [{ mutantId: "mutant.a", outcome: "killed" }],
  };
  const unsupported = {
    control: baseline,
    counted: true,
    mutants: [
      {
        mutantId: "mutant.a",
        outcome: "unsupported",
        reason: "This port has no mutant implementation.",
      },
    ],
  };
  expect(() =>
    assertNegativeControlGate(
      "example.profile",
      ["mutant.a"],
      [passing, unsupported]
    )
  ).not.toThrow();
  expect(() =>
    assertNegativeControlGate(
      "example.profile",
      ["mutant.a"],
      [
        passing,
        {
          control: baseline,
          counted: true,
          mutants: [{ mutantId: "mutant.a", outcome: "unsupported" }],
        },
      ]
    )
  ).toThrow("mutant.a");
  expect(() =>
    assertNegativeControlGate("example.profile", ["mutant.a"], [unsupported])
  ).toThrow("mutant.a");
  expect(() =>
    assertNegativeControlGate(
      "example.profile",
      ["mutant.a"],
      [
        passing,
        {
          control: baseline,
          counted: true,
          mutants: [{ mutantId: "mutant.a", outcome: "invalid" }],
        },
      ]
    )
  ).toThrow("invalid");
  expect(() =>
    assertNegativeControlGate(
      "example.profile",
      ["mutant.a"],
      [{ ...passing, counted: false }]
    )
  ).toThrow("baseline");
  for (const postBaseline of [
    undefined,
    { status: "fail" },
    { status: "error" },
  ]) {
    expect(() =>
      assertNegativeControlGate(
        "example.profile",
        ["mutant.a"],
        [{ ...passing, control: { status: "pass", postBaseline } }]
      )
    ).toThrow("baseline");
  }
});

test("a SQLite non-activation cannot borrow PostgreSQL's kill", () => {
  const baseline = { status: "pass", postBaseline: { status: "pass" } };
  const postgres = {
    control: baseline,
    counted: true,
    mutants: [{ mutantId: "kernel.example", outcome: "killed" }],
  };
  const sqlite = {
    control: baseline,
    counted: true,
    mutants: [
      {
        mutantId: "kernel.example",
        outcome: "invalid",
        reason:
          "mutant never activated and has no recorded per-port unsupported reason",
      },
    ],
  };
  expect(() =>
    assertNegativeControlGate(
      "kernel.process-crash",
      ["kernel.example"],
      [sqlite, postgres]
    )
  ).toThrow("invalid");
});

test("the kernel profile accounts for its actual controls and recorded gaps", async () => {
  const adapter = await readAdapterManifest(
    "typescript/kernel/conformance-adapter/adapter.json"
  );
  const [profile] = await readClaimedProfiles(
    adapter,
    adapter.authorityPackets
  );
  if (profile === undefined) {
    throw new Error("memory profile was not loaded");
  }
  const manifest = JSON.parse(
    await readFile("spec/conformance/kernel/negative-controls.json", "utf-8")
  ) as { controls: CoverageControl[] };
  const packet = adapter.authorityPackets[0];
  if (packet === undefined) {
    throw new Error("missing kernel packet");
  }
  const reasons = await readUndetectedRegister(packet, profile.profileId);
  const plans = await readPlans(adapter, { packets: [], plans: [] });
  const checks = plans.flatMap((plan) =>
    plan.checks.map(({ check }) => ({
      assertions: claimAssertions(check),
    }))
  );
  expect(() =>
    assertClaimCoverage(
      profile.profileId,
      profile.claimIds,
      manifest.controls.filter((control) =>
        profile.negativeControls.includes(control.mutantId)
      ),
      reasons,
      checks
    )
  ).not.toThrow();
  const firstGap = Object.keys(reasons)[0];
  if (firstGap === undefined) {
    throw new Error("expected the recorded undetected claims");
  }
  const incomplete = { ...reasons };
  delete incomplete[firstGap];
  expect(() =>
    assertClaimCoverage(
      profile.profileId,
      profile.claimIds,
      manifest.controls.filter((control) =>
        profile.negativeControls.includes(control.mutantId)
      ),
      incomplete,
      checks
    )
  ).toThrow(firstGap);
});

test("packet registers are checked by the fleet gate against profiles, schemas and killed detectors", async () => {
  const adapter = await readAdapterManifest(
    "typescript/kernel/conformance-adapter/adapter-sqlite.json"
  );
  const packetPath = "spec/kernel/authority-packet.json";
  const packet: unknown = JSON.parse(await readFile(packetPath, "utf8"));
  if (typeof packet !== "object" || packet === null || Array.isArray(packet)) {
    throw new Error("invalid packet");
  }
  const references = await readUndetectedRegisterReferences(packetPath);
  const authority = await readProfileAuthority(adapter, [packetPath]);
  const profiles = authority.get("tuvren.kernel.protocol") ?? [];
  expect([...references.keys()].toSorted()).toEqual(
    profiles.map((profile) => profile.profileId).toSorted()
  );
  expect(profiles).toHaveLength(4);
  const plans = await readPlans(adapter, { packets: [packetPath], plans: [] });
  const manifest = JSON.parse(
    await readFile("spec/conformance/kernel/negative-controls.json", "utf8")
  ) as { controls: CoverageControl[] };
  const reports: NegativeControlReport[] = profiles.map((profile) => ({
    control: {
      adapter: "test",
      status: "pass",
      postBaseline: { status: "pass" },
      conditionalAssertions: profileConditionalAssertions(
        profile.claimIds,
        plans
      ).map((assertionId) => ({
        assertionId,
        status: "pass",
        when: "applied",
      })),
    },
    counted: true,
    findings: [],
    manifest: "test",
    mode: "enforcing",
    mutantAdapter: "test",
    mutants: profile.negativeControls.map((mutantId) => ({
      activated: true,
      activationCount: 1,
      collateral: { assertions: [], count: 0 },
      designatedFailures: [
        ...(manifest.controls.find((control) => control.mutantId === mutantId)
          ?.designatedAssertions ?? []),
      ],
      kind: "implementation",
      mutantId,
      outcome: "killed",
    })),
    notRun: [],
    packet: packetPath,
    port: "kernel",
    profile: profile.profileId,
    totals: {
      activated: 0,
      equivalent: 0,
      invalid: 0,
      killed: 0,
      survived: 0,
      unsupported: 0,
    },
  }));
  const directory = await mkdtemp(path.join(tmpdir(), "register-gate-"));
  try {
    const copy = path.join(directory, "packet.json");
    const original = Object.fromEntries(references);
    const config = NEGATIVE_CONTROL_PORTS.find(
      (entry) => entry.profile === "kernel.persistent-reopen"
    );
    if (config === undefined) {
      throw new Error("missing durable control config");
    }
    for (const profile of profiles) {
      const selected = NEGATIVE_CONTROL_PORTS.find(
        (entry) => entry.profile === profile.profileId
      );
      if (selected === undefined) {
        throw new Error(`missing ${profile.profileId} configuration`);
      }
      expect(await checkFleetGate([selected], reports)).toEqual([]);
      const register = await readUndetectedRegister(
        packetPath,
        profile.profileId
      );
      expect(Object.keys(register).length > 0).toBe(
        profile.profileId === "kernel.memory"
      );
    }
    const cases: [string, Record<string, string>, string][] = [
      [
        "empty reason",
        {
          ...original,
          [config.profile]:
            "tools/conformance/meta-conformance/fixtures/undetected-empty-reason.json",
        },
        "invalid undetected register",
      ],
      [
        "blank reason",
        {
          ...original,
          [config.profile]:
            "tools/conformance/meta-conformance/fixtures/undetected-blank-reason.json",
        },
        "invalid reason",
      ],
      [
        "non-string reason",
        {
          ...original,
          [config.profile]:
            "tools/conformance/meta-conformance/fixtures/undetected-non-string.json",
        },
        "invalid undetected register",
      ],
      [
        "duplicate claim",
        {
          ...original,
          [config.profile]:
            "tools/conformance/meta-conformance/fixtures/undetected-duplicate.txt",
        },
        "duplicate object key",
      ],
      [
        "unknown claim",
        {
          ...original,
          [config.profile]:
            "tools/conformance/meta-conformance/fixtures/undetected-unknown.json",
        },
        "unknown claims",
      ],
      [
        "stale killed claim",
        {
          ...original,
          [config.profile]:
            "tools/conformance/meta-conformance/fixtures/undetected-stale.json",
        },
        "stale detected claims",
      ],
      [
        "missing profile",
        Object.fromEntries(
          Object.entries(original).filter(([id]) => id !== "kernel.memory")
        ),
        "missing kernel.memory",
      ],
      [
        "unknown profile",
        {
          ...original,
          "kernel.unknown":
            "spec/conformance/kernel/kernel-process-crash-undetected.json",
        },
        "unknown kernel.unknown",
      ],
    ];
    for (const [label, registers, message] of cases) {
      await writeFile(
        copy,
        JSON.stringify({ ...packet, undetectedRegisters: registers })
      );
      const failures = await checkFleetGate(
        [{ ...config, packet: copy }],
        reports
      );
      expect(failures, label).toEqual([expect.stringContaining(message)]);
    }
    await writeFile(
      copy,
      JSON.stringify({
        ...packet,
        undetectedRegisters: {
          ...original,
          [config.profile]:
            "tools/conformance/meta-conformance/fixtures/undetected-stale.json",
        },
      })
    );
    const detecting = reports.find(
      (report) => report.profile === config.profile
    );
    if (detecting === undefined) throw new Error("missing profile report");
    const other = {
      ...detecting,
      control: { ...detecting.control, adapter: "other" },
      mutants: detecting.mutants.map((mutant) => ({
        ...mutant,
        designatedFailures: [],
      })),
    };
    expect(
      await checkFleetGate([{ ...config, packet: copy }], [other])
    ).toEqual([]);
    expect(
      await checkFleetGate([{ ...config, packet: copy }], [other, detecting])
    ).toEqual([expect.stringContaining("stale detected claims")]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

test("a designated legacy kill earns no profile claim credit", () => {
  expect(() =>
    assertClaimCoverage(
      "example.profile",
      ["profile.claim"],
      [
        {
          claimIds: ["legacy.claim"],
          designatedAssertions: ["legacy.1.resultField"],
          kind: "implementation",
          mutantId: "legacy",
          profiles: ["example.profile"],
        },
      ],
      {},
      [
        {
          assertions: [
            { assertionId: "legacy.1.resultField", claimIds: ["legacy.claim"] },
          ],
        },
      ]
    )
  ).toThrow("profile.claim");
});
