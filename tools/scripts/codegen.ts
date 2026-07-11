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

// The root `codegen` lane (KRT-BM002). This replaces the previous inline
// `&&` chain in package.json, which ran the same independent validators
// verify's first phase already parallelizes — one at a time. The validator
// set and their relative order below are exactly the old chain's; the only
// behavior change is intra-phase concurrency (and, like verify's parallel
// phase, all validators run to completion instead of fail-fast, so one run
// surfaces every failure at once).

import process from "node:process";
import {
  AUTHORITY_GATE_STEPS,
  CODEGEN_PROJECTS,
  hasVerificationFailure,
  printVerificationSummary,
  runVerificationPhases,
  type VerificationStep,
} from "./verify.js";

// The exact validator subset (and order) package.json's previous inline
// chain ran, selected by ID from verify's shared AUTHORITY_GATE_STEPS so
// this lane cannot silently diverge from `verify`'s gate: if an ID stops
// matching a verify step, buildCodegenValidators throws instead of quietly
// dropping a check. Note this is deliberately NOT all of
// AUTHORITY_GATE_STEPS — the old chain never ran the host import boundary
// gate, the API-surface freeze gate, or the workspace test-lane coverage
// gate, and this migration is a refactor, not a behavior change.
const CODEGEN_VALIDATOR_IDS: readonly string[] = [
  "docs-to-authority freeze gate",
  "Epic AL portability gate",
  "Epic AF conformance gap plan freshness",
  "authority packet validation",
  "conformance plan validation",
  "adapter protocol validation",
  "certification discovery parity",
  "certification harness meta-conformance",
  "vocabulary-check verification",
  "machine authority guardrails",
];

function buildCodegenValidators(): VerificationStep[] {
  return CODEGEN_VALIDATOR_IDS.map((id) => {
    const step = AUTHORITY_GATE_STEPS.find((candidate) => candidate.id === id);

    if (step === undefined) {
      throw new Error(
        `codegen: validator id "${id}" no longer matches a verify gate step. ` +
          "Update CODEGEN_VALIDATOR_IDS to track tools/scripts/verify.ts."
      );
    }

    return step;
  });
}

const results = await runVerificationPhases([
  {
    id: "codegen authority validators",
    steps: buildCodegenValidators(),
  },
  {
    // Regeneration runs after the validators, as the old chain did. Cached
    // Nx execution is intentional here (unlike verify's freshness phase,
    // which uses --skipNxCache): this lane exists to materialize/refresh
    // generated artifacts for local work, not to prove uncached freshness.
    concurrency: 1,
    id: "artifact code generation",
    steps: [
      {
        command: [
          "bun",
          "run",
          "nx",
          "run-many",
          "-t",
          "codegen",
          "-p",
          CODEGEN_PROJECTS,
        ],
        id: "telemetry, compatibility, and interop code generation",
      },
    ],
  },
]);

printVerificationSummary(results);

if (hasVerificationFailure(results)) {
  process.exitCode = 1;
}
