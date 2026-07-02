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
// DEPRECATED: @tuvren/core-types will be removed in the next minor release.
// Import from @tuvren/core instead.
console.warn(
  "[deprecated] @tuvren/core-types is deprecated and will be removed in the next minor release. " +
    "Import from @tuvren/core instead."
);

export type {
  EpochMs,
  HashString,
  KernelArray,
  KernelObject,
  KernelRecord,
  TuvrenErrorCode,
  TuvrenErrorOptions,
} from "@tuvren/core";
export {
  assertEpochMs,
  assertHashString,
  assertKernelRecord,
  assertTuvrenErrorCode,
  isEpochMs,
  isHashString,
  isKernelRecord,
  isTuvrenErrorCode,
  TuvrenError,
  TuvrenLineageError,
  TuvrenPersistenceError,
  TuvrenProviderError,
  TuvrenRecoveryError,
  TuvrenRuntimeError,
  TuvrenValidationError,
} from "@tuvren/core";
