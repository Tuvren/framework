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

import { TuvrenRuntimeError } from "@tuvren/core";
import type {
  AttachedClientEndpoint,
  ClientDispatchResult,
  ClientEndpointBoundary,
} from "@tuvren/core/capabilities";
import {
  CAPABILITY_BINDING_UNAVAILABLE,
  CAPABILITY_RESULT_STALE,
} from "@tuvren/core/errors";
import type { TuvrenExtension } from "@tuvren/core/extensions";
import type { TuvrenJsonSchema } from "@tuvren/core/messages";
import {
  assertTuvrenToolDefinition,
  type CustomSchema,
  type RenderedToolDefinition,
  type ToolRegistry,
  type TuvrenToolDefinition,
} from "@tuvren/core/tools";
import { cloneSnapshotPreservingFunctions } from "./runtime-core-shared.js";

/**
 * Map-backed `ToolRegistry` implementation (framework spec §8.5).
 *
 * Definitions are defensively cloned (preserving functions) on `register`,
 * `get`, and `list`, so neither the registering caller nor consumers can
 * mutate the registry's stored definition in place. Duplicate names are
 * rejected at registration time. `resolve` is the runtime-internal fast path
 * that returns the stored definition without an extra per-invocation clone.
 */
class BasicToolRegistry implements ToolRegistry {
  private readonly tools = new Map<string, TuvrenToolDefinition>();

  get(name: string): TuvrenToolDefinition | undefined {
    const tool = this.resolve(name);

    if (tool === undefined) {
      return undefined;
    }

    return cloneToolDefinition(tool);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): TuvrenToolDefinition[] {
    return [...this.tools.values()].map((tool) => cloneToolDefinition(tool));
  }

  register(tool: TuvrenToolDefinition): void {
    assertTuvrenToolDefinition(tool, "tool");

    if (this.tools.has(tool.name)) {
      throw new TuvrenRuntimeError(
        `tool "${tool.name}" is already registered`,
        {
          code: "duplicate_tool_registration",
          details: {
            toolName: tool.name,
          },
        }
      );
    }

    this.tools.set(tool.name, cloneToolDefinition(tool));
  }

  toDefinitions(): RenderedToolDefinition[] {
    return this.list().map((tool) => ({
      description: tool.description,
      inputSchema: toJsonSchema(tool.inputSchema),
      name: tool.name,
    }));
  }

  resolve(name: string): TuvrenToolDefinition | undefined {
    return this.tools.get(name);
  }
}

/**
 * Deep-clones a tool definition while keeping its `execute`, `approval`, and
 * schema `validate` functions callable.
 */
function cloneToolDefinition(tool: TuvrenToolDefinition): TuvrenToolDefinition {
  return cloneSnapshotPreservingFunctions(tool);
}

/**
 * Builds the active tool registry for an agent segment from explicit host
 * tools plus extension-contributed tools (framework spec §8.5/§9.2).
 *
 * Explicit tools register first, then each extension's `tools` in extension
 * order; any name collision — including a collision between a host tool and
 * an extension tool — raises `duplicate_tool_registration`. Every definition
 * is validated via `assertTuvrenToolDefinition` on registration.
 *
 * @param explicitTools - Tools declared directly on the agent config.
 * @param extensions - Extensions whose `tools` merge into the registry;
 *   duplicate extension names raise `duplicate_extension_registration`.
 * @throws TuvrenRuntimeError on duplicate tool or extension names, or on an
 *   invalid tool definition.
 */
export function createToolRegistry(
  explicitTools: TuvrenToolDefinition[] = [],
  extensions: TuvrenExtension[] = []
): ToolRegistry {
  assertUniqueExtensionNames(extensions);
  const registry = new BasicToolRegistry();

  for (const tool of explicitTools) {
    registry.register(tool);
  }

  for (const extension of extensions) {
    for (const tool of extension.tools ?? []) {
      registry.register(tool);
    }
  }

  return registry;
}

/**
 * Resolves a tool by name for execution-path lookups.
 *
 * When the registry is the runtime's own {@link BasicToolRegistry}, the
 * stored definition is returned directly, skipping the defensive clone that
 * `get()` performs on every call; custom `ToolRegistry` implementations fall
 * back to their public `get()`. Callers must treat the returned definition
 * as read-only.
 */
export function resolveToolDefinition(
  registry: ToolRegistry,
  name: string
): TuvrenToolDefinition | undefined {
  if (registry instanceof BasicToolRegistry) {
    return registry.resolve(name);
  }

  return registry.get(name);
}

/**
 * Rejects duplicate extension names before their tools merge, so a
 * misconfigured host fails fast with `duplicate_extension_registration`
 * rather than with a confusing tool-name collision.
 */
function assertUniqueExtensionNames(extensions: TuvrenExtension[]): void {
  const names = new Set<string>();

  for (const extension of extensions) {
    if (names.has(extension.name)) {
      throw new TuvrenRuntimeError(
        `extension "${extension.name}" is already registered`,
        {
          code: "duplicate_extension_registration",
          details: {
            extensionName: extension.name,
          },
        }
      );
    }

    names.add(extension.name);
  }
}

/**
 * Type guard for the custom-schema flavor of framework spec §8.2: an object
 * exposing `toJSONSchema()` for provider rendering, as opposed to a plain
 * JSON Schema value.
 */
function isCustomSchema(
  value: TuvrenJsonSchema | CustomSchema
): value is CustomSchema {
  return (
    value !== null &&
    typeof value === "object" &&
    "toJSONSchema" in value &&
    typeof value.toJSONSchema === "function"
  );
}

/**
 * Renders a tool schema to plain JSON Schema for `toDefinitions()`, invoking
 * `toJSONSchema()` on custom schemas and passing JSON Schema through as-is.
 */
function toJsonSchema(
  value: TuvrenJsonSchema | CustomSchema
): TuvrenJsonSchema {
  return isCustomSchema(value) ? value.toJSONSchema() : value;
}

// ---------------------------------------------------------------------------
// Tuvren-client execution class: synthetic tool definitions (KRT-AZ001)
// ---------------------------------------------------------------------------

/** Produces the typed capability_binding_unavailable ToolResultPart for a callId/name pair. */
function makeUnavailableResult(callId: string, capabilityId: string) {
  return {
    callId,
    isError: true as const,
    name: capabilityId,
    output: {
      code: CAPABILITY_BINDING_UNAVAILABLE,
      error: `Tuvren-client capability "${capabilityId}" has no attached endpoint.`,
    },
    type: "tool_result" as const,
  };
}

/**
 * Wraps `boundary.dispatch` to catch the safety-net throw that fires when
 * `detach()` races ahead of dispatch (TOCTOU gap between `isAvailable` and
 * `dispatch`). Returns the string sentinel `"unavailable"` in that case so
 * callers can surface the typed `capability_binding_unavailable` ToolResultPart
 * rather than letting the throw become a generic execution failure.
 */
async function dispatchToClientEndpoint(
  boundary: ClientEndpointBoundary,
  capabilityId: string,
  callId: string,
  input: unknown,
  idempotencyKey?: string
): Promise<ClientDispatchResult | null | "unavailable"> {
  try {
    return await boundary.dispatch(capabilityId, callId, input, idempotencyKey);
  } catch (err) {
    if (
      err instanceof TuvrenRuntimeError &&
      err.code === CAPABILITY_BINDING_UNAVAILABLE
    ) {
      return "unavailable";
    }
    throw err;
  }
}

/**
 * Build synthetic TuvrenToolDefinition entries from attached client endpoints.
 *
 * Each advertised capability becomes a tool whose execute callback dispatches
 * through the ClientEndpointBoundary. The metadata.clientEndpointId tag lets
 * the rest of the execution pipeline (binding resolver, audit gating) detect
 * these as tuvren-client tools.
 *
 * The execute callback:
 * - Returns a direct ToolResultPart when the endpoint is unavailable (avoids
 *   going through executeSingleTool's audit path) or the result is stale.
 * - Otherwise surfaces the ClientReportedResult as a successful tool output.
 */
export function buildClientEndpointTools(
  endpoints: AttachedClientEndpoint[],
  boundary: ClientEndpointBoundary
): TuvrenToolDefinition[] {
  const tools: TuvrenToolDefinition[] = [];

  for (const endpoint of endpoints) {
    for (const cap of endpoint.advertisedCapabilities) {
      const capabilityId = cap.capabilityId;
      const endpointId = endpoint.endpointId;

      const tool: TuvrenToolDefinition = {
        description: cap.description,
        execute: async (input, context) => {
          if (!boundary.isAvailable(capabilityId)) {
            // Surface as a direct ToolResultPart so the capability_binding_unavailable
            // code reaches the model result. (KRT-AZ003)
            return makeUnavailableResult(context.callId, capabilityId);
          }

          const dispatched = await dispatchToClientEndpoint(
            boundary,
            capabilityId,
            context.callId,
            input,
            context.idempotencyKey
          );

          if (dispatched === "unavailable") {
            // TOCTOU: detach() ran between the isAvailable check and dispatch.
            // Surface the same typed result as the !isAvailable branch above.
            return makeUnavailableResult(context.callId, capabilityId);
          }

          // Client-result-as-proposal (ADR-052; framework spec "Running Lease
          // Ownership"): a client-reported result becomes committed history only
          // through a runtime commit performed under a valid run fencing token.
          // If the run lost execution authority while the client was producing
          // the result, the reported result is a stale proposal and MUST NOT be
          // surfaced as a committed outcome under the dead owner. Loss of
          // authority aborts context.signal — lease loss aborts it via
          // createRunLeaseLostError, as do turn cancellation and the wall-clock
          // deadline (a completion after the deadline is likewise ignored). The
          // side effect may already have fired on the client; the idempotency
          // identity on the dispatch envelope lets the client environment
          // deduplicate it. This run-authority gate is distinct from the
          // per-dispatch leaseToken staleness guard (the `dispatched === null`
          // branch below), which only checks that the client echoed the token
          // minted for THIS dispatch, not whether the run still owns write
          // authority. Both reject with code CAPABILITY_RESULT_STALE, so the
          // run-authority rejection carries reason "run_authority_lost" to keep
          // the two conditions programmatically distinguishable (a preemption
          // vs. an echoed-back stale token); the per-dispatch guard omits the
          // reason field. (KRT-BG004)
          if (context.signal?.aborted) {
            return {
              callId: context.callId,
              isError: true,
              name: capabilityId,
              output: {
                code: CAPABILITY_RESULT_STALE,
                error: `Tuvren-client capability "${capabilityId}" result arrived after the run lost execution authority and was rejected as a stale proposal.`,
                reason: "run_authority_lost",
              },
              type: "tool_result",
            };
          }

          if (dispatched === null) {
            // Stale late-completion: the endpoint echoed a wrong leaseToken or
            // callId. The result cannot mutate this invocation. Distinct from
            // capability_binding_unavailable, which signals no endpoint attached.
            // (KRT-AZ003)
            return {
              callId: context.callId,
              isError: true,
              name: capabilityId,
              output: {
                code: CAPABILITY_RESULT_STALE,
                error: `Tuvren-client capability "${capabilityId}" received a stale result and was ignored.`,
              },
              type: "tool_result",
            };
          }

          if (dispatched.isError) {
            return {
              callId: context.callId,
              isError: true,
              name: capabilityId,
              output: dispatched.content,
              type: "tool_result",
            };
          }

          // Always return an explicit ToolResultPart for the success path so
          // client-shaped content cannot shadow the runtime's isError:false
          // intent. Client tools never carry an outputSchema, so no output
          // validation is applied to this class.
          return {
            callId: context.callId,
            isError: false,
            name: capabilityId,
            output: dispatched.content,
            type: "tool_result",
          };
        },
        inputSchema: cap.inputSchema as TuvrenJsonSchema,
        metadata: {
          clientEndpointId: endpointId,
          ...(cap.mcpServerName === undefined
            ? {}
            : { mcpServerName: cap.mcpServerName }),
        },
        name: capabilityId,
      };

      tools.push(tool);
    }
  }

  return tools;
}
