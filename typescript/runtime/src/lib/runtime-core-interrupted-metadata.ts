/**
 * Copyright 2026 Oscar Yáñez Cisterna (@SkrOYC)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import type { HashString } from "@tuvren/core";
import type { ContextManifest } from "@tuvren/core/execution";

import { isRecord } from "./runtime-core-shared.js";

export interface InterruptedToolBatchDescriptor {
  assistantMessageHash?: HashString;
  executable: boolean;
  toolExecutionMode: "parallel" | "sequential";
}

const DESCRIPTOR_KEY = "__tuvren_interrupted_tool_batch";

export function readInterruptedToolBatchDescriptor(
  manifest: ContextManifest
): InterruptedToolBatchDescriptor | undefined {
  const value = manifest.extensions[DESCRIPTOR_KEY];

  if (!isRecord(value)) {
    return undefined;
  }

  const descriptor = value;

  if (
    typeof descriptor.executable !== "boolean" ||
    (descriptor.assistantMessageHash !== undefined &&
      typeof descriptor.assistantMessageHash !== "string") ||
    (descriptor.toolExecutionMode !== "parallel" &&
      descriptor.toolExecutionMode !== "sequential")
  ) {
    return undefined;
  }

  return {
    ...(typeof descriptor.assistantMessageHash === "string"
      ? { assistantMessageHash: descriptor.assistantMessageHash as HashString }
      : {}),
    executable: descriptor.executable,
    toolExecutionMode: descriptor.toolExecutionMode,
  };
}

export function withInterruptedToolBatchDescriptor(
  manifest: ContextManifest,
  descriptor: InterruptedToolBatchDescriptor
): ContextManifest {
  return {
    ...manifest,
    extensions: {
      ...manifest.extensions,
      [DESCRIPTOR_KEY]: descriptor,
    },
  };
}

export function withoutInterruptedToolBatchDescriptor(
  manifest: ContextManifest
): ContextManifest {
  if (!(DESCRIPTOR_KEY in manifest.extensions)) {
    return manifest;
  }

  const extensions = { ...manifest.extensions };
  delete extensions[DESCRIPTOR_KEY];
  return { ...manifest, extensions };
}
