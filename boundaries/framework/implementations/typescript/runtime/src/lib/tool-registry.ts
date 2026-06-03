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

function cloneToolDefinition(tool: TuvrenToolDefinition): TuvrenToolDefinition {
  return cloneSnapshotPreservingFunctions(tool);
}

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

export function resolveToolDefinition(
  registry: ToolRegistry,
  name: string
): TuvrenToolDefinition | undefined {
  if (registry instanceof BasicToolRegistry) {
    return registry.resolve(name);
  }

  return registry.get(name);
}

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

function toJsonSchema(
  value: TuvrenJsonSchema | CustomSchema
): TuvrenJsonSchema {
  return isCustomSchema(value) ? value.toJSONSchema() : value;
}

// ---------------------------------------------------------------------------
// Tuvren-client execution class: synthetic tool definitions (KRT-AZ001)
// ---------------------------------------------------------------------------

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
            return {
              callId: context.callId,
              isError: true,
              name: capabilityId,
              output: {
                code: CAPABILITY_BINDING_UNAVAILABLE,
                error: `Tuvren-client capability "${capabilityId}" has no attached endpoint.`,
              },
              type: "tool_result",
            };
          }

          const dispatched = await boundary.dispatch(
            capabilityId,
            context.callId,
            input
          );

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

          // Return the raw client-reported content. Client tools never carry an
          // outputSchema, so the structural asymmetry with the error branches is
          // intentional and safe — output validation is skipped for this class.
          return dispatched.content;
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
