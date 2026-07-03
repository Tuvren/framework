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

// biome-ignore-all lint/suspicious/useAwait: Mock async provider interfaces intentionally preserve promise-based signatures in these validation tests.

import { describe, expect, test } from "bun:test";
import type { DriverExecutionContext } from "@tuvren/core/driver";
import type {
  TuvrenModelResponse,
  TuvrenProvider,
} from "@tuvren/core/provider";
import { createReActDriver } from "../src/index.ts";
import { createDriverExecutionContext } from "./react-driver-test-helpers.ts";

describe("driver-react structured output", () => {
  test("fails hard when config.model is not a concrete provider", async () => {
    const driver = createReActDriver().create();

    const result = await driver.execute(
      createDriverExecutionContext({
        config: {
          model: "gpt-test",
          name: "primary",
        },
      })
    );

    expect(result.resolution.type).toBe("fail");

    if (result.resolution.type !== "fail") {
      throw new Error("expected a fail resolution");
    }

    expect(result.resolution.fatality).toBe("hard");
    expect(
      "code" in result.resolution.error
        ? result.resolution.error.code
        : undefined
    ).toBe("react_driver_missing_provider");
  });

  test("fails hard when config.model is an object that is not a provider", async () => {
    const driver = createReActDriver().create();
    const config: DriverExecutionContext["config"] = JSON.parse(
      '{"model":{"id":"provider"},"name":"primary"}'
    );

    const result = await driver.execute(
      createDriverExecutionContext({
        config,
      })
    );

    expect(result.resolution.type).toBe("fail");

    if (result.resolution.type !== "fail") {
      throw new Error("expected a fail resolution");
    }

    expect(result.resolution.fatality).toBe("hard");
    expect(
      "code" in result.resolution.error
        ? result.resolution.error.code
        : undefined
    ).toBe("react_driver_missing_provider");
  });

  test("fails hard when structured output violates the requested schema", async () => {
    const provider = {
      async generate() {
        return {
          finishReason: "stop",
          parts: [
            {
              data: { answer: 42 },
              name: "answer",
              type: "structured",
            },
          ],
        } satisfies TuvrenModelResponse;
      },
      id: "provider",
      async *stream() {
        yield* [];
      },
    } satisfies TuvrenProvider;
    const driver = createReActDriver({
      providerCallMode: "generate",
    }).create();

    const result = await driver.execute(
      createDriverExecutionContext({
        config: {
          model: provider,
          name: "primary",
          responseFormat: {
            name: "answer",
            schema: {
              properties: {
                answer: { type: "string" },
              },
              required: ["answer"],
              type: "object",
            },
          },
        },
      })
    );

    expect(result.resolution.type).toBe("fail");

    if (result.resolution.type !== "fail") {
      throw new Error("expected a fail resolution");
    }

    expect(
      "code" in result.resolution.error
        ? result.resolution.error.code
        : undefined
    ).toBe("structured_output_validation");
  });

  test("validates draft 2020-12 structured output using the declared schema dialect", async () => {
    const provider = {
      async generate() {
        return {
          finishReason: "stop",
          parts: [
            {
              data: ["x"],
              name: "answer",
              type: "structured",
            },
          ],
        } satisfies TuvrenModelResponse;
      },
      id: "provider",
      async *stream() {
        yield* [];
      },
    } satisfies TuvrenProvider;
    const driver = createReActDriver({
      providerCallMode: "generate",
    }).create();

    const result = await driver.execute(
      createDriverExecutionContext({
        config: {
          model: provider,
          name: "primary",
          responseFormat: {
            name: "answer",
            schema: {
              $schema: "https://json-schema.org/draft/2020-12/schema",
              items: false,
              prefixItems: [{ type: "string" }],
              type: "array",
            },
          },
        },
      })
    );

    expect(result.resolution).toEqual({
      reason: "done",
      type: "end_turn",
    });
    expect(result.messages).toEqual([
      {
        parts: [
          {
            data: ["x"],
            name: "answer",
            type: "structured",
          },
        ],
        role: "assistant",
      },
    ]);
  });

  test("validates dynamic structured schemas with reused ids independently", async () => {
    let generateCalls = 0;
    const provider = {
      async generate() {
        generateCalls += 1;
        return {
          finishReason: "stop",
          parts: [
            {
              data: generateCalls === 1 ? { answer: "alpha" } : { answer: 42 },
              name: "answer",
              type: "structured",
            },
          ],
        } satisfies TuvrenModelResponse;
      },
      id: "provider",
      async *stream() {
        yield* [];
      },
    } satisfies TuvrenProvider;
    const driver = createReActDriver({
      providerCallMode: "generate",
    }).create();

    const firstResult = await driver.execute(
      createDriverExecutionContext({
        config: {
          model: provider,
          name: "primary",
          responseFormat: {
            name: "answer",
            schema: {
              $id: "urn:tuvren:test:answer",
              additionalProperties: false,
              properties: {
                answer: { type: "string" },
              },
              required: ["answer"],
              type: "object",
            },
          },
        },
      })
    );
    const secondResult = await driver.execute(
      createDriverExecutionContext({
        config: {
          model: provider,
          name: "primary",
          responseFormat: {
            name: "answer",
            schema: {
              $id: "urn:tuvren:test:answer",
              additionalProperties: false,
              properties: {
                answer: { type: "number" },
              },
              required: ["answer"],
              type: "object",
            },
          },
        },
      })
    );

    expect(firstResult.resolution).toEqual({
      reason: "done",
      type: "end_turn",
    });
    expect(secondResult.resolution).toEqual({
      reason: "done",
      type: "end_turn",
    });
  });

  test("validates draft 2019-09 structured output using the declared schema dialect", async () => {
    const provider = {
      async generate() {
        return {
          finishReason: "stop",
          parts: [
            {
              data: { answer: "ok", extra: true },
              name: "answer",
              type: "structured",
            },
          ],
        } satisfies TuvrenModelResponse;
      },
      id: "provider",
      async *stream() {
        yield* [];
      },
    } satisfies TuvrenProvider;
    const driver = createReActDriver({
      providerCallMode: "generate",
    }).create();

    const result = await driver.execute(
      createDriverExecutionContext({
        config: {
          model: provider,
          name: "primary",
          responseFormat: {
            name: "answer",
            schema: {
              $schema: "https://json-schema.org/draft/2019-09/schema",
              properties: {
                answer: { type: "string" },
              },
              required: ["answer"],
              type: "object",
              unevaluatedProperties: false,
            },
          },
        },
      })
    );

    expect(result.resolution.type).toBe("fail");

    if (result.resolution.type !== "fail") {
      throw new Error("expected a fail resolution");
    }

    expect(result.resolution.fatality).toBe("hard");
    expect(
      "code" in result.resolution.error
        ? result.resolution.error.code
        : undefined
    ).toBe("structured_output_validation");
  });

  test("fails hard when structured output declares an unsupported schema dialect", async () => {
    const provider = {
      async generate() {
        return {
          finishReason: "stop",
          parts: [
            {
              data: { answer: "ok" },
              name: "answer",
              type: "structured",
            },
          ],
        } satisfies TuvrenModelResponse;
      },
      id: "provider",
      async *stream() {
        yield* [];
      },
    } satisfies TuvrenProvider;
    const driver = createReActDriver({
      providerCallMode: "generate",
    }).create();

    const result = await driver.execute(
      createDriverExecutionContext({
        config: {
          model: provider,
          name: "primary",
          responseFormat: {
            name: "answer",
            schema: {
              $schema: "https://example.com/json-schema/latest",
              properties: {
                answer: { type: "string" },
              },
              required: ["answer"],
              type: "object",
            },
          },
        },
      })
    );

    expect(result.resolution.type).toBe("fail");

    if (result.resolution.type !== "fail") {
      throw new Error("expected a fail resolution");
    }

    expect(result.resolution.fatality).toBe("hard");
    expect(
      "code" in result.resolution.error
        ? result.resolution.error.code
        : undefined
    ).toBe("structured_output_validation");
  });

  test("fails hard when a structured response request ends with plain text only", async () => {
    const provider = {
      async generate() {
        return {
          finishReason: "stop",
          parts: [{ text: "plain text fallback", type: "text" }],
        } satisfies TuvrenModelResponse;
      },
      id: "provider",
      async *stream() {
        yield* [];
      },
    } satisfies TuvrenProvider;
    const driver = createReActDriver({
      providerCallMode: "generate",
    }).create();

    const result = await driver.execute(
      createDriverExecutionContext({
        config: {
          model: provider,
          name: "primary",
          responseFormat: {
            name: "answer",
            schema: {
              properties: {
                answer: { type: "string" },
              },
              required: ["answer"],
              type: "object",
            },
          },
        },
      })
    );

    expect(result.resolution.type).toBe("fail");

    if (result.resolution.type !== "fail") {
      throw new Error("expected a fail resolution");
    }

    expect(
      "code" in result.resolution.error
        ? result.resolution.error.code
        : undefined
    ).toBe("structured_output_validation");
  });
});
