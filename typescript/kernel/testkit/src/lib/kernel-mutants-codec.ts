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

import type { KernelObject, KernelRecord } from "@tuvren/core";
import type { PathValue, TurnTreeManifest } from "@tuvren/kernel-protocol";

import type {
  KernelMutantActivate,
  KernelMutantCodec,
  KernelMutantDefinition,
} from "./kernel-mutant-types.js";

const isKernelObject = (record: KernelRecord): record is KernelObject =>
  typeof record === "object" &&
  record !== null &&
  !Array.isArray(record) &&
  !(record instanceof Uint8Array);

const alternateHash = (hash: string): string =>
  `${hash.startsWith("0") ? "1" : "0"}${hash.slice(1)}`;

// The schema-hash and TurnNode-hash assertions both call hashKernelRecord;
// only a record carrying the TurnTreeSchema contract shape is corrupted so
// TurnNode identity records keep their canonical digest.
const corruptSchemaRecord = (record: KernelRecord): KernelObject | undefined =>
  isKernelObject(record) &&
  Array.isArray(record.incorporationRules) &&
  Array.isArray(record.paths) &&
  typeof record.schemaId === "string"
    ? { ...record, schemaId: `${record.schemaId}-mutant` }
    : undefined;

const corruptTurnNodeRecord = (
  record: KernelRecord
): KernelObject | undefined =>
  isKernelObject(record) &&
  Array.isArray(record.consumedStagedResults) &&
  typeof record.turnTreeHash === "string"
    ? { ...record, turnTreeHash: alternateHash(record.turnTreeHash) }
    : undefined;

const MUTANT_MANIFEST_VALUE = `1${"0".repeat(63)}`;

// Rewrites every manifest entry to a well-formed but different value so the
// corrupted manifest still validates against the supplied schema.
const corruptManifestValue = (value: PathValue): PathValue => {
  if (value === null) {
    return MUTANT_MANIFEST_VALUE;
  }
  if (typeof value === "string") {
    return alternateHash(value);
  }
  return value.length === 0
    ? [MUTANT_MANIFEST_VALUE]
    : value.map((entry) => alternateHash(entry));
};

const corruptTurnTreeManifest = (
  manifest: TurnTreeManifest
): TurnTreeManifest =>
  Object.fromEntries(
    Object.entries(manifest).map(([path, value]) => [
      path,
      corruptManifestValue(value),
    ])
  );

const hashRecordWithCorruption = (
  codec: KernelMutantCodec,
  activate: KernelMutantActivate,
  corrupt: (record: KernelRecord) => KernelRecord | undefined
): KernelMutantCodec => {
  const { hashKernelRecord } = codec;
  return {
    ...codec,
    ...(hashKernelRecord === undefined
      ? {}
      : {
          hashKernelRecord: async (record: KernelRecord) => {
            const corrupted = corrupt(record);
            if (corrupted === undefined) {
              return await hashKernelRecord(record);
            }
            activate();
            return await hashKernelRecord(corrupted);
          },
        }),
  };
};

const wrongTurnTreeHash = (
  codec: KernelMutantCodec,
  activate: KernelMutantActivate
): KernelMutantCodec => {
  const { hashTurnTreeIdentity } = codec;
  return {
    ...codec,
    ...(hashTurnTreeIdentity === undefined
      ? {}
      : {
          hashTurnTreeIdentity: async (schemaId, manifest, schema) => {
            activate();
            return await hashTurnTreeIdentity(
              schemaId,
              corruptTurnTreeManifest(manifest),
              schema
            );
          },
        }),
  };
};

export const CODEC_KERNEL_MUTANTS: readonly KernelMutantDefinition[] = [
  {
    createSeams: () => ({
      codec: (codec, activate) =>
        hashRecordWithCorruption(codec, activate, corruptSchemaRecord),
    }),
    kind: "implementation",
    mutantId: "kernel.wrong-schema-record-hash",
    signal: "mutant.wrong-schema-record-hash.entered",
  },
  {
    createSeams: () => ({
      codec: (codec, activate) =>
        hashRecordWithCorruption(codec, activate, corruptTurnNodeRecord),
    }),
    kind: "implementation",
    mutantId: "kernel.wrong-turn-node-record-hash",
    signal: "mutant.wrong-turn-node-record-hash.entered",
  },
  {
    createSeams: () => ({ codec: wrongTurnTreeHash }),
    kind: "implementation",
    mutantId: "kernel.wrong-turn-tree-hash",
    signal: "mutant.wrong-turn-tree-hash.entered",
  },
];
