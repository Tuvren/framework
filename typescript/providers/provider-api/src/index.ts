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
// This package is intentionally a focused import home over the shared runtime
// contract family. It now tracks the matching `@tuvren/core/provider` subpath
// instead of the broad root facade so the dependency shape stays as narrow as
// the surface.

/**
 * `@tuvren/provider-api` — re-export barrel over the `TuvrenProvider` family.
 *
 * A published-internal package (ADR-057 item 5): it exists on the registry
 * only so host-facing packages' dependency graphs resolve on a fresh install,
 * is not semver-guaranteed, and can change shape without a major bump. It is
 * an engine dependency of the runner and provider-bridge packages, not a
 * host-facing API — host applications must never install or import it
 * directly (docs/guides/publishing-and-adopter-onboarding.md §4). Anything
 * here that a host legitimately needs is already re-exported through
 * `@tuvren/sdk` or `@tuvren/core`.
 *
 * Everything re-exported below tracks `@tuvren/core/provider` verbatim; see
 * that subpath for the authoritative type and assertion-helper docs.
 *
 * @packageDocumentation
 */
export type {
  ProviderMediatedToolConfig,
  ProviderNativeInvocationRecord,
  ProviderNativeToolDeclaration,
  ProviderStreamChunk,
  ProviderUsage,
  StructuredOutputRequest,
  TuvrenModelResponse,
  TuvrenPrompt,
  TuvrenProvider,
} from "@tuvren/core/provider";
export {
  assertProviderStreamChunk,
  assertTuvrenModelResponse,
  isProviderStreamChunk,
  isTuvrenModelResponse,
} from "@tuvren/core/provider";
