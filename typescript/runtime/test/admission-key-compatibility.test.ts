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
import { readFileSync } from "node:fs";

import { assertKernelRecord } from "@tuvren/core";
import { createIdentityPayloadCodec } from "@tuvren/core/lifecycle";
import { assertTuvrenMessage } from "@tuvren/core/messages";
import {
  encodeDeterministicKernelRecord,
  hashOpaqueObjectBytes,
} from "@tuvren/kernel-protocol";

import { normalizeInputSignal } from "../src/lib/runtime-core-shared.ts";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const readMessage = (value: unknown): AdmissionKeylessFixture["message"] => {
  assertTuvrenMessage(value, "admission-keyless fixture message");
  if (value.role !== "user" || value.parts.length !== 1) {
    throw new Error(
      "admission-keyless user-message fixture has a malformed message"
    );
  }

  const [part] = value.parts;
  if (part?.type !== "text") {
    throw new Error("admission-keyless fixture requires one text part");
  }
  return { parts: [part], role: "user" };
};

const readIdentity = (
  value: unknown
): AdmissionKeylessFixture["identityPayloadCodec"] => {
  if (
    !isRecord(value) ||
    typeof value.encodedBytesHex !== "string" ||
    typeof value.messageHash !== "string"
  ) {
    throw new Error(
      "admission-keyless user-message fixture has malformed identity data"
    );
  }

  return {
    encodedBytesHex: value.encodedBytesHex,
    messageHash: value.messageHash,
  };
};

const readAdmissionKeylessFixture = (): AdmissionKeylessFixture => {
  const fixture: unknown = JSON.parse(
    readFileSync(
      new URL(
        "../../../spec/conformance/engine/fixtures/admission-keyless-user-message.json",
        import.meta.url
      ),
      "utf-8"
    )
  );

  if (!isRecord(fixture)) {
    throw new Error("admission-keyless user-message fixture is malformed");
  }

  return {
    identityPayloadCodec: readIdentity(fixture.identityPayloadCodec),
    message: readMessage(fixture.message),
  };
};

describe("admission-keyless message compatibility", () => {
  test("preserves the pre-admission-key identity bytes and message hash", async () => {
    const fixture = readAdmissionKeylessFixture();
    const normalizedSignal = normalizeInputSignal(
      { parts: fixture.message.parts },
      "fixture.message"
    );
    const normalizedMessage = {
      ...normalizedSignal,
      role: "user",
    };
    const record: unknown = normalizedMessage;
    assertKernelRecord(record, "normalized admission-keyless message");
    const encoded = encodeDeterministicKernelRecord(record);
    const stored = await createIdentityPayloadCodec().encrypt(encoded, {
      edge: "message",
      scope: "tuvren.scope.default",
    });

    expect("admissionKey" in normalizedMessage).toBe(false);
    expect(Buffer.from(stored).toString("hex")).toBe(
      fixture.identityPayloadCodec.encodedBytesHex
    );
    expect(await hashOpaqueObjectBytes(stored)).toBe(
      fixture.identityPayloadCodec.messageHash
    );
  });
});

interface AdmissionKeylessFixture {
  identityPayloadCodec: {
    encodedBytesHex: string;
    messageHash: string;
  };
  message: {
    parts: [{ text: string; type: "text" }];
    role: "user";
  };
}
