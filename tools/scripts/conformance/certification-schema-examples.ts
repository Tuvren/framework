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

// Example documents built from the pinned shapes in
// .constitution/tech-spec/contracts/conformance-certification.md.

import {
  collectCertificationIntegrityFailures,
  validateCertificationDocument,
} from "./certification-schemas.js";
import type { CertificationSchemaName } from "./certification-schemas.js";

const ENCODING_ID =
  "https://tuvren.dev/schemas/conformance-observation-encoding.schema.json";
const HASH = "a".repeat(64);

export const PINNED_OPERATION_CATALOG = {
  catalogId: "tuvren.kernel.operations",
  catalogVersion: "0.1.0",
  operations: [
    {
      binding: "kernel.store",
      capability: "kernel.store",
      errors: ["store_object_not_found"],
      handles: { consumes: ["instance"] },
      input: {
        additionalProperties: false,
        properties: { bytes: { $ref: `${ENCODING_ID}#/$defs/bytes` } },
        required: ["bytes"],
        type: "object",
      },
      kind: "syscall",
      observation: {
        result: {
          additionalProperties: false,
          properties: { hash: { $ref: `${ENCODING_ID}#/$defs/hash` } },
          required: ["hash"],
          type: "object",
        },
      },
      operationId: "kernel.store.put",
    },
    {
      binding: "kernel.tree",
      capability: "kernel.tree",
      input: { type: "object" },
      kind: "syscall",
      observation: {
        result: {
          additionalProperties: false,
          properties: {
            changedPaths: { items: { type: "string" }, type: "array" },
          },
          type: "object",
        },
      },
      operationId: "kernel.tree.diff",
    },
    {
      capability: "kernel.fault-injection",
      handles: { consumes: ["instance"] },
      input: {
        additionalProperties: false,
        properties: {
          mode: { enum: ["throw", "block"] },
          occurrence: { minimum: 1, type: "integer" },
          point: { type: "string" },
        },
        type: "object",
      },
      kind: "control",
      observation: {
        result: {
          additionalProperties: false,
          properties: { token: { $ref: `${ENCODING_ID}#/$defs/handle` } },
          required: ["token"],
          type: "object",
        },
      },
      operationId: "kernel.control.arm-fault",
    },
    {
      binding: "kernel.run",
      capability: "kernel.run.recovery",
      deprecated: true,
      handles: { consumes: ["instance"], creates: ["operation"] },
      input: true,
      kind: "syscall",
      observation: {
        events: {
          items: { additionalProperties: false, type: "object" },
          type: "array",
        },
        state: { additionalProperties: false, type: "object" },
      },
      operationId: "kernel.run.recover",
    },
    {
      capability: "providers.scripted",
      input: { type: "object" },
      kind: "double",
      observation: {},
      operationId: "providers.double.scripted-generate",
    },
  ],
  packetId: "tuvren.kernel.protocol",
  seams: [
    {
      operationIds: ["kernel.store.put", "kernel.run.recover"],
      seamId: "kernel.head.compare-and-set",
    },
  ],
};

export const PINNED_OBSERVATION_RECORD = {
  $map: [
    ["kind", "turn-node"],
    ["payload", { $bytes: "00ff10" }],
    ["sequence", 9_007_199_254_740_991],
    ["parent", null],
    ["tags", ["a", true, { $bytes: "" }]],
    [
      "nested",
      {
        $map: [
          [1, "integer key"],
          [{ $bytes: "ab" }, "bytes key"],
        ],
      },
    ],
  ],
};

export const PINNED_CONFORMANCE_PLAN = {
  applicability: { capabilities: ["kernel.run"] },
  checks: [
    {
      assertions: [
        {
          field: "$.trace.await-a.result.status",
          kind: "resultField",
          present: true,
        },
      ],
      checkId: "kernel.run.race.both-orderings",
      claimIds: ["kernel.head.single-winner"],
      input: { branchId: "main" },
      operation: "kernel.run.commit",
      steps: [
        {
          action: "setClock",
          arguments: { domain: "backend", nowMs: 1000 },
          operation: "kernel.control.set-clock",
          stepId: "clock",
        },
        {
          action: "armFault",
          arguments: {
            mode: "throw",
            occurrence: 1,
            point: "after-node-before-head",
            selector: { $literal: { $ref: "input.not-a-reference" } },
          },
          capture: [{ name: "faultToken", path: "result.token" }],
          operation: "kernel.control.arm-fault",
          stepId: "arm",
        },
        {
          action: "barrier",
          barrierId: "head-cas",
          operation: "kernel.control.barrier",
          participants: ["start-a", "start-b"],
          seam: "kernel.head.compare-and-set",
          stepId: "gate",
        },
        {
          action: "start",
          arguments: {
            branchId: { $ref: "input.branchId" },
            payload: { $ref: "fixture.input.payloads.0" },
          },
          capture: [{ name: "opA", path: "result.operationHandle" }],
          claimIds: ["kernel.head.single-winner"],
          operation: "kernel.run.commit",
          stepId: "start-a",
        },
        {
          action: "start",
          arguments: {
            branchId: { $ref: "input.branchId" },
            payloads: [{ $ref: "fixture.input.payloads.1" }, "literal"],
          },
          capture: [{ name: "opB", path: "result.operationHandle" }],
          operation: "kernel.run.commit",
          stepId: "start-b",
        },
        {
          action: "release",
          barrierId: "head-cas",
          operation: "kernel.control.release",
          participants: ["start-b", "start-a"],
          stepId: "release",
        },
        {
          action: "await",
          arguments: { operationHandle: { $ref: "capture.opA" } },
          capture: [{ name: "headA", path: "state.head.hash" }],
          operation: "kernel.run.commit",
          stepId: "await-a",
        },
        {
          action: "cancel",
          arguments: {
            operationHandle: { $ref: "capture.opB" },
            reason: "late",
          },
          operation: "kernel.run.commit",
          stepId: "cancel-b",
        },
        {
          action: "subscribe",
          arguments: {
            channel: "run",
            operationHandle: { $ref: "capture.opB" },
          },
          capture: [{ name: "sub", path: "result.subscription" }],
          operation: "kernel.run.events",
          stepId: "subscribe",
        },
        {
          action: "pull",
          arguments: { credit: 1, subscription: { $ref: "capture.sub" } },
          operation: "kernel.run.events",
          stepId: "pull",
        },
        { action: "kill", operation: "kernel.control.kill", stepId: "kill" },
        {
          action: "respawn",
          operation: "kernel.control.respawn",
          stepId: "respawn",
        },
        {
          action: "openInstance",
          operation: "kernel.control.open-instance",
          stepId: "reopen",
        },
        {
          action: "restart",
          operation: "kernel.control.restart",
          stepId: "restart",
        },
        {
          action: "dispatch",
          arguments: { head: { $ref: "capture.headA" } },
          assertions: [
            {
              field: "$.head",
              kind: "resultField",
              notEqualsPath: "$.input.branchId",
            },
          ],
          operation: "kernel.run.recover",
          stepId: "recover",
        },
      ],
    },
  ],
  fixtures: { race: "../fixtures/race.json" },
  packetId: "tuvren.kernel.protocol",
  planId: "kernel-run-race",
  planVersion: "0.1.0",
};

export const PINNED_AUTHORITY_PACKET_REFERENCES = {
  certificationProfiles: "spec/conformance/kernel/profiles.json",
  negativeControlManifest: "spec/conformance/kernel/negative-controls.json",
  operationCatalog: "spec/conformance/kernel/operations.json",
};

export const PINNED_CERTIFICATION_PROFILES = {
  profiles: [
    {
      claimIds: ["kernel.head.single-winner"],
      faultPoints: [],
      negativeControls: ["kernel.accept-stale-head"],
      profileId: "kernel.memory",
      requiredCapabilities: ["kernel.store", "kernel.run"],
      requiredEvidence: ["result.trace.await-a.result.status"],
    },
    {
      claimIds: ["kernel.recovery.all-or-nothing"],
      faultPoints: ["before-checkpoint-write", "commit-unknown-outcome"],
      negativeControls: ["kernel.fault-seam-never-fires"],
      profileId: "kernel.process-crash",
      requiredCapabilities: ["kernel.run.recovery"],
      requiredEvidence: [],
    },
  ],
};

export const PINNED_NEGATIVE_CONTROLS = {
  controls: [
    {
      activation: {
        precondition: "two contenders share one head",
        signal: "mutant.accept-stale-head.entered",
      },
      claimIds: ["kernel.head.single-winner"],
      designatedAssertions: ["kernel.run.race.both-orderings.1.resultField"],
      kind: "implementation",
      mutantId: "kernel.accept-stale-head",
      profiles: ["kernel.memory"],
      rule: "docs/KrakenKernelSpecification.md#55-checkpoint",
    },
    {
      activation: {
        precondition: "store.put returns a hash",
        signal: "mutant.corrupt-hash.entered",
      },
      claimIds: ["kernel.store.content-address"],
      expectedRejection: "observation_schema_violation",
      kind: "observation",
      mutantId: "kernel.observation.uppercase-hash",
      profiles: ["kernel.memory"],
      rule: "spec/kernel/cddl/kernel-records.cddl",
    },
    {
      activation: {
        precondition: "armFault called with mode block",
        signal: "mutant.fault-seam-never-fires.entered",
      },
      claimIds: ["kernel.recovery.all-or-nothing"],
      expectedRejection: "missing_fault_activation",
      kind: "instrumentation",
      mutantId: "kernel.fault-seam-never-fires",
      profiles: ["kernel.process-crash"],
      rule: "ADR-0076",
    },
  ],
};

export const PINNED_CERTIFICATION_EVIDENCE = {
  adapterId: "typescript-kernel",
  boundary: "kernel",
  capabilities: ["kernel.run", "kernel.store"],
  certificate: {
    complete: true,
    profile: "kernel.memory",
    status: "certified",
  },
  checkResults: [
    {
      assertionResults: [
        { assertionId: "kernel.store.put.1.resultField", status: "pass" },
      ],
      checkId: "kernel.store.put",
      details: { adapterId: "typescript-kernel", planId: "kernel-store" },
      status: "pass",
    },
    {
      assertionResults: [
        {
          assertionId: "kernel.run.race.both-orderings.1.resultField",
          message: "expected head to differ",
          status: "fail",
        },
      ],
      checkId: "kernel.run.race.both-orderings",
      details: { adapterId: "typescript-kernel", planId: "kernel-run-race" },
      failure: {
        arguments: { branchId: "main" },
        classification: "implementation",
        exit: { code: null, signal: "SIGKILL" },
        fault: { token: "fault-1" },
        frameLog: [
          { arrivalMs: 12, frame: { id: 1, jsonrpc: "2.0", result: null } },
        ],
        observation: { result: { head: "main" } },
        operands: [
          {
            actual: "main",
            expected: "main",
            expectedSource: "input.branchId",
            path: "$.head",
          },
          { expectedSource: "literal", path: "$.missing" },
        ],
        replay:
          "bun tools/conformance/harness/run.ts --adapter typescript/kernel/conformance-adapter/adapter.json --check kernel.run.race.both-orderings",
        stderrTail: "",
        storageRef: "sqlite-directory:/tmp/tuvren-check-1",
      },
      status: "fail",
    },
  ],
  digests: {
    adapterManifest: HASH,
    catalogs: HASH,
    controls: HASH,
    fixtures: HASH,
    harness: HASH,
    implementation: HASH,
    packet: HASH,
    plans: HASH,
    profiles: HASH,
    verifierAuthority: HASH,
  },
  environment: { bun: "1.3.0", os: "linux" },
  implementationId: "typescript-kernel",
  language: "typescript",
  negativeControlRunId: "control-run-1",
  nonApplicableCheckIds: ["kernel.reclamation.sweep"],
  selection: [
    { checkId: "kernel.store.put", selected: true },
    { checkId: "kernel.run.race.both-orderings", selected: true },
    {
      checkId: "kernel.reclamation.sweep",
      reason:
        "capability kernel.maintenance.reclamation is not required by kernel.memory",
      selected: false,
    },
  ],
  status: "fail",
  suiteId: "tuvren.kernel.protocol",
  suiteVersion: "0.12.0",
  summary: {
    applicableChecks: 2,
    failedChecks: 1,
    nonApplicableChecks: 1,
    passedChecks: 1,
    totalChecks: 3,
  },
};

export const PINNED_CERTIFICATION_EXAMPLES: readonly {
  name: CertificationSchemaName;
  value: unknown;
}[] = [
  { name: "operationCatalog", value: PINNED_OPERATION_CATALOG },
  { name: "observationEncoding", value: PINNED_OBSERVATION_RECORD },
  { name: "conformancePlan", value: PINNED_CONFORMANCE_PLAN },
  { name: "certificationProfile", value: PINNED_CERTIFICATION_PROFILES },
  { name: "negativeControlManifest", value: PINNED_NEGATIVE_CONTROLS },
  { name: "certificationEvidence", value: PINNED_CERTIFICATION_EVIDENCE },
];

const withUnknownField = (value: unknown): unknown => ({
  ...(value as Record<string, unknown>),
  undeclaredField: true,
});

/**
 * Validates every pinned example and proves each closed root rejects an
 * undeclared field. Throws with every violation found.
 */
export const assertCertificationSchemaContracts = (): void => {
  const failures: string[] = [];

  for (const { name, value } of PINNED_CERTIFICATION_EXAMPLES) {
    for (const violation of validateCertificationDocument(name, value)) {
      failures.push(`${name} pinned example: ${violation}`);
    }

    if (
      name !== "observationEncoding" &&
      validateCertificationDocument(name, withUnknownField(value)).length === 0
    ) {
      failures.push(`${name} accepted an undeclared root field`);
    }
  }

  for (const name of [
    "operationCatalog",
    "certificationProfile",
    "negativeControlManifest",
  ] as const) {
    const example = PINNED_CERTIFICATION_EXAMPLES.find(
      (entry) => entry.name === name
    );

    for (const failure of collectCertificationIntegrityFailures(
      name,
      example?.value
    )) {
      failures.push(`${name} pinned example: ${failure}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `certification schema contracts failed:\n${failures.join("\n")}`
    );
  }
};
