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

import { runReplScenario } from "./repl-scenarios.js";
import type {
  ReplConfig,
  ReplScenarioMatrixReport,
  ReplScenarioName,
  ReplScenarioReport,
} from "./repl-types.js";

export async function runReplScenarioMatrix(input: {
  config: Omit<ReplConfig, "scenario">;
  scenarios: readonly ReplScenarioName[];
}): Promise<ReplScenarioMatrixReport> {
  const reports: ReplScenarioReport[] = [];
  const failedScenarios: ReplScenarioName[] = [];

  for (const scenario of input.scenarios) {
    const report = await runReplScenario({
      ...input.config,
      scenario,
    });

    reports.push(report);

    if (!haveAllChecksPassed(report.checks)) {
      failedScenarios.push(scenario);
    }
  }

  return {
    backend: input.config.backend,
    kernelMode: input.config.kernelMode ?? "typescript-local",
    modelId: input.config.modelId,
    providerMode: input.config.providerMode,
    reports,
    scenarios: [...input.scenarios],
    summary: {
      allChecksPassed: failedScenarios.length === 0,
      failedScenarioCount: failedScenarios.length,
      failedScenarios,
      passedScenarioCount: reports.length - failedScenarios.length,
    },
  };
}

export function haveAllChecksPassed(checks: Record<string, boolean>): boolean {
  const values = Object.values(checks);

  return values.length > 0 && values.every((value) => value);
}
