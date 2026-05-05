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

import { writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { formatGeneratedJson } from "./format-generated-json.ts";

interface PlanCheck {
  assertions: Record<string, unknown>[];
  capabilities?: string[];
  checkId: string;
  evidence?: string[];
  fixture?: string;
  operation: string;
}

interface Plan {
  applicability: { capabilities: string[] };
  checks: PlanCheck[];
  fixtures?: Record<string, string>;
  packetId: string;
  planId: string;
  planVersion: string;
}

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const PLANS_DIR = resolve(REPO_ROOT, "boundaries/providers/conformance/plans");

await main();

async function main(): Promise<void> {
  // Extended provider coverage stays on the operations already declared by the
  // core provider bridge plan, so validate-plans can still reject undeclared
  // providers.bridge.* additions instead of learning them from this file.
  const extended = buildExtended();

  const filePath = resolve(PLANS_DIR, "provider-api-bridge-extended.json");
  await writeFile(filePath, `${JSON.stringify(extended, null, 2)}\n`);
  await formatGeneratedJson([filePath]);

  process.stdout.write(
    `wrote provider-api-bridge-extended.json (${extended.checks.length} checks)\n`
  );
}

function buildExtended(): Plan {
  const checks: PlanCheck[] = [];

  // generate-mapping — shape checks beyond the four value assertions already
  // present in the core plan.
  const generateMap = (
    id: string,
    assertion: Record<string, unknown>,
    evidence: string[]
  ): PlanCheck => ({
    assertions: [assertion],
    capabilities: ["providers.ai-sdk-bridge"],
    checkId: `providers-ext.generate.${id}`,
    evidence,
    fixture: "provider-fixtures",
    operation: "providers.bridge.generate-mapping",
  });
  checks.push(
    generateMap(
      "response-part-types-shape-array",
      { field: "$.generate.responsePartTypes.0", kind: "evidenceField" },
      ["generate.responsePartTypes.0"]
    ),
    generateMap(
      "response-format-name-matches-pattern",
      {
        field: "$.generate.responseFormatName",
        kind: "evidenceField",
        matches: "^[a-z][a-zA-Z0-9_]*$",
      },
      ["generate.responseFormatName"]
    )
  );

  // structured-output-stream — shape checks beyond core stream chunk/name
  // assertions.
  const structured = (
    id: string,
    assertion: Record<string, unknown>,
    evidence: string[]
  ): PlanCheck => ({
    assertions: [assertion],
    capabilities: ["providers.ai-sdk-bridge"],
    checkId: `providers-ext.structured.${id}`,
    evidence,
    fixture: "provider-fixtures",
    operation: "providers.bridge.structured-output-stream",
  });
  checks.push(
    structured(
      "done-name-matches-identifier",
      {
        field: "$.structured.doneName",
        kind: "evidenceField",
        matches: "^[a-z][a-zA-Z0-9_]*$",
      },
      ["structured.doneName"]
    ),
    structured(
      "first-chunk-is-structured-delta-or-text-delta",
      {
        field: "$.structured.chunkTypes.0",
        kind: "evidenceField",
        matches: "^(structured_delta|text_delta)$",
      },
      ["structured.chunkTypes.0"]
    )
  );

  // provider-failure-normalization — format checks beyond the core normalized
  // error name/code values.
  const failure = (
    id: string,
    assertion: Record<string, unknown>,
    evidence: string[]
  ): PlanCheck => ({
    assertions: [assertion],
    capabilities: ["providers.ai-sdk-bridge"],
    checkId: `providers-ext.failure.${id}`,
    evidence,
    fixture: "provider-fixtures",
    operation: "providers.bridge.provider-failure-normalization",
  });
  checks.push(
    failure(
      "error-code-snake-case",
      {
        field: "$.failure.errorCode",
        kind: "evidenceField",
        matches: "^[a-z0-9]+(?:_[a-z0-9]+)*$",
      },
      ["failure.errorCode"]
    ),
    failure(
      "error-name-pascal-case",
      {
        field: "$.failure.errorName",
        kind: "evidenceField",
        matches: "^[A-Z][A-Za-z0-9]+$",
      },
      ["failure.errorName"]
    )
  );

  return {
    applicability: { capabilities: ["providers.provider-api"] },
    checks,
    fixtures: {
      "provider-fixtures": "../fixtures/provider-fixtures.json",
    },
    packetId: "tuvren.providers.provider-api",
    planId: "tuvren.providers.provider-api.bridge-extended",
    planVersion: "0.1.0",
  };
}
