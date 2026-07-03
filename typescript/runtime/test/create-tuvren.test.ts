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
import type { RuntimeRunnerFactory as KrakenRunnerFactory } from "@tuvren/core/runner";
import type { TuvrenToolDefinition } from "@tuvren/core/tools";
import type { RuntimeBackend } from "@tuvren/kernel-protocol";
import { createRuntimeKernel } from "@tuvren/kernel-runtime";
import {
  createTuvren,
  type McpToolSource,
  type TuvrenInstance,
} from "../src/index.ts";

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

function makeMinimalRunnerFactory(id = "test-driver"): KrakenRunnerFactory {
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

// ── Shared helper ─────────────────────────────────────────────────────────────

async function createThreadAndVerify(instance: TuvrenInstance): Promise<void> {
  const { threadId } = await instance.runtime.createThread({});
  expect(typeof threadId).toBe("string");
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("createTuvren", () => {
  // ── backend option ─────────────────────────────────────────────────────────

  describe("backend option", () => {
    test("'memory' string constructs a working runtime", async () => {
      const instance = await createTuvren({ backend: "memory" });
      await createThreadAndVerify(instance);
      await instance[Symbol.asyncDispose]();
    });

    test("{ kind: 'memory' } object form constructs a working runtime", async () => {
      const instance = await createTuvren({ backend: { kind: "memory" } });
      await createThreadAndVerify(instance);
      await instance[Symbol.asyncDispose]();
    });

    test("{ kind: 'memory', options: {} } with explicit empty options constructs a working runtime", async () => {
      const instance = await createTuvren({
        backend: { kind: "memory", options: {} },
      });
      await createThreadAndVerify(instance);
      await instance[Symbol.asyncDispose]();
    });

    test("explicit RuntimeBackend instance is accepted as the kernel backend", async () => {
      const { backend, closed } = makeMockBackend();
      const instance = await createTuvren({ backend });
      await createThreadAndVerify(instance);
      await instance[Symbol.asyncDispose]();
      // Ownership: createTuvren closes the caller-provided backend on dispose
      expect(closed.count).toBe(1);
    });

    test("{ kind: 'sqlite' } without options throws TuvrenValidationError before touching sqlite", () => {
      // The throw is synchronous (createTuvren is not async); it happens before
      // any sqlite backend construction, so this is safe to run under Bun.
      expect(() =>
        createTuvren({
          backend: { kind: "sqlite" } as Parameters<
            typeof createTuvren
          >[0]["backend"],
        })
      ).toThrow(TuvrenValidationError);
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
        createTuvren({
          backend: "memory",
          runtimeOptions: { telemetry },
          telemetry,
        })
      ).toThrow(TuvrenValidationError);
    });

    test("rejects supplying both top-level and runtimeOptions bounds (KRT-BD006)", () => {
      expect(() =>
        createTuvren({
          backend: "memory",
          bounds: { maxIterations: 8 },
          runtimeOptions: { bounds: { maxIterations: 16 } },
        })
      ).toThrow(TuvrenValidationError);
    });

    test("pre-built kernel is used — threads created via the runtime appear in the kernel", async () => {
      const backend = createMemoryBackend();
      const kernel = createRuntimeKernel({ backend });

      const instance = await createTuvren({
        backend: "memory", // redundant spec; must be ignored when kernel is provided
        kernel,
      });

      const { threadId } = await instance.runtime.createThread({});
      const { threads } = await kernel.thread.list({});
      expect(threads.some((t) => t.threadId === threadId)).toBe(true);

      await instance[Symbol.asyncDispose]();
    });

    test("provided kernel is exposed on the TuvrenInstance", async () => {
      const kernel = createRuntimeKernel({ backend: createMemoryBackend() });
      const instance = await createTuvren({ backend: "memory", kernel });
      expect(instance.kernel).toBe(kernel);
      await instance[Symbol.asyncDispose]();
    });

    test("backend close() is not called when kernel is provided", async () => {
      const { backend, closed } = makeMockBackend();
      const kernel = createRuntimeKernel({ backend: createMemoryBackend() });

      // Pass the mock as the backend spec AND separately provide a kernel.
      // The factory should skip buildBackend → close() never called.
      const instance = await createTuvren({ backend, kernel });
      await instance[Symbol.asyncDispose]();
      expect(closed.count).toBe(0);
    });
  });

  // ── driver option ──────────────────────────────────────────────────────────

  describe("driver option", () => {
    test("defaults to the react driver when driver is omitted", async () => {
      const instance = await createTuvren({ backend: "memory" });
      expect(instance.runtime).toBeDefined();
      expect(instance.orchestration).toBeDefined();
      await instance[Symbol.asyncDispose]();
    });

    test("'react' string is accepted", async () => {
      const instance = await createTuvren({
        backend: "memory",
        driver: "react",
      });
      expect(instance.runtime).toBeDefined();
      await instance[Symbol.asyncDispose]();
    });

    test("{ kind: 'react' } object form is accepted", async () => {
      const instance = await createTuvren({
        backend: "memory",
        driver: { kind: "react" },
      });
      expect(instance.runtime).toBeDefined();
      await instance[Symbol.asyncDispose]();
    });

    test("{ kind: 'react', options: { providerCallMode: 'generate' } } is accepted", async () => {
      const instance = await createTuvren({
        backend: "memory",
        driver: { kind: "react", options: { providerCallMode: "generate" } },
      });
      expect(instance.runtime).toBeDefined();
      await instance[Symbol.asyncDispose]();
    });

    test("explicit RuntimeRunnerFactory is accepted", async () => {
      const factory = makeMinimalRunnerFactory("custom");
      const instance = await createTuvren({
        backend: "memory",
        driver: factory,
      });
      await createThreadAndVerify(instance);
      await instance[Symbol.asyncDispose]();
    });
  });

  // ── tools option ──────────────────────────────────────────────────────────

  describe("tools option", () => {
    test("McpToolSource.close() is called on disposal", async () => {
      const source = makeMockMcpSource("my-server");
      const instance = await createTuvren({
        backend: "memory",
        tools: [source],
      });

      expect(source.closed.count).toBe(0);
      await instance[Symbol.asyncDispose]();
      expect(source.closed.count).toBe(1);
    });

    test("multiple McpToolSources all have close() called on disposal", async () => {
      const sources = [makeMockMcpSource("s1"), makeMockMcpSource("s2")];
      const instance = await createTuvren({
        backend: "memory",
        tools: sources,
      });

      await instance[Symbol.asyncDispose]();
      for (const s of sources) {
        expect(s.closed.count).toBe(1);
      }
    });

    test("mixed McpToolSources and TuvrenToolDefinitions are accepted", async () => {
      const source = makeMockMcpSource();
      const tool = makeMinimalTool("echo");
      const instance = await createTuvren({
        backend: "memory",
        tools: [source, tool],
      });

      await instance[Symbol.asyncDispose]();
      expect(source.closed.count).toBe(1);
    });

    test("empty tools array is accepted", async () => {
      const instance = await createTuvren({ backend: "memory", tools: [] });
      await createThreadAndVerify(instance);
      await instance[Symbol.asyncDispose]();
    });
  });

  // ── [Symbol.asyncDispose] ─────────────────────────────────────────────────

  describe("[Symbol.asyncDispose]", () => {
    test("backend close() is called once on dispose when an explicit RuntimeBackend is passed", async () => {
      const { backend, closed } = makeMockBackend();
      const instance = await createTuvren({ backend });
      expect(closed.count).toBe(0);
      await instance[Symbol.asyncDispose]();
      expect(closed.count).toBe(1);
    });

    test("dispose resolves cleanly when called with default 'memory' backend", async () => {
      const instance = await createTuvren({ backend: "memory" });
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

      const instance = await createTuvren({
        backend: makeThrowingBackend(),
        tools: [throwingSource],
      });

      const err = await instance[Symbol.asyncDispose]().catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain("mcp close error");
      expect((err as Error).message).toContain("backend close error");
    });

    test("await using disposes the instance when the scope exits", async () => {
      const { backend, closed } = makeMockBackend();
      {
        await using _tuvren = await createTuvren({ backend });
        expect(closed.count).toBe(0);
      }
      expect(closed.count).toBe(1);
    });
  });

  // ── TuvrenInstance shape ──────────────────────────────────────────────────

  describe("TuvrenInstance shape", () => {
    test("exposes runtime, orchestration, kernel, and asyncDispose", async () => {
      const instance = await createTuvren({ backend: "memory" });
      expect(instance.runtime).toBeDefined();
      expect(instance.orchestration).toBeDefined();
      expect(instance.kernel).toBeDefined();
      expect(typeof instance[Symbol.asyncDispose]).toBe("function");
      await instance[Symbol.asyncDispose]();
    });

    test("provider is absent when not supplied", async () => {
      const instance = await createTuvren({ backend: "memory" });
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
      } as unknown as Parameters<typeof createTuvren>[0]["provider"];

      const instance = await createTuvren({
        backend: "memory",
        provider: fakeProvider,
      });

      expect(instance.provider).toBe(fakeProvider);
      await instance[Symbol.asyncDispose]();
    });
  });
});
