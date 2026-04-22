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

import {
  assertKrakenToolDefinition,
  type CustomSchema,
  type KrakenExtension,
  type KrakenJsonSchema,
  type KrakenToolDefinition,
  type RenderedToolDefinition,
  type ToolRegistry,
} from "@kraken/framework-runtime-api";
import { KrakenRuntimeError } from "@kraken/shared-core-types";
import { cloneSnapshotPreservingFunctions } from "./runtime-core-shared.js";

class BasicToolRegistry implements ToolRegistry {
  private readonly tools = new Map<string, KrakenToolDefinition>();

  get(name: string): KrakenToolDefinition | undefined {
    const tool = this.resolve(name);

    if (tool === undefined) {
      return undefined;
    }

    return cloneToolDefinition(tool);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): KrakenToolDefinition[] {
    return [...this.tools.values()].map((tool) => cloneToolDefinition(tool));
  }

  register(tool: KrakenToolDefinition): void {
    assertKrakenToolDefinition(tool, "tool");

    if (this.tools.has(tool.name)) {
      throw new KrakenRuntimeError(
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

  resolve(name: string): KrakenToolDefinition | undefined {
    return this.tools.get(name);
  }
}

function cloneToolDefinition(tool: KrakenToolDefinition): KrakenToolDefinition {
  return cloneSnapshotPreservingFunctions(tool);
}

export function createToolRegistry(
  explicitTools: KrakenToolDefinition[] = [],
  extensions: KrakenExtension[] = []
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
): KrakenToolDefinition | undefined {
  if (registry instanceof BasicToolRegistry) {
    return registry.resolve(name);
  }

  return registry.get(name);
}

function assertUniqueExtensionNames(extensions: KrakenExtension[]): void {
  const names = new Set<string>();

  for (const extension of extensions) {
    if (names.has(extension.name)) {
      throw new KrakenRuntimeError(
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
  value: KrakenJsonSchema | CustomSchema
): value is CustomSchema {
  return (
    value !== null &&
    typeof value === "object" &&
    "toJSONSchema" in value &&
    typeof value.toJSONSchema === "function"
  );
}

function toJsonSchema(
  value: KrakenJsonSchema | CustomSchema
): KrakenJsonSchema {
  return isCustomSchema(value) ? value.toJSONSchema() : value;
}
