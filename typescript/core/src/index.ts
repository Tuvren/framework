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

// biome-ignore-all lint/performance/noBarrelFile: This package entrypoint is the intentional public contract surface.
// Root: primitive types (HashString, EpochMs, KernelRecord family) + error base re-exports.
// Most imports should go through the focused subpaths (/errors, /messages, /events, etc.).
export type {
  EpochMs,
  HashString,
  KernelArray,
  KernelObject,
  KernelRecord,
} from "./lib/kernel-records.js";
export {
  assertEpochMs,
  assertHashString,
  assertKernelRecord,
  isEpochMs,
  isHashString,
  isKernelRecord,
} from "./lib/kernel-records.js";
// Tenancy scope seam (ADR-048/049): a host-bound partition identity bound at
// backend construction. The kernel syscall surface stays scope-free.
export type { Scope } from "./lib/scope.js";
export { assertScope, DEFAULT_SCOPE, isScope } from "./lib/scope.js";
// Re-export error family at root for convenience per ADR-037.
export type {
  TuvrenErrorCode,
  TuvrenErrorOptions,
} from "./lib/tuvren-error.js";
export {
  assertTuvrenErrorCode,
  isTuvrenErrorCode,
  TuvrenError,
  TuvrenLineageError,
  TuvrenPersistenceError,
  TuvrenProviderError,
  TuvrenRecoveryError,
  TuvrenRuntimeError,
  TuvrenValidationError,
} from "./lib/tuvren-error.js";
