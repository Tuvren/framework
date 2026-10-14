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

import { readdir, readFile } from "node:fs/promises";
import nodePath from "node:path";

import Ajv2020 from "ajv/dist/2020.js";

import { assertOperationOutcome } from "./index.js";
import type { AdapterControls } from "./index.js";
import { handleStdioAdapterLine } from "./stdio-host.js";

const PROTOCOL_DIR = import.meta.dirname;
const REPO_ROOT = nodePath.resolve(PROTOCOL_DIR, "../../..");
const SCHEMA_PATH = nodePath.resolve(PROTOCOL_DIR, "protocol.schema.json");
const MANIFEST_SCHEMA_PATH = nodePath.resolve(
  PROTOCOL_DIR,
  "adapter-manifest.schema.json"
);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const readProtocolSchema = (
  value: unknown,
  label: string
): Record<string, unknown> => {
  if (isRecord(value)) {
    return value;
  }

  throw new Error(`${label} must contain a JSON Schema object`);
};

const readStringProperty = (
  source: Record<string, unknown>,
  key: string,
  label: string
): string => {
  const value = source[key];

  if (typeof value !== "string") {
    throw new TypeError(`${label} must be a string`);
  }

  return value;
};

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

const findAdapterManifests = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const manifests: string[] = [];

  const visit = async (index: number): Promise<void> => {
    const entry = entries[index];
    if (entry === undefined) {
      return;
    }
    const entryPath = nodePath.resolve(directory, entry.name);

    if (entry.isDirectory()) {
      const nestedManifests = await findAdapterManifests(entryPath);
      manifests.push(...nestedManifests);
      await visit(index + 1);
      return;
    }

    if (
      entry.isFile() &&
      entry.name.startsWith("adapter") &&
      entry.name.endsWith(".json")
    ) {
      manifests.push(entryPath);
    }
    await visit(index + 1);
  };
  await visit(0);

  return manifests.toSorted();
};

const protocolSchema: unknown = JSON.parse(
  await readFile(SCHEMA_PATH, "utf-8")
);
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
await assertStdioHostControlRoundtrip();

console.log("adapter protocol validation passed");

const manifestSchema = readProtocolSchema(
  JSON.parse(await readFile(MANIFEST_SCHEMA_PATH, "utf-8")) as unknown,
  MANIFEST_SCHEMA_PATH
);
const validateManifest = ajv.compile(manifestSchema);

const ADAPTER_MANIFEST_ROOTS = [
  "typescript",
  "rust",
  "go",
  "python",
  "dart",
].map((root) => nodePath.resolve(REPO_ROOT, root));

const validateManifests = async (
  paths: readonly string[],
  index: number
): Promise<void> => {
  const manifestPath = paths[index];
  if (manifestPath === undefined) {
    return;
  }
  const manifest: unknown = JSON.parse(await readFile(manifestPath, "utf-8"));
  if (!validateManifest(manifest)) {
    throw new Error(
      `${manifestPath} failed adapter manifest validation: ${ajv.errorsText(validateManifest.errors)}`
    );
  }
  await validateManifests(paths, index + 1);
};
const validateRoots = async (index: number): Promise<void> => {
  const manifestRoot = ADAPTER_MANIFEST_ROOTS[index];
  if (manifestRoot === undefined) {
    return;
  }
  await validateManifests(await findAdapterManifests(manifestRoot), 0);
  await validateRoots(index + 1);
};
await validateRoots(0);

console.log("adapter manifest validation passed");
