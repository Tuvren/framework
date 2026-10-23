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

import type { RuntimeBackend } from "@tuvren/kernel-protocol";
import type { SelectedKernelMutant } from "@tuvren/kernel-testkit";

export type KernelBackend = "memory" | "postgres" | "sqlite";

export interface KernelAdapterConfig {
  readonly adapterId: string;
  readonly backend: KernelBackend;
  readonly capabilities: readonly string[];
  /** Test-only negative control (ADR-0079); never set by certifying manifests. */
  readonly mutant?: SelectedKernelMutant;
}

export interface ManagedRuntimeBackend extends RuntimeBackend {
  close?: () => Promise<void>;
  destroy?: (options?: { dropSchema?: boolean }) => Promise<void>;
}

export type KernelOperation = (
  input: unknown
) => Record<string, unknown> | Promise<Record<string, unknown>>;

export const createProjection = (
  evidence: Record<string, unknown>
): Record<string, unknown> => ({
  evidence,
  result: evidence,
});
