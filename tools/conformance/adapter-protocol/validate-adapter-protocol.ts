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

import { readFile } from "node:fs/promises";

import { assertOperationOutcome } from "./index.js";
import type { AdapterControls } from "./index.js";
import {
  assertAdapterProtocolContracts,
  findAdapterManifests,
  validateAdapterDefinition,
  validateAdapterManifest,
} from "./protocol-contract.js";
import { handleStdioAdapterLine } from "./stdio-host.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const createSample = (definitionName: string): unknown => {
  switch (definitionName) {
    case "AdapterCapabilities": {
      return {
        adapterId: "sample-adapter",
        capabilities: ["sample.capability"],
        packetId: "tuvren.sample.packet",
        planVersion: "0.1.0",
      };
    }
    case "AdapterControls": {
      return {
        cancel: { reason: "sample cancellation" },
        cancelAfterEvent: "turn.start",
        deadlineMs: 1000,
      };
    }
    case "AdapterErrorEnvelope": {
      return {
        code: "adapter_sample_error",
        message: "sample failure",
      };
    }
    case "OperationOutcome": {
      return {
        kind: "result",
        value: { ok: true },
      };
    }
    default: {
      throw new Error(`unknown adapter protocol sample ${definitionName}`);
    }
  }
};

const assertStdioHostControlRoundtrip = async (): Promise<void> => {
  let observedControls: AdapterControls | undefined;
  const response = await handleStdioAdapterLine(
    {
      dispatch(_operation, _input, controls) {
        observedControls = controls;
        return {
          kind: "result",
          value: { ok: true },
        };
      },
      initialize() {
        return {
          adapterId: "sample-adapter",
          capabilities: ["sample.capability"],
          packetId: "tuvren.sample.packet",
          planVersion: "0.1.0",
        };
      },
    },
    JSON.stringify({
      id: 1,
      jsonrpc: "2.0",
      method: "dispatch",
      params: {
        controls: {
          cancel: { reason: "sample cancellation" },
          cancelAfterEvent: "turn.start",
          deadlineMs: 1000,
        },
        input: {},
        operation: "sample.operation",
      },
    })
  );

  if (!(isRecord(response) && "result" in response)) {
    throw new Error("stdio host failed to return a JSON-RPC result frame");
  }

  if (
    observedControls?.cancel?.reason !== "sample cancellation" ||
    observedControls.cancelAfterEvent !== "turn.start" ||
    observedControls.deadlineMs !== 1000
  ) {
    throw new Error("stdio host failed to preserve adapter controls");
  }
};

for (const definitionName of [
  "AdapterCapabilities",
  "AdapterControls",
  "AdapterErrorEnvelope",
  "OperationOutcome",
]) {
  const violations = validateAdapterDefinition(
    definitionName,
    createSample(definitionName)
  );

  if (violations.length > 0) {
    throw new Error(
      `${definitionName} sample failed adapter protocol validation: ${violations.join("; ")}`
    );
  }
}

assertOperationOutcome(
  {
    kind: "result",
    value: { ok: true },
  },
  "result sample"
);
assertOperationOutcome(
  {
    error: {
      code: "adapter_sample_error",
      message: "sample failure",
    },
    kind: "error",
  },
  "error sample"
);
await assertStdioHostControlRoundtrip();

assertAdapterProtocolContracts();

console.log("adapter protocol validation passed (0.1.0 and 0.2.0)");

const manifestPaths = await findAdapterManifests();
const manifestFailures = (
  await Promise.all(
    manifestPaths.map(async (manifestPath) => {
      const manifest: unknown = JSON.parse(
        await readFile(manifestPath, "utf-8")
      );
      const violations = validateAdapterManifest(manifest);
      return violations.length === 0
        ? []
        : [
            `${manifestPath} failed adapter manifest validation: ${violations.join("; ")}`,
          ];
    })
  )
).flat();

if (manifestFailures.length > 0) {
  throw new Error(manifestFailures.join("\n"));
}

console.log(
  `adapter manifest validation passed (${manifestPaths.length} manifests)`
);
