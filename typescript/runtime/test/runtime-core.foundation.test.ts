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
import type { ContextManifest } from "@tuvren/core/execution";
import type { TuvrenExtension } from "@tuvren/core/extensions";
import type { TuvrenToolDefinition } from "@tuvren/core/tools";
import {
  collectSystemPrompts,
  createContextManifest,
  createToolRegistry,
  runAfterTurnHooks,
  runBeforeIterationHooks,
  runBeforeTurnHooks,
  updateContextManifest,
} from "../src/index.ts";
import { toOptionalRecord } from "./runtime-core-test-helpers.ts";

describe("framework-runtime-core", () => {
  test("builds tool registries and rejects duplicate tool names across extensions", () => {
    const registry = createToolRegistry(
      [
        {
          description: "Search documentation",
          execute() {
            return {};
          },
          inputSchema: {
            properties: {
              query: { type: "string" },
            },
            required: ["query"],
            type: "object",
          },
          name: "search",
        },
      ],
      [
        {
          name: "docs",
          tools: [
            {
              description: "Summarize content",
              execute() {
                return {};
              },
              inputSchema: {
                type: "object",
              },
              name: "summarize",
            },
          ],
        },
      ]
    );

    expect(registry.has("search")).toBe(true);
    expect(registry.has("summarize")).toBe(true);
    expect(() =>
      createToolRegistry(
        [
          {
            description: "Search documentation",
            execute() {
              return {};
            },
            inputSchema: {
              type: "object",
            },
            name: "search",
          },
        ],
        [
          {
            name: "docs",
            tools: [
              {
                description: "Duplicate search",
                execute() {
                  return {};
                },
                inputSchema: {
                  type: "object",
                },
                name: "search",
              },
            ],
          },
        ]
      )
    ).toThrow("already registered");
  });

  test("rejects duplicate extension names before runtime state can alias", () => {
    expect(() =>
      createToolRegistry(
        [],
        [
          {
            name: "shared",
          },
          {
            name: "shared",
          },
        ]
      )
    ).toThrow('extension "shared" is already registered');
  });

  test("tool registries snapshot tool definitions instead of exposing live references", () => {
    const originalMetadata = {
      channel: "primary",
    };
    const originalTool: TuvrenToolDefinition = {
      approval: true,
      description: "Search documentation",
      execute() {
        return {};
      },
      inputSchema: {
        properties: {
          query: { type: "string" },
        },
        required: ["query"],
        type: "object",
      },
      metadata: originalMetadata,
      name: "search",
      timeout: 1000,
    };
    const registry = createToolRegistry([originalTool]);
    const firstRead = registry.get("search");
    const secondRead = registry.get("search");
    const listedRead = registry.list()[0];

    if (
      firstRead === undefined ||
      secondRead === undefined ||
      listedRead === undefined
    ) {
      throw new Error("expected the registered tool to be readable");
    }

    expect(firstRead).not.toBe(originalTool);
    expect(secondRead).not.toBe(originalTool);
    expect(listedRead).not.toBe(originalTool);
    expect(secondRead).not.toBe(firstRead);
    expect(listedRead).not.toBe(firstRead);
    expect(firstRead.metadata).not.toBe(originalMetadata);

    firstRead.approval = false;
    firstRead.timeout = 5;

    if (
      firstRead.metadata !== undefined &&
      typeof firstRead.metadata === "object" &&
      !Array.isArray(firstRead.metadata)
    ) {
      firstRead.metadata.channel = "mutated";
    }

    const freshRead = registry.get("search");

    if (freshRead === undefined) {
      throw new Error("expected the registered tool to remain readable");
    }

    expect(originalTool.approval).toBe(true);
    expect(originalTool.timeout).toBe(1000);
    expect(originalMetadata.channel).toBe("primary");
    expect(freshRead.approval).toBe(true);
    expect(freshRead.timeout).toBe(1000);
    expect(freshRead.metadata).toEqual({
      channel: "primary",
    });
  });

  test("allows same-turn user messages without creating new turn boundaries", () => {
    const manifest = createContextManifest([
      {
        parts: [{ text: "Turn start", type: "text" }],
        role: "user",
      },
      {
        parts: [{ text: "Assistant reply", type: "text" }],
        role: "assistant",
      },
    ]);
    const continuedManifest = updateContextManifest(
      manifest,
      [
        {
          parts: [{ text: "Injected same-turn user message", type: "text" }],
          role: "user",
        },
      ],
      [],
      []
    );

    expect(manifest.turnBoundaries).toEqual([0]);
    expect(continuedManifest.turnBoundaries).toEqual([0]);
  });

  test("collectSystemPrompts reports non-fatal prompt contribution failures", () => {
    const issues: Array<{ extensionName: string; message: string }> = [];
    const prompts = collectSystemPrompts(
      [
        {
          name: "broken",
          systemPrompt() {
            throw new Error("prompt failed");
          },
        },
        {
          name: "working",
          systemPrompt: "Visible prompt",
        },
      ],
      {
        byRole: {
          assistant: 0,
          system: 0,
          tool: 0,
          user: 0,
        },
        extensions: {},
        lastAssistantMessageIndex: -1,
        lastUserMessageIndex: -1,
        messageCount: 0,
        tokenEstimate: 0,
        toolCalls: {
          byName: {},
          total: 0,
        },
        toolResults: {
          byName: {},
          total: 0,
        },
        turnBoundaries: [],
      },
      1,
      {
        onError(input) {
          issues.push({
            extensionName: input.extensionName,
            message: input.error.message,
          });
        },
      }
    );

    expect(prompts).toEqual(["Visible prompt"]);
    expect(issues).toEqual([
      {
        extensionName: "broken",
        message: "prompt failed",
      },
    ]);
  });

  test("collectSystemPrompts and intercept hooks preserve extension method receivers", async () => {
    interface ReceiverExtension extends TuvrenExtension {
      afterTurnCalls: number;
      beforeIterationCalls: number;
      beforeTurnCalls: number;
      prompt: string;
    }

    const extension: ReceiverExtension = {
      afterTurn() {
        this.afterTurnCalls += 1;
        return undefined;
      },
      afterTurnCalls: 0,
      beforeIteration() {
        this.beforeIterationCalls += 1;
        return undefined;
      },
      beforeIterationCalls: 0,
      beforeTurn() {
        this.beforeTurnCalls += 1;
        return undefined;
      },
      beforeTurnCalls: 0,
      name: "receiver-aware",
      prompt: "Receiver-aware prompt",
      systemPrompt() {
        return this.prompt;
      },
    };
    const manifest = createContextManifest([]);

    expect(collectSystemPrompts([extension], manifest, 1)).toEqual([
      "Receiver-aware prompt",
    ]);

    await runBeforeTurnHooks({
      emit() {
        return;
      },
      extensions: [extension],
      iterationCount: 0,
      manifest,
      messages: [],
      runId: "run-before-turn",
      turnId: "turn-before-turn",
    });
    await runBeforeIterationHooks({
      emit() {
        return;
      },
      extensions: [extension],
      iterationCount: 1,
      manifest,
      messages: [],
      runId: "run-before-iteration",
      turnId: "turn-before-iteration",
    });
    await runAfterTurnHooks({
      emit() {
        return;
      },
      extensions: [extension],
      iterationCount: 1,
      manifest,
      messages: [],
      runId: "run-after-turn",
      turnId: "turn-after-turn",
    });

    expect(extension.beforeTurnCalls).toBe(1);
    expect(extension.beforeIterationCalls).toBe(1);
    expect(extension.afterTurnCalls).toBe(1);
  });

  test("collectSystemPrompts and hook contexts do not expose live extension state or shared exports", async () => {
    const manifest = {
      byRole: {
        assistant: 0,
        system: 0,
        tool: 0,
        user: 0,
      },
      extensions: {
        exporter: {
          nested: {
            count: 1,
          },
        },
        viewer: {
          local: {
            flag: true,
          },
        },
      },
      lastAssistantMessageIndex: -1,
      lastUserMessageIndex: -1,
      messageCount: 0,
      tokenEstimate: 0,
      toolCalls: {
        byName: {},
        total: 0,
      },
      toolResults: {
        byName: {},
        total: 0,
      },
      turnBoundaries: [],
    } satisfies ContextManifest;

    collectSystemPrompts(
      [
        {
          exports: ["nested"],
          name: "exporter",
        },
        {
          name: "viewer",
          systemPrompt(context) {
            const exportedNested = context.sharedExports.exporter?.nested;

            if (
              exportedNested !== undefined &&
              typeof exportedNested === "object" &&
              exportedNested !== null &&
              "count" in exportedNested
            ) {
              exportedNested.count = 99;
            }

            context.extensionState.local = { flag: false };
            context.manifest.extensions.exporter = {
              nested: {
                count: 100,
              },
            };
            return "Prompt";
          },
        },
      ],
      manifest,
      1
    );

    await runBeforeTurnHooks({
      emit() {
        return;
      },
      extensions: [
        {
          exports: ["nested"],
          name: "exporter",
        },
        {
          beforeTurn(context) {
            const exportedNested = context.sharedExports.exporter?.nested;

            if (
              exportedNested !== undefined &&
              typeof exportedNested === "object" &&
              exportedNested !== null &&
              "count" in exportedNested
            ) {
              exportedNested.count = 77;
            }

            context.extensionState.local = { flag: false };
            context.manifest.extensions.exporter = {
              nested: {
                count: 200,
              },
            };
            return undefined;
          },
          name: "viewer",
        },
      ],
      iterationCount: 0,
      manifest,
      messages: [],
      runId: "run-1",
      turnId: "turn-1",
    });

    expect(manifest.extensions).toEqual({
      exporter: {
        nested: {
          count: 1,
        },
      },
      viewer: {
        local: {
          flag: true,
        },
      },
    });
  });

  test("counts file payload bytes in tokenEstimate", () => {
    const payload = new Uint8Array(4096);
    const manifest = createContextManifest([
      {
        parts: [
          {
            data: payload,
            filename: "attachment.bin",
            mediaType: "application/octet-stream",
            type: "file",
          },
        ],
        role: "user",
      },
    ]);

    expect(manifest.tokenEstimate).toBe(
      Math.ceil(
        (payload.byteLength +
          "attachment.bin".length +
          "application/octet-stream".length) /
          4
      )
    );
  });

  test("deep-clones nested extension state when manifest snapshots are updated", () => {
    const originalManifest = createContextManifest([], {
      budget: {
        limits: {
          tokens: 10,
        },
      },
    });
    const nextManifest = updateContextManifest(originalManifest, []);
    const originalBudget = toOptionalRecord(originalManifest.extensions.budget);
    const originalLimits = toOptionalRecord(originalBudget?.limits);

    if (originalLimits === undefined) {
      throw new Error("expected nested extension state in the source manifest");
    }

    originalLimits.tokens = 99;

    expect(nextManifest.extensions).toEqual({
      budget: {
        limits: {
          tokens: 10,
        },
      },
    });
  });
});
