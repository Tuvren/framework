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
import { TuvrenRuntimeError } from "@tuvren/core";
import type {
  PathValue,
  RunCompletionStatus,
  Verdict,
  VerdictDisposition,
} from "@tuvren/kernel-protocol";
import { RunCompletionStatus as ProtoRunCompletionStatus } from "../src/lib/generated/kernel-interop/tuvren/kernel/interop/v1/kernel_types_pb.js";
import {
  createInvalidTransportResponseError,
  decodeKernelRecordBytes,
  encodeKernelRecordBytes,
  requirePathValue,
  requireVerdict,
  toProtoPathValue,
  toProtoRunCompletionStatus,
  toProtoVerdict,
} from "../src/lib/grpc-kernel-client-codec.js";

// A canonical lowercase 64-hex SHA-256 digest and a distinct second one; both
// satisfy `assertHashString`, so they survive the codec's per-hash validation.
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

// The relocated gRPC transport codec (moved from `@tuvren/runtime` into this leaf
// by ADR-059 / KRT-BJ002) carried no package-local coverage. These tests pin the
// pure domain<->proto transforms it owns: every `toProto*` must round-trip through
// its matching `require*`/`from*` decoder, and the error/enum helpers must keep
// their documented contracts. No live gRPC channel is involved.
describe("grpc kernel client codec — verdict round-trips", () => {
  const dispositions: VerdictDisposition[] = [
    "HardFail",
    "SoftFail",
    "EndTurn",
  ];

  test("proceed verdict round-trips with no embedded payload", () => {
    const verdict: Verdict = { kind: "proceed" };
    expect(
      requireVerdict(toProtoVerdict(verdict, "verdict"), "verdict")
    ).toEqual(verdict);
  });

  for (const disposition of dispositions) {
    test(`abort verdict round-trips disposition ${disposition}`, () => {
      const verdict: Verdict = {
        disposition,
        kind: "abort",
        reason: `stop because ${disposition}`,
      };
      expect(
        requireVerdict(toProtoVerdict(verdict, "verdict"), "verdict")
      ).toEqual(verdict);
    });
  }

  test("modify verdict round-trips its kernel-record transform through CBOR", () => {
    const verdict: Verdict = {
      kind: "modify",
      transform: { count: 3, nested: { flag: true }, patch: "value" },
    };
    expect(
      requireVerdict(toProtoVerdict(verdict, "verdict"), "verdict")
    ).toEqual(verdict);
  });

  test("pause verdict round-trips reason and resumption schema", () => {
    const verdict: Verdict = {
      kind: "pause",
      reason: "await approval",
      resumptionSchema: { fields: ["approval"], version: 1 },
    };
    expect(
      requireVerdict(toProtoVerdict(verdict, "verdict"), "verdict")
    ).toEqual(verdict);
  });

  test("retry verdict round-trips its adjustment record", () => {
    const verdict: Verdict = {
      adjustment: { attempts: 2, backoffMs: 100 },
      kind: "retry",
    };
    expect(
      requireVerdict(toProtoVerdict(verdict, "verdict"), "verdict")
    ).toEqual(verdict);
  });
});

describe("grpc kernel client codec — path value round-trips", () => {
  const cases: Array<{ label: string; value: PathValue }> = [
    { label: "null", value: null },
    { label: "single hash", value: HASH_A },
    { label: "ordered hashes", value: [HASH_A, HASH_B] },
  ];

  for (const { label, value } of cases) {
    test(`path value round-trips ${label}`, () => {
      expect(requirePathValue(toProtoPathValue(value, "path"), "path")).toEqual(
        value
      );
    });
  }
});

describe("grpc kernel client codec — kernel record byte round-trips", () => {
  test("nested kernel records survive deterministic CBOR encode/decode", () => {
    const record = {
      array: [true, "text", null, 7],
      nested: { deep: { value: 42 } },
      scalar: "value",
    };
    expect(
      decodeKernelRecordBytes(
        encodeKernelRecordBytes(record, "record"),
        "record"
      )
    ).toEqual(record);
  });
});

describe("grpc kernel client codec — enum and error helpers", () => {
  test("run completion status maps every domain value to its proto enum", () => {
    const expected: Record<RunCompletionStatus, ProtoRunCompletionStatus> = {
      completed: ProtoRunCompletionStatus.COMPLETED,
      failed: ProtoRunCompletionStatus.FAILED,
      paused: ProtoRunCompletionStatus.PAUSED,
    };
    for (const status of Object.keys(expected) as RunCompletionStatus[]) {
      expect(toProtoRunCompletionStatus(status)).toBe(expected[status]);
    }
  });

  test("createInvalidTransportResponseError carries the transport error code", () => {
    const error = createInvalidTransportResponseError("thread.branch");
    expect(error).toBeInstanceOf(TuvrenRuntimeError);
    expect(error.code).toBe("invalid_kernel_transport_response");
    expect(error.details).toEqual({ label: "thread.branch" });
  });

  test("requireVerdict fails loudly on a missing transport verdict", () => {
    expect(() => requireVerdict(undefined, "verdict")).toThrow(
      TuvrenRuntimeError
    );
  });
});
