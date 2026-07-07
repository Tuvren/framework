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
import { createMemoryBackend } from "@tuvren/backend-memory";
import { TuvrenValidationError } from "@tuvren/core";
import type { RuntimeRunnerFactory } from "@tuvren/core/runner";
import type { TuvrenToolDefinition } from "@tuvren/core/tools";
import type { RuntimeBackend } from "@tuvren/kernel-protocol";
import { createRuntimeKernel } from "@tuvren/kernel-runtime";
import {
  type CreateTuvrenOptions,
  createTuvren,
  type McpToolSource,
  type TuvrenInstance,
} from "../src/index.js";

// ADR-057: `createTuvren` accepts constructed instances only — no string-kind
// backend/runner shorthands and no implicit default runner. These tests exercise
// that instances-only contract on the @tuvren/sdk composition surface.

// ── Test doubles ─────────────────────────────────────────────────────────────

function makeMockBackend(): {
  backend: RuntimeBackend & { close(): Promise<void> };
  closed: { count: number };
} {
  const inner = createMemoryBackend();
  const closed = { count: 0 };
  const backend = Object.assign(inner, {
    close() {
      closed.count++;
      return Promise.resolve();
    },
  });
  return { backend, closed };
}

function makeThrowingBackend(): RuntimeBackend & { close(): Promise<void> } {
  const inner = createMemoryBackend();
  return Object.assign(inner, {
    close(): Promise<void> {
      return Promise.reject(new Error("backend close error"));
    },
  });
}

function makeMockMcpSource(name = "test-server"): McpToolSource & {
  closed: { count: number };
} {
  const closed = { count: 0 };
  return {
    closed,
    close() {
      closed.count++;
      return Promise.resolve();
    },
    refresh() {
      return Promise.resolve({ tools: [] });
    },
    serverName: name,
    tools: [],
  };
}

function makeMinimalRunnerFactory(id = "test-runner"): RuntimeRunnerFactory {
  return {
    create() {
      return {
        execute() {
          return Promise.resolve({
            messages: [],
            resolution: { reason: "done", type: "end_turn" },
          });
        },
        id,
        resume() {
          return Promise.reject(new Error("resume not expected"));
        },
      };
    },
    id,
  };
}

function makeMinimalTool(name = "test-tool"): TuvrenToolDefinition {
  return {
    description: "A test tool",
    execute(_input: unknown) {
      return { ok: true };
    },
    inputSchema: { properties: {}, type: "object" },
    name,
  };
}

/**
 * The instances-only base options: a fresh memory backend and a minimal runner
 * factory. Spread overrides on top for the field under test.
 */
function baseOptions(
  overrides?: Partial<CreateTuvrenOptions>
): CreateTuvrenOptions {
  return {
    backend: createMemoryBackend(),
    runner: makeMinimalRunnerFactory(),
    ...overrides,
  };
}

// ── Shared helper ─────────────────────────────────────────────────────────────

async function createThreadAndVerify(instance: TuvrenInstance): Promise<void> {
  const { threadId } = await instance.runtime.createThread({});
  expect(typeof threadId).toBe("string");
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("createTuvren", () => {
  // ── backend option (instances only) ─────────────────────────────────────────

  describe("backend option", () => {
    test("a constructed backend instance constructs a working runtime", async () => {
      const instance = await createTuvren(baseOptions());
      await createThreadAndVerify(instance);
      await instance[Symbol.asyncDispose]();
    });

    test("createTuvren takes ownership: the backend is closed on dispose", async () => {
      const { backend, closed } = makeMockBackend();
      const instance = await createTuvren(baseOptions({ backend }));
      await createThreadAndVerify(instance);
      await instance[Symbol.asyncDispose]();
      expect(closed.count).toBe(1);
    });
  });

  // ── kernel option ──────────────────────────────────────────────────────────

  describe("kernel option", () => {
    test("rejects duplicate top-level and runtimeOptions telemetry sinks", () => {
      const telemetry = {
        event() {
          return undefined;
        },
        span() {
          return undefined;
        },
      };

      expect(() =>
        createTuvren(baseOptions({ runtimeOptions: { telemetry }, telemetry }))
      ).toThrow(TuvrenValidationError);
    });

    test("rejects supplying both top-level and runtimeOptions bounds (KRT-BD006)", () => {
      expect(() =>
        createTuvren(
          baseOptions({
            bounds: { maxIterations: 8 },
            runtimeOptions: { bounds: { maxIterations: 16 } },
          })
        )
      ).toThrow(TuvrenValidationError);
    });

    test("pre-built kernel is used — threads created via the runtime appear in the kernel", async () => {
      const backend = createMemoryBackend();
      const kernel = createRuntimeKernel({ backend });

      const instance = await createTuvren(
        // The backend field is still required by the type; it is ignored when a
        // kernel is supplied (the kernel already owns its substrate).
        baseOptions({ kernel })
      );

      const { threadId } = await instance.runtime.createThread({});
      const { threads } = await kernel.thread.list({});
      expect(threads.some((t) => t.threadId === threadId)).toBe(true);

      await instance[Symbol.asyncDispose]();
    });

    test("provided kernel is exposed on the TuvrenInstance", async () => {
      const kernel = createRuntimeKernel({ backend: createMemoryBackend() });
      const instance = await createTuvren(baseOptions({ kernel }));
      expect(instance.kernel).toBe(kernel);
      await instance[Symbol.asyncDispose]();
    });

    test("backend close() is not called when kernel is provided", async () => {
      const { backend, closed } = makeMockBackend();
      const kernel = createRuntimeKernel({ backend: createMemoryBackend() });

      // Pass the mock as the backend AND separately provide a kernel. The factory
      // skips backend construction/ownership → close() is never called.
      const instance = await createTuvren(baseOptions({ backend, kernel }));
      await instance[Symbol.asyncDispose]();
      expect(closed.count).toBe(0);
    });
  });

  // ── runner option (instances only) ───────────────────────────────────────────

  describe("runner option", () => {
    test("an explicit RuntimeRunnerFactory is accepted and drives the default agent", async () => {
      const factory = makeMinimalRunnerFactory("custom");
      const instance = await createTuvren(baseOptions({ runner: factory }));
      await createThreadAndVerify(instance);
      expect(instance.runtime).toBeDefined();
      expect(instance.orchestration).toBeDefined();
      await instance[Symbol.asyncDispose]();
    });
  });

  // ── tools option ──────────────────────────────────────────────────────────

  describe("tools option", () => {
    test("McpToolSource.close() is called on disposal", async () => {
      const source = makeMockMcpSource("my-server");
      const instance = await createTuvren(baseOptions({ tools: [source] }));

      expect(source.closed.count).toBe(0);
      await instance[Symbol.asyncDispose]();
      expect(source.closed.count).toBe(1);
    });

    test("multiple McpToolSources all have close() called on disposal", async () => {
      const sources = [makeMockMcpSource("s1"), makeMockMcpSource("s2")];
      const instance = await createTuvren(baseOptions({ tools: sources }));

      await instance[Symbol.asyncDispose]();
      for (const s of sources) {
        expect(s.closed.count).toBe(1);
      }
    });

    test("mixed McpToolSources and TuvrenToolDefinitions are accepted", async () => {
      const source = makeMockMcpSource();
      const tool = makeMinimalTool("echo");
      const instance = await createTuvren(
        baseOptions({ tools: [source, tool] })
      );

      await instance[Symbol.asyncDispose]();
      expect(source.closed.count).toBe(1);
    });

    test("empty tools array is accepted", async () => {
      const instance = await createTuvren(baseOptions({ tools: [] }));
      await createThreadAndVerify(instance);
      await instance[Symbol.asyncDispose]();
    });
  });

  // ── [Symbol.asyncDispose] ─────────────────────────────────────────────────

  describe("[Symbol.asyncDispose]", () => {
    test("backend close() is called once on dispose when a closeable backend is passed", async () => {
      const { backend, closed } = makeMockBackend();
      const instance = await createTuvren(baseOptions({ backend }));
      expect(closed.count).toBe(0);
      await instance[Symbol.asyncDispose]();
      expect(closed.count).toBe(1);
    });

    test("dispose resolves cleanly with a plain memory backend", async () => {
      const instance = await createTuvren(baseOptions());
      await expect(instance[Symbol.asyncDispose]()).resolves.toBeUndefined();
    });

    test("disposal error aggregation: errors from MCP source and backend are joined into one Error", async () => {
      const throwingSource: McpToolSource = {
        close() {
          return Promise.reject(new Error("mcp close error"));
        },
        refresh() {
          return Promise.resolve({ tools: [] });
        },
        serverName: "throwing-server",
        tools: [],
      };

      const instance = await createTuvren(
        baseOptions({ backend: makeThrowingBackend(), tools: [throwingSource] })
      );

      const err = await instance[Symbol.asyncDispose]().catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain("mcp close error");
      expect((err as Error).message).toContain("backend close error");
    });

    test("await using disposes the instance when the scope exits", async () => {
      const { backend, closed } = makeMockBackend();
      {
        await using _tuvren = await createTuvren(baseOptions({ backend }));
        expect(closed.count).toBe(0);
      }
      expect(closed.count).toBe(1);
    });
  });

  // ── TuvrenInstance shape ──────────────────────────────────────────────────

  describe("TuvrenInstance shape", () => {
    test("exposes runtime, orchestration, kernel, and asyncDispose", async () => {
      const instance = await createTuvren(baseOptions());
      expect(instance.runtime).toBeDefined();
      expect(instance.orchestration).toBeDefined();
      expect(instance.kernel).toBeDefined();
      expect(typeof instance[Symbol.asyncDispose]).toBe("function");
      await instance[Symbol.asyncDispose]();
    });

    test("provider is absent when not supplied", async () => {
      const instance = await createTuvren(baseOptions());
      expect(instance.provider).toBeUndefined();
      await instance[Symbol.asyncDispose]();
    });

    test("provider field is present when supplied", async () => {
      // A minimal stub — createTuvren only stores it in the instance and the
      // default AgentConfig; no actual calls are made here.
      const fakeProvider = {
        generate: () => {
          throw new Error("not called in this test");
        },
        id: "fake-provider",
      } as unknown as CreateTuvrenOptions["provider"];

      const instance = await createTuvren(
        baseOptions({ provider: fakeProvider })
      );

      expect(instance.provider).toBe(fakeProvider);
      await instance[Symbol.asyncDispose]();
    });
  });
});
