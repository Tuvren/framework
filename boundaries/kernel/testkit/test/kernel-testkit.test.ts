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

import { describe, expect, test } from "bun:test";
import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { encodeDeterministicKernelRecord } from "@tuvren/kernel-protocol";
import {
  createCanonicalKernelTestSchema,
  createCanonicalTurnTreePaths,
  createHashFromIndex,
  createStoredObjectRecord,
  createStoredSchemaRecord,
  createStoredTurnNodeRecord,
  createStoredTurnTreeRecord,
  registerBackendConformanceSuite,
  registerBackendInvariantSuite,
  registerBackendRecoverySuite,
} from "../src/index.ts";

describe("@tuvren/kernel-testkit fixtures", () => {
  test("creates the canonical kernel test schema", () => {
    deepStrictEqual(createCanonicalKernelTestSchema(), {
      incorporationRules: [
        {
          objectType: "message",
          targetPath: "messages",
        },
        {
          objectType: "context_manifest",
          targetPath: "context.manifest",
        },
      ],
      paths: [
        {
          collection: "ordered",
          path: "messages",
        },
        {
          collection: "single",
          path: "context.manifest",
        },
      ],
      schemaId: "schema_main",
    });
  });

  test("creates deterministic stored records for canonical fixtures", async () => {
    const schema = createCanonicalKernelTestSchema();
    const storedSchema = createStoredSchemaRecord(schema, 1);
    const storedObject = await createStoredObjectRecord(
      new Uint8Array([1, 2]),
      2
    );
    const storedTurnTree = await createStoredTurnTreeRecord(
      schema,
      {
        "context.manifest": null,
        messages: [storedObject.hash],
      },
      3
    );
    const storedTurnNode = await createStoredTurnNodeRecord({
      consumedStagedResults: [],
      createdAtMs: 4,
      eventHash: null,
      previousTurnNodeHash: null,
      schemaId: schema.schemaId,
      turnTreeHash: storedTurnTree.hash,
    });

    strictEqual(storedSchema.schemaId, schema.schemaId);
    strictEqual(storedObject.byteLength, 2);
    strictEqual(storedTurnTree.schemaId, schema.schemaId);
    strictEqual(storedTurnNode.previousTurnNodeHash, null);
  });

  test("creates canonical path rows for ordered and single paths", async () => {
    const schema = createCanonicalKernelTestSchema();
    const storedTurnTree = await createStoredTurnTreeRecord(
      schema,
      {
        "context.manifest": null,
        messages: [createHashFromIndex(1)],
      },
      1
    );

    deepStrictEqual(
      createCanonicalTurnTreePaths(storedTurnTree, {
        "context.manifest": null,
        messages: [createHashFromIndex(1)],
      }),
      [
        {
          collectionKind: "single",
          path: "context.manifest",
          singleHash: null,
          turnTreeHash: storedTurnTree.hash,
        },
        {
          collectionKind: "ordered",
          orderedCount: 1,
          orderedEncoding: "flat",
          orderedInlineCbor: encodeDeterministicKernelRecord([
            createHashFromIndex(1),
          ]),
          path: "messages",
          turnTreeHash: storedTurnTree.hash,
        },
      ]
    );
  });

  test("registers the shared suite entrypoints without executing them eagerly", () => {
    const registrations: Array<{ kind: "describe" | "test"; name: string }> =
      [];
    const testApi = {
      describe(name: string, register: () => void) {
        registrations.push({ kind: "describe", name });
        register();
      },
      test(name: string) {
        registrations.push({ kind: "test", name });
      },
    };

    registerBackendConformanceSuite({
      createBackend: () => {
        throw new Error("should not be called during registration");
      },
      suiteName: "conformance smoke",
      testApi,
    });
    registerBackendInvariantSuite({
      createBackend: () => {
        throw new Error("should not be called during registration");
      },
      suiteName: "invariant smoke",
      testApi,
    });
    registerBackendRecoverySuite({
      createBackend: () => {
        throw new Error("should not be called during registration");
      },
      suiteName: "recovery smoke",
      testApi,
    });

    expect(
      registrations.some((entry) => entry.name === "conformance smoke")
    ).toBe(true);
    expect(
      registrations.some((entry) => entry.name === "invariant smoke")
    ).toBe(true);
    expect(registrations.some((entry) => entry.name === "recovery smoke")).toBe(
      true
    );
    expect(registrations.some((entry) => entry.kind === "test")).toBe(true);
  });
});
