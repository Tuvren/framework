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
import { providerTestkitFixtures } from "../src/index.ts";

describe("@tuvren/provider-testkit conformance assets", () => {
  test("loads boundary-owned provider fixtures", () => {
    // This suite is the first language-agnostic provider seed corpus, so the
    // conformance assertions cover the exact prompt, response, structured, and
    // tool shapes that the compatibility matrix is claiming to measure.
    expect(providerTestkitFixtures.prompt).toEqual({
      messages: [
        {
          parts: [
            {
              text: "Return a concise answer.",
              type: "text",
            },
          ],
          role: "user",
        },
      ],
    });
    expect(providerTestkitFixtures.response).toEqual({
      finishReason: "stop",
      parts: [
        {
          text: "ready",
          type: "text",
        },
      ],
      usage: {
        inputTokens: 4,
        outputTokens: 1,
      },
    });
    expect(providerTestkitFixtures.structuredPrompt).toEqual({
      messages: [
        {
          parts: [
            {
              text: "Return JSON.",
              type: "text",
            },
          ],
          role: "user",
        },
      ],
      responseFormat: {
        name: "answer",
        schema: {
          properties: {
            answer: {
              type: "string",
            },
          },
          required: ["answer"],
          type: "object",
        },
      },
    });
    expect(providerTestkitFixtures.toolPrompt).toEqual({
      messages: [
        {
          parts: [
            {
              text: "Search the docs.",
              type: "text",
            },
          ],
          role: "user",
        },
      ],
      tools: [
        {
          description: "Search docs",
          inputSchema: {
            properties: {
              query: {
                type: "string",
              },
            },
            required: ["query"],
            type: "object",
          },
          name: "search",
        },
      ],
    });
  });
});
