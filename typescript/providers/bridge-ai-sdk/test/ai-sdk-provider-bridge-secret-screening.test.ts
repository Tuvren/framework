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

// Provider-bridge secret screening at the seam (ADR-044/058, KRT-BK004).
// `requestBody` and response-header values captured into `bridgeExtras`
// previously passed only through `sanitizeMetadataValue` (JSON-safety
// normalization, no pattern-based secret detection) before reaching
// `buildProviderMetadata`'s `aiSdkBridge` field -- which backs both
// "tool_call.done"-shaped stream chunks and durable run records. These tests
// prove a credential-shaped value that is NOT an exact configured fixture
// secret (so the value-equality `secretAbsence` check alone would miss it) is
// now screened out before reaching that surface, for both the generate and
// stream bridge paths.

import { describe, expect, test } from "bun:test";
import { createAiSdkProviderBridge } from "../src/index.ts";
import {
  createGenerateResult,
  createMockModel,
  createUsage,
  streamFromParts,
} from "./ai-sdk-provider-bridge-test-helpers.ts";

// A JWT-shaped credential embedded in a captured requestBody/response header.
// Not equal to any exact configured secret -- only pattern-shaped detection
// (not value-equality) can catch it.
const JWT_SHAPED_SECRET =
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhaS1zZGstYnJpZGdlLXRlc3QifQ.QVzX9k3f7c9a1e2b4d6f8a0c5e7b9d1f3a5c7e9b1d3f5a7c9e1b3d5f7a9c1e3b";

describe("provider-bridge-ai-sdk secret screening (KRT-BK004)", () => {
  test("screens a credential-shaped requestBody value out of generate() providerMetadata.aiSdkBridge", async () => {
    const bridge = createAiSdkProviderBridge({
      model: createMockModel({
        async doGenerate() {
          await Promise.resolve();
          return createGenerateResult({
            request: {
              body: JSON.stringify({
                authorization: `Bearer ${JWT_SHAPED_SECRET}`,
              }),
            },
            usage: createUsage(1, 1),
          });
        },
      }),
    });

    const response = await bridge.generate({
      messages: [{ parts: [{ text: "hi", type: "text" }], role: "user" }],
    });

    const aiSdkBridge = response.providerMetadata?.aiSdkBridge as
      | Record<string, unknown>
      | undefined;
    expect(aiSdkBridge).toBeDefined();
    const serialized = JSON.stringify(aiSdkBridge);
    // The raw credential-shaped substring must never survive into the built
    // metadata -- this is the behavior the KRT-BK004 screen exists to
    // guarantee. If this assertion regresses, the seam has stopped screening.
    expect(serialized).not.toContain(JWT_SHAPED_SECRET);
    expect(serialized).toContain("[redacted]");
  });

  test("screens a signed-URL/bearer-token-shaped response header out of generate() providerMetadata.aiSdkBridge", async () => {
    const bridge = createAiSdkProviderBridge({
      model: createMockModel({
        async doGenerate() {
          await Promise.resolve();
          return createGenerateResult({
            response: {
              headers: {
                "x-signed-url": `https://cdn.example.test/asset?token=${JWT_SHAPED_SECRET}`,
              },
            },
            usage: createUsage(1, 1),
          });
        },
      }),
    });

    const response = await bridge.generate({
      messages: [{ parts: [{ text: "hi", type: "text" }], role: "user" }],
    });

    const serialized = JSON.stringify(response.providerMetadata?.aiSdkBridge);
    expect(serialized).not.toContain(JWT_SHAPED_SECRET);
    expect(serialized).toContain("[redacted]");
  });

  test("screens a credential-shaped requestBody value out of the stream() finish chunk's providerMetadata.aiSdkBridge", async () => {
    const bridge = createAiSdkProviderBridge({
      model: createMockModel({
        async doStream() {
          await Promise.resolve();
          return {
            request: {
              body: JSON.stringify({
                authorization: `Bearer ${JWT_SHAPED_SECRET}`,
              }),
            },
            response: {
              headers: {
                "x-signed-url": `https://cdn.example.test/asset?token=${JWT_SHAPED_SECRET}`,
              },
            },
            stream: streamFromParts([
              {
                finishReason: { raw: "stop", unified: "stop" },
                type: "finish",
                usage: createUsage(1, 1),
              },
            ]),
          };
        },
      }),
    });

    const chunks: unknown[] = [];
    for await (const chunk of bridge.stream({
      messages: [{ parts: [{ text: "hi", type: "text" }], role: "user" }],
    })) {
      chunks.push(chunk);
    }

    const finishChunk = chunks.find(
      (chunk): chunk is { providerMetadata?: Record<string, unknown> } =>
        typeof chunk === "object" &&
        chunk !== null &&
        (chunk as { type?: unknown }).type === "finish"
    );
    const serialized = JSON.stringify(
      finishChunk?.providerMetadata?.aiSdkBridge
    );
    expect(serialized).not.toContain(JWT_SHAPED_SECRET);
    expect(serialized).toContain("[redacted]");
  });

  test("leaves providerMetadata (reasoning signatures) completely untouched", async () => {
    // Regression guard for the ticket's named STOP-adjacent hazard: screening
    // must never reach `providerMetadata` (only `bridgeExtras`/`aiSdkBridge`),
    // because long opaque reasoning-signature strings
    // (anthropic.signature/google,vertex.thoughtSignature) legitimately match
    // the long-secretish pattern and must survive unredacted.
    const longOpaqueSignature = "A".repeat(200);
    const bridge = createAiSdkProviderBridge({
      model: createMockModel({
        async doGenerate() {
          await Promise.resolve();
          return createGenerateResult({
            content: [
              {
                providerMetadata: {
                  anthropic: { signature: longOpaqueSignature },
                },
                text: "hi",
                type: "text",
              },
            ],
            usage: createUsage(1, 1),
          });
        },
      }),
    });

    const response = await bridge.generate({
      messages: [{ parts: [{ text: "hi", type: "text" }], role: "user" }],
    });

    const textPart = response.parts.find((part) => part.type === "text") as
      | { providerMetadata?: { anthropic?: { signature?: string } } }
      | undefined;
    expect(textPart?.providerMetadata?.anthropic?.signature).toBe(
      longOpaqueSignature
    );
  });
});
