/**
 * Copyright 2026 Oscar Yáñez Cisterna (@SkrOYC)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { isHashString } from "@tuvren/core";
import type { HashString } from "@tuvren/core";

import { isRecord } from "./runtime-core-shared.js";

export interface InterruptedToolBatchDescriptor {
  assistantMessageHash?: HashString;
  executable: boolean;
  toolExecutionMode: "parallel" | "sequential";
}

export function readInterruptedToolBatchDescriptor(
  value: unknown
): InterruptedToolBatchDescriptor | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const descriptor = value;

  if (
    typeof descriptor.executable !== "boolean" ||
    (descriptor.assistantMessageHash !== undefined &&
      !isHashString(descriptor.assistantMessageHash)) ||
    (descriptor.toolExecutionMode !== "parallel" &&
      descriptor.toolExecutionMode !== "sequential")
  ) {
    return undefined;
  }

  return {
    ...(isHashString(descriptor.assistantMessageHash)
      ? { assistantMessageHash: descriptor.assistantMessageHash }
      : {}),
    executable: descriptor.executable,
    toolExecutionMode: descriptor.toolExecutionMode,
  };
}
