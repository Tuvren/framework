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

import { TuvrenRuntimeError } from "@tuvren/core-types";
import {
  assertTuvrenToolDefinition,
  type CustomSchema,
  type RenderedToolDefinition,
  type ToolRegistry,
  type TuvrenExtension,
  type TuvrenJsonSchema,
  type TuvrenToolDefinition,
} from "@tuvren/runtime-api";
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
