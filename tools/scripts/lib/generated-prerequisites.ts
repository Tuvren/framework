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

import type { VerificationPhase } from "../verify.js";

export const GENERATED_PREREQUISITE_PROJECT = "kernel-interop-grpc";

export interface GeneratedPrerequisiteOptions {
  fresh: boolean;
}

/**
 * Materializes the generated gRPC client bindings required by authority
 * validation and source-only TypeScript consumers. The target owns its real
 * output directory and is cacheable, so normal iteration restores the output
 * from Nx while fresh kernel verification can force the generator to run.
 */
export function createGeneratedPrerequisitePhase(
  options: GeneratedPrerequisiteOptions
): VerificationPhase {
  return {
    concurrency: 1,
    id: "generated prerequisites",
    steps: [
      {
        command: [
          "bun",
          "run",
          "nx",
          "run",
          `${GENERATED_PREREQUISITE_PROJECT}:codegen`,
          ...(options.fresh ? ["--skipNxCache"] : []),
        ],
        id: "kernel interop generated prerequisite",
      },
    ],
  };
}

export function prependGeneratedPrerequisitePhase(
  phases: readonly VerificationPhase[],
  options: GeneratedPrerequisiteOptions
): VerificationPhase[] {
  return [createGeneratedPrerequisitePhase(options), ...phases];
}
