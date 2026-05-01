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
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { assertOperationOutcome } from "./index.js";

const PROTOCOL_DIR = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = resolve(PROTOCOL_DIR, "protocol.schema.json");

const protocolSchema: unknown = JSON.parse(await readFile(SCHEMA_PATH, "utf8"));
const schema = readProtocolSchema(protocolSchema, SCHEMA_PATH);
const ajv = new Ajv2020({ allErrors: true, strict: false });

ajv.addSchema(schema);

for (const definitionName of [
  "AdapterCapabilities",
  "AdapterControls",
  "AdapterErrorEnvelope",
  "OperationOutcome",
]) {
  const schemaId = readStringProperty(schema, "$id", "protocol schema $id");
  const schemaPath = `${schemaId}#/$defs/${definitionName}`;
  const validate = ajv.getSchema(schemaPath);

  if (validate === undefined) {
    throw new Error(`${definitionName} validator was not registered`);
  }

  const sample = createSample(definitionName);

  if (validate(sample) !== true) {
    throw new Error(
      `${definitionName} sample failed adapter protocol validation: ${ajv.errorsText(
        validate.errors
      )}`
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

console.log("adapter protocol validation passed");

function createSample(definitionName: string): unknown {
  switch (definitionName) {
    case "AdapterCapabilities":
      return {
        adapterId: "sample-adapter",
        packetId: "tuvren.sample.packet",
        planVersion: "0.1.0",
      };
    case "AdapterControls":
      return {
        cancel: { reason: "sample cancellation" },
        cancelAfterEvent: "turn.start",
        deadlineMs: 1000,
      };
    case "AdapterErrorEnvelope":
      return {
        code: "adapter_sample_error",
        message: "sample failure",
      };
    case "OperationOutcome":
      return {
        kind: "result",
        value: { ok: true },
      };
    default:
      throw new Error(`unknown adapter protocol sample ${definitionName}`);
  }
}

function readProtocolSchema(
  value: unknown,
  label: string
): Record<string, unknown> {
  if (isRecord(value)) {
    return value;
  }

  throw new Error(`${label} must contain a JSON Schema object`);
}

function readStringProperty(
  source: Record<string, unknown>,
  key: string,
  label: string
): string {
  const value = source[key];

  if (typeof value !== "string") {
    throw new Error(`${label} must be a string`);
  }

  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
