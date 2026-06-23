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

/**
 * Unit tests for ClientEndpointBoundary — the runtime-side seam for the
 * Tuvren-client execution class (KRT-AZ001 through KRT-AZ005).
 */

import { describe, expect, test } from "bun:test";
import { TuvrenRuntimeError } from "@tuvren/core";
import type {
  AttachedClientEndpoint,
  ClientDispatchResult,
  ClientEndpointBoundary,
  ClientInvocationEnvelope,
  ClientReportedResult,
} from "@tuvren/core/capabilities";
import { CAPABILITY_BINDING_UNAVAILABLE } from "@tuvren/core/errors";
import type { ToolExecutionContext } from "@tuvren/core/tools";
import { createClientEndpointBoundary } from "../src/lib/client-endpoint-boundary.ts";
import { buildClientEndpointTools } from "../src/lib/tool-registry.ts";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeEndpoint(
  endpointId: string,
  capabilities: string[],
  handler?: (
    envelope: ClientInvocationEnvelope
  ) => Promise<ClientReportedResult>
): AttachedClientEndpoint {
  return {
    endpointId,
    advertisedCapabilities: capabilities.map((id) => ({
      capabilityId: id,
      description: `${id} description`,
      inputSchema: { type: "object" },
    })),
    dispatch(
      envelope: ClientInvocationEnvelope
    ): Promise<ClientReportedResult> {
      if (handler !== undefined) {
        return handler(envelope);
      }
      return Promise.resolve({
        callId: envelope.callId,
        content: {
          result: `${envelope.capabilityId}-result`,
          input: envelope.input,
        },
        leaseToken: envelope.leaseToken,
      });
    },
  };
}

function makeClientMcpEndpoint(
  endpointId: string,
  capabilityId: string,
  mcpServerName: string
): AttachedClientEndpoint {
  return {
    endpointId,
    advertisedCapabilities: [
      {
        capabilityId,
        description: "client-side MCP tool",
        inputSchema: { type: "object" },
        mcpServerName,
      },
    ],
    dispatch(
      envelope: ClientInvocationEnvelope
    ): Promise<ClientReportedResult> {
      return Promise.resolve({
        callId: envelope.callId,
        content: { mcpResult: true },
        leaseToken: envelope.leaseToken,
      });
    },
  };
}

// ---------------------------------------------------------------------------
// KRT-AZ001: Attachment seam and lease model
// ---------------------------------------------------------------------------

describe("ClientEndpointBoundary — attachment and availability (KRT-AZ001)", () => {
  test("isAvailable returns true for a registered capability", () => {
    const boundary = createClientEndpointBoundary([
      makeEndpoint("ep1", ["web.search", "code.run"]),
    ]);
    expect(boundary.isAvailable("web.search")).toBe(true);
    expect(boundary.isAvailable("code.run")).toBe(true);
  });

  test("isAvailable returns false for an unregistered capability", () => {
    const boundary = createClientEndpointBoundary([
      makeEndpoint("ep1", ["web.search"]),
    ]);
    expect(boundary.isAvailable("unknown.tool")).toBe(false);
  });

  test("isAvailable returns false when no endpoints are attached", () => {
    const boundary = createClientEndpointBoundary([]);
    expect(boundary.isAvailable("web.search")).toBe(false);
  });

  test("capabilities from multiple endpoints are all available", () => {
    const boundary = createClientEndpointBoundary([
      makeEndpoint("ep1", ["web.search"]),
      makeEndpoint("ep2", ["code.run", "file.read"]),
    ]);
    expect(boundary.isAvailable("web.search")).toBe(true);
    expect(boundary.isAvailable("code.run")).toBe(true);
    expect(boundary.isAvailable("file.read")).toBe(true);
  });

  test("throws when two endpoints advertise the same capabilityId", () => {
    expect(() =>
      createClientEndpointBoundary([
        makeEndpoint("ep1", ["shared.tool"]),
        makeEndpoint("ep2", ["shared.tool"]),
      ])
    ).toThrow(TuvrenRuntimeError);
  });
});

// ---------------------------------------------------------------------------
// KRT-AZ003: detach makes capabilities unavailable
// ---------------------------------------------------------------------------

describe("ClientEndpointBoundary — detach (KRT-AZ003)", () => {
  test("isAvailable returns false after detach", () => {
    const boundary = createClientEndpointBoundary([
      makeEndpoint("ep1", ["web.search", "code.run"]),
    ]);
    expect(boundary.isAvailable("web.search")).toBe(true);
    boundary.detach("ep1");
    expect(boundary.isAvailable("web.search")).toBe(false);
    expect(boundary.isAvailable("code.run")).toBe(false);
  });

  test("detach only removes capabilities from the specified endpoint", () => {
    const boundary = createClientEndpointBoundary([
      makeEndpoint("ep1", ["web.search"]),
      makeEndpoint("ep2", ["code.run"]),
    ]);
    boundary.detach("ep1");
    expect(boundary.isAvailable("web.search")).toBe(false);
    expect(boundary.isAvailable("code.run")).toBe(true);
  });

  test("dispatch throws capability_binding_unavailable after detach", async () => {
    const boundary = createClientEndpointBoundary([
      makeEndpoint("ep1", ["web.search"]),
    ]);
    boundary.detach("ep1");
    await expect(
      boundary.dispatch("web.search", "call-1", {})
    ).rejects.toMatchObject({ code: CAPABILITY_BINDING_UNAVAILABLE });
  });

  test("detach of unknown endpointId is a no-op", () => {
    const boundary = createClientEndpointBoundary([
      makeEndpoint("ep1", ["web.search"]),
    ]);
    boundary.detach("unknown-ep");
    expect(boundary.isAvailable("web.search")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// KRT-AZ001: Binding resolution
// ---------------------------------------------------------------------------

describe("ClientEndpointBoundary — binding resolution (KRT-AZ001)", () => {
  test("resolveBinding returns a tuvren-client / client-endpoint binding", () => {
    const boundary = createClientEndpointBoundary([
      makeEndpoint("ep1", ["web.search"]),
    ]);
    const binding = boundary.resolveBinding("web.search");
    expect(binding).not.toBeUndefined();
    expect(binding?.executionClass).toBe("tuvren-client");
    expect(binding?.endpoint.kind).toBe("client-endpoint");
    expect(binding?.capabilityId).toBe("web.search");
  });

  test("resolveBinding returns undefined for an unregistered capability", () => {
    const boundary = createClientEndpointBoundary([
      makeEndpoint("ep1", ["web.search"]),
    ]);
    expect(boundary.resolveBinding("unknown")).toBeUndefined();
  });

  test("binding endpoint id encodes the endpoint id", () => {
    const boundary = createClientEndpointBoundary([
      makeEndpoint("my-browser-ext", ["browser.dom"]),
    ]);
    const binding = boundary.resolveBinding("browser.dom");
    expect(binding?.endpoint.id).toContain("my-browser-ext");
  });
});

// ---------------------------------------------------------------------------
// KRT-AZ002: Dispatch and result capture
// ---------------------------------------------------------------------------

describe("ClientEndpointBoundary — dispatch and result capture (KRT-AZ002)", () => {
  test("dispatch returns the client-reported content on success", async () => {
    const boundary = createClientEndpointBoundary([
      makeEndpoint("ep1", ["web.search"], async (envelope) => ({
        callId: envelope.callId,
        content: { hits: ["result1", "result2"] },
        leaseToken: envelope.leaseToken,
      })),
    ]);
    const result = await boundary.dispatch("web.search", "call-123", {
      query: "bun",
    });
    expect(result).not.toBeNull();
    expect(result?.content).toEqual({ hits: ["result1", "result2"] });
    expect(result?.isError).toBe(false);
  });

  test("dispatch sends the correct callId and input in the envelope", async () => {
    const received: ClientInvocationEnvelope[] = [];
    const boundary = createClientEndpointBoundary([
      makeEndpoint("ep1", ["search"], (envelope) => {
        received.push(envelope);
        return Promise.resolve({
          callId: envelope.callId,
          content: "ok",
          leaseToken: envelope.leaseToken,
        });
      }),
    ]);
    await boundary.dispatch("search", "call-xyz", { q: "hello" });
    expect(received).toHaveLength(1);
    expect(received[0]?.callId).toBe("call-xyz");
    expect(received[0]?.capabilityId).toBe("search");
    expect(received[0]?.input).toEqual({ q: "hello" });
  });

  test("dispatch surfaces isError:true when the client reports an error", async () => {
    const boundary = createClientEndpointBoundary([
      makeEndpoint("ep1", ["risky.op"], async (envelope) => ({
        callId: envelope.callId,
        content: { error: "client failed" },
        isError: true,
        leaseToken: envelope.leaseToken,
      })),
    ]);
    const result = await boundary.dispatch("risky.op", "call-err", {});
    expect(result?.isError).toBe(true);
    expect(result?.content).toEqual({ error: "client failed" });
  });

  test("dispatch throws capability_binding_unavailable when no endpoint is attached", async () => {
    const boundary = createClientEndpointBoundary([]);
    await expect(
      boundary.dispatch("web.search", "call-1", {})
    ).rejects.toMatchObject({
      code: CAPABILITY_BINDING_UNAVAILABLE,
    });
  });

  test("dispatch throws TuvrenRuntimeError with capability_binding_unavailable code", async () => {
    const boundary = createClientEndpointBoundary([makeEndpoint("ep1", ["a"])]);
    let thrown: unknown;
    try {
      await boundary.dispatch("b", "call-1", {});
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(TuvrenRuntimeError);
    expect((thrown as TuvrenRuntimeError).code).toBe(
      CAPABILITY_BINDING_UNAVAILABLE
    );
  });
});

// ---------------------------------------------------------------------------
// KRT-AZ003: Staleness — stale late-completion handling
// ---------------------------------------------------------------------------

describe("ClientEndpointBoundary — staleness handling (KRT-AZ003)", () => {
  test("dispatch returns null when the client echoes back a mismatched leaseToken", async () => {
    const boundary = createClientEndpointBoundary([
      makeEndpoint("ep1", ["search"], (envelope) =>
        Promise.resolve({
          callId: envelope.callId,
          content: { staleResult: true },
          leaseToken: "wrong-token-from-previous-invocation", // stale
        })
      ),
    ]);
    const result = await boundary.dispatch("search", "call-fresh", {});
    expect(result).toBeNull();
  });

  test("dispatch returns null when the client echoes back a mismatched callId", async () => {
    const boundary = createClientEndpointBoundary([
      makeEndpoint("ep1", ["search"], (envelope) =>
        Promise.resolve({
          callId: "wrong-call-id", // mismatch
          content: { staleResult: true },
          leaseToken: envelope.leaseToken, // token matches, but callId doesn't
        })
      ),
    ]);
    const result = await boundary.dispatch("search", "call-fresh", {});
    expect(result).toBeNull();
  });

  test("dispatch returns the result when the client echoes the correct leaseToken", async () => {
    const boundary = createClientEndpointBoundary([
      makeEndpoint("ep1", ["search"], async (envelope) => ({
        callId: envelope.callId,
        content: { ok: true },
        leaseToken: envelope.leaseToken, // correct echo
      })),
    ]);
    const result = await boundary.dispatch("search", "call-normal", {});
    expect(result).not.toBeNull();
    expect(result?.content).toEqual({ ok: true });
  });

  test("a thrown endpoint rejection is caught and returned as an isError result", async () => {
    const boundary = createClientEndpointBoundary([
      makeEndpoint("ep1", ["search"], () =>
        Promise.reject(new Error("network failure"))
      ),
    ]);
    const result = await boundary.dispatch("search", "call-throw", {});
    expect(result).not.toBeNull();
    expect(result?.isError).toBe(true);
    const content = result?.content as Record<string, unknown> | undefined;
    expect(typeof content?.error).toBe("string");
  });

  test("each dispatch generates a unique leaseToken so stale cross-call results are detected", async () => {
    const tokens: string[] = [];
    const boundary = createClientEndpointBoundary([
      makeEndpoint("ep1", ["search"], (envelope) => {
        tokens.push(envelope.leaseToken);
        return Promise.resolve({
          callId: envelope.callId,
          content: {},
          leaseToken: envelope.leaseToken,
        });
      }),
    ]);
    await boundary.dispatch("search", "call-1", {});
    await boundary.dispatch("search", "call-2", {});
    expect(tokens[0]).not.toBe(tokens[1]);
  });
});

// ---------------------------------------------------------------------------
// KRT-BG003: Side-effect-once idempotency envelope (ADR-052)
// ---------------------------------------------------------------------------

describe("ClientEndpointBoundary — idempotency envelope (KRT-BG003)", () => {
  test("dispatch carries the supplied idempotency identity on the envelope", async () => {
    const received: ClientInvocationEnvelope[] = [];
    const boundary = createClientEndpointBoundary([
      makeEndpoint("ep1", ["charge.card"], (envelope) => {
        received.push(envelope);
        return Promise.resolve({
          callId: envelope.callId,
          content: { ok: true },
          leaseToken: envelope.leaseToken,
        });
      }),
    ]);

    await boundary.dispatch("charge.card", "call-1", { amount: 10 }, "idem-1");

    expect(received).toHaveLength(1);
    expect(received[0]?.idempotencyKey).toBe("idem-1");
    // The lease token (staleness) and the idempotency key (external dedup) are
    // distinct concerns and both ride the envelope.
    expect(typeof received[0]?.leaseToken).toBe("string");
  });

  test("omits the idempotency key from the envelope when none is supplied", async () => {
    const received: ClientInvocationEnvelope[] = [];
    const boundary = createClientEndpointBoundary([
      makeEndpoint("ep1", ["search"], (envelope) => {
        received.push(envelope);
        return Promise.resolve({
          callId: envelope.callId,
          content: {},
          leaseToken: envelope.leaseToken,
        });
      }),
    ]);

    await boundary.dispatch("search", "call-1", {});

    expect(received).toHaveLength(1);
    expect(received[0]?.idempotencyKey).toBeUndefined();
  });

  test("the synthetic client tool forwards context.idempotencyKey to the boundary", async () => {
    const dispatchedKeys: Array<string | undefined> = [];
    const recordingBoundary: ClientEndpointBoundary = {
      detach: () => undefined,
      dispatch: (
        _capabilityId: string,
        _callId: string,
        _input: unknown,
        idempotencyKey?: string
      ): Promise<ClientDispatchResult | null> => {
        dispatchedKeys.push(idempotencyKey);
        return Promise.resolve({ content: { ok: true }, isError: false });
      },
      isAvailable: () => true,
      resolveBinding: () => undefined,
    };

    const [tool] = buildClientEndpointTools(
      [makeEndpoint("ep1", ["charge.card"])],
      recordingBoundary
    );
    const context = {
      callId: "call-1",
      idempotencyKey: "idem-from-context",
      name: "charge.card",
    } as ToolExecutionContext;

    await tool.execute({ amount: 10 }, context);

    expect(dispatchedKeys).toEqual(["idem-from-context"]);
  });
});

// ---------------------------------------------------------------------------
// KRT-AZ004: Client-side MCP binding
// ---------------------------------------------------------------------------

describe("ClientEndpointBoundary — client-side MCP binding (KRT-AZ004)", () => {
  test("a client-side MCP capability resolves to tuvren-client / mcp-server binding", () => {
    const boundary = createClientEndpointBoundary([
      makeClientMcpEndpoint("my-ext", "shopify.search_products", "shopify"),
    ]);
    const binding = boundary.resolveBinding("shopify.search_products");
    expect(binding?.executionClass).toBe("tuvren-client");
    expect(binding?.endpoint.kind).toBe("mcp-server");
  });

  test("client-side MCP binding endpoint id encodes the MCP server name", () => {
    const boundary = createClientEndpointBoundary([
      makeClientMcpEndpoint("ext1", "my.tool", "my-mcp-server"),
    ]);
    const binding = boundary.resolveBinding("my.tool");
    expect(binding?.endpoint.id).toContain("my-mcp-server");
  });

  test("client-side MCP dispatch goes through the client endpoint dispatch path", async () => {
    const dispatchedEnvelopes: ClientInvocationEnvelope[] = [];
    const endpoint: AttachedClientEndpoint = {
      endpointId: "ext1",
      advertisedCapabilities: [
        {
          capabilityId: "remote.tool",
          description: "client mcp",
          inputSchema: { type: "object" },
          mcpServerName: "remote-mcp",
        },
      ],
      dispatch(envelope) {
        dispatchedEnvelopes.push(envelope);
        return Promise.resolve({
          callId: envelope.callId,
          content: { mcpOk: true },
          leaseToken: envelope.leaseToken,
        });
      },
    };
    const boundary = createClientEndpointBoundary([endpoint]);
    const result = await boundary.dispatch("remote.tool", "call-mcp", {});
    expect(result?.content).toEqual({ mcpOk: true });
    expect(dispatchedEnvelopes).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Binding resolver integration — tuvren-client tools detected by metadata
// ---------------------------------------------------------------------------

describe("isClientEndpointTool via binding resolver (KRT-AZ001, KRT-AZ004)", () => {
  test("resolveFromToolDefinition returns tuvren-client for a tool with clientEndpointId metadata", () => {
    const { createBindingResolver } = require("../src/lib/binding-resolver.ts");
    const resolver = createBindingResolver();
    const binding = resolver.resolveFromToolDefinition({
      name: "my.cap",
      description: "client cap",
      inputSchema: { type: "object" },
      execute: () => Promise.resolve(undefined),
      metadata: { clientEndpointId: "ep1" },
    });
    expect(binding.executionClass).toBe("tuvren-client");
    expect(binding.endpoint.kind).toBe("client-endpoint");
  });

  test("resolveFromToolDefinition returns tuvren-client/mcp-server for a client-side MCP tool", () => {
    const { createBindingResolver } = require("../src/lib/binding-resolver.ts");
    const resolver = createBindingResolver();
    const binding = resolver.resolveFromToolDefinition({
      name: "mcp.tool",
      description: "client mcp tool",
      inputSchema: { type: "object" },
      execute: () => Promise.resolve(undefined),
      metadata: { clientEndpointId: "ep1", mcpServerName: "my-server" },
    });
    expect(binding.executionClass).toBe("tuvren-client");
    expect(binding.endpoint.kind).toBe("mcp-server");
  });
});
