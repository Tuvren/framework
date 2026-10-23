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

import process from "node:process";

import type { OperationOutcome } from "../../adapter-protocol/index.js";
import { serveStdioAdapter } from "../../adapter-protocol/stdio-host.js";

/** Synthetic mutant behaviors the negative-control runner tests select. */
const MUTANTS: Readonly<
  Record<string, { activateOn: string[]; values: Record<string, number> }>
> = {
  "synthetic.alpha-and-beta": {
    activateOn: ["alpha", "beta"],
    values: { alpha: 99, beta: 99 },
  },
  "synthetic.beta-only": { activateOn: ["beta"], values: { beta: 99 } },
  "synthetic.dormant": { activateOn: [], values: {} },
  "synthetic.gamma-gated": { activateOn: ["gamma"], values: { gamma: 99 } },
  "synthetic.instrumentation": { activateOn: ["alpha"], values: {} },
  "synthetic.wrong-alpha": { activateOn: ["alpha"], values: { alpha: 99 } },
};

const REFERENCE_VALUES: Readonly<Record<string, number>> = {
  alpha: 1,
  beta: 2,
  gamma: 3,
};

const args = process.argv.slice(2);
const readFlag = (flag: string): string | undefined => {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
};

const adapterId = readFlag("--adapter-id") ?? "synthetic";
const mutantEnv = readFlag("--mutant-env");
const selectedMutant =
  mutantEnv === undefined ? undefined : process.env[mutantEnv];
const mutantId =
  selectedMutant === undefined || selectedMutant.length === 0
    ? undefined
    : selectedMutant;
const brokenControl = args.includes("--broken");

if (mutantId === "synthetic.crash-at-startup") {
  process.stderr.write("synthetic adapter crashed at startup\n");
  process.exit(3);
}

const mutant = mutantId === undefined ? undefined : MUTANTS[mutantId];
if (mutantId !== undefined && mutant === undefined) {
  throw new Error(`unknown synthetic mutant ${mutantId}`);
}

let activationCount = 0;

const observe = (field: string): OperationOutcome => {
  const mutated = mutant?.values[field];
  if (mutant?.activateOn.includes(field) === true) {
    activationCount += 1;
  }
  const reference = REFERENCE_VALUES[field] ?? 0;
  const projection = {
    [field]: brokenControl ? reference + 1 : (mutated ?? reference),
  };
  return {
    kind: "result",
    value: { evidence: projection, result: projection },
  };
};

await serveStdioAdapter({
  dispatch: (operation) => {
    if (operation === "synthetic.mutant.activation" && mutantId !== undefined) {
      return {
        kind: "result",
        value: {
          result: {
            activation: {
              activated: activationCount > 0,
              activationCount,
              kind:
                mutantId === "synthetic.instrumentation"
                  ? "instrumentation"
                  : "implementation",
              mutantId,
              signal: `${mutantId}.entered`,
            },
          },
        },
      };
    }
    const field = operation.replace(/^synthetic\./u, "");
    if (field in REFERENCE_VALUES) {
      return observe(field);
    }
    return {
      error: {
        code: "adapter_operation_not_implemented",
        message: `${adapterId} does not implement ${operation}`,
      },
      kind: "error",
    };
  },
  initialize: (packetId, planVersion) => ({
    adapterId,
    capabilities: ["synthetic.core"],
    packetId,
    planVersion,
  }),
});
