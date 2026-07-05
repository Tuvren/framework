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

// biome-ignore-all lint/performance/noBarrelFile: This subpath entrypoint is the intentional advanced composition surface.
// Advanced composition surface (ADR-057 addendum): low-level factories for
// hosts that build multi-agent orchestration, custom runner registries, or a
// bespoke kernel, beyond the batteries-included `createTuvren`.

export {
  createRuntimeKernel,
  type RuntimeKernelOptions,
} from "@tuvren/kernel-runtime";
export {
  createOrchestrationRuntime,
  createRunnerRegistry,
  createTuvrenRuntime,
  type OrchestrationRuntimeOptions,
  type RuntimeCoreOptions,
} from "@tuvren/runtime";
