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

import { createIdentityPayloadCodec } from "@tuvren/core/lifecycle";
import {
  encodeDeterministicKernelRecord,
  hashOpaqueObjectBytes,
} from "@tuvren/kernel-protocol";

describe("admission-keyless message compatibility", () => {
  test("preserves the pre-admission-key identity bytes and message hash", async () => {
    const fixture = readAdmissionKeylessFixture();
    const encoded = encodeDeterministicKernelRecord(fixture.message);
    const stored = await createIdentityPayloadCodec().encrypt(encoded, {
      edge: "message",
      scope: "tuvren.scope.default",
    });

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

function readAdmissionKeylessFixture(): AdmissionKeylessFixture {
  const fixture: unknown = JSON.parse(
    readFileSync(
      new URL(
        "../../../spec/conformance/engine/fixtures/admission-keyless-user-message.json",
        import.meta.url
      ),
      "utf8"
    )
  );

  if (
    fixture === null ||
    typeof fixture !== "object" ||
    !("message" in fixture) ||
    fixture.message === null ||
    typeof fixture.message !== "object" ||
    !("role" in fixture.message) ||
    fixture.message.role !== "user" ||
    !("parts" in fixture.message) ||
    !Array.isArray(fixture.message.parts) ||
    fixture.message.parts.length !== 1 ||
    fixture.message.parts[0] === null ||
    typeof fixture.message.parts[0] !== "object" ||
    !("type" in fixture.message.parts[0]) ||
    fixture.message.parts[0].type !== "text" ||
    !("text" in fixture.message.parts[0]) ||
    typeof fixture.message.parts[0].text !== "string" ||
    !("identityPayloadCodec" in fixture) ||
    fixture.identityPayloadCodec === null ||
    typeof fixture.identityPayloadCodec !== "object" ||
    !("encodedBytesHex" in fixture.identityPayloadCodec) ||
    typeof fixture.identityPayloadCodec.encodedBytesHex !== "string" ||
    !("messageHash" in fixture.identityPayloadCodec) ||
    typeof fixture.identityPayloadCodec.messageHash !== "string"
  ) {
    throw new Error("admission-keyless user-message fixture is malformed");
  }

  return {
    identityPayloadCodec: {
      encodedBytesHex: fixture.identityPayloadCodec.encodedBytesHex,
      messageHash: fixture.identityPayloadCodec.messageHash,
    },
    message: {
      parts: [
        {
          text: fixture.message.parts[0].text,
          type: "text",
        },
      ],
      role: "user",
    },
  };
}
