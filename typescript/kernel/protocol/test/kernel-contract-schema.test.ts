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

import {
  assertObserveResult,
  assertPathValue,
  assertPathValueForCollectionKind,
  assertStepContext,
  assertStepDeclaration,
  assertTurnTreeChangeSet,
  assertTurnTreeSchema,
} from "../src/index.ts";
import { restorePrototypeValue } from "./kernel-contract-test-helpers.ts";
import {
  kernelProtocolDeterministicFixtures,
  kernelProtocolInvalidFixtures,
  kernelProtocolLogicalFixtures,
} from "./kernel-protocol-fixtures.js";

describe("schema validation", () => {
  test("accepts the canonical TurnTreeSchema fixture", () => {
    expect(() => {
      assertTurnTreeSchema(
        kernelProtocolDeterministicFixtures.turnTreeSchemaRecord
      );
    }).not.toThrow();
  });

  test("rejects duplicate paths", () => {
    expect(() => {
      assertTurnTreeSchema(kernelProtocolInvalidFixtures.duplicatePathSchema);
    }).toThrow("must not contain duplicate schema paths");
  });

  test("rejects duplicate objectType mappings", () => {
    expect(() => {
      assertTurnTreeSchema(kernelProtocolInvalidFixtures.duplicateRuleSchema);
    }).toThrow("must not contain duplicate objectType mappings");
  });

  test("rejects unknown incorporation target paths", () => {
    expect(() => {
      assertTurnTreeSchema(kernelProtocolInvalidFixtures.unknownPathSchema);
    }).toThrow("must reference a defined schema path");
  });

  test("rejects malformed schema path grammar", () => {
    expect(() => {
      assertTurnTreeSchema(
        kernelProtocolInvalidFixtures.invalidSchemaPathSchema
      );
    }).toThrow("must be a dot-separated path with non-empty segments");
    expect(() => {
      assertTurnTreeChangeSet(
        {
          "messages..results":
            "5858585858585858585858585858585858585858585858585858585858585858",
        },
        kernelProtocolDeterministicFixtures.turnTreeSchemaRecord
      );
    }).toThrow("must be a dot-separated path with non-empty segments");
  });

  test("rejects schema records with symbol keys or accessor-backed fields", () => {
    expect(() => {
      assertTurnTreeSchema(
        kernelProtocolInvalidFixtures.invalidSchemaWithSymbolKey
      );
    }).toThrow("must be a plain object");
    expect(() => {
      assertTurnTreeSchema(
        kernelProtocolInvalidFixtures.invalidSchemaWithAccessorPathMetadata
      );
    }).toThrow("must be a plain object");
    expect(() => {
      assertTurnTreeSchema(
        kernelProtocolInvalidFixtures.invalidSchemaWithDateMetadata
      );
    }).toThrow("must match the restricted runtime kernel record profile");
  });

  test("does not accept required fields inherited from Object.prototype", () => {
    const objectPrototype = Object.prototype;
    const originalSchemaId: unknown = Reflect.get(objectPrototype, "schemaId");
    const originalPaths: unknown = Reflect.get(objectPrototype, "paths");
    const originalIncorporationRules: unknown = Reflect.get(
      objectPrototype,
      "incorporationRules"
    );
    const originalId: unknown = Reflect.get(objectPrototype, "id");
    const originalDeterministic: unknown = Reflect.get(
      objectPrototype,
      "deterministic"
    );
    const originalSideEffects: unknown = Reflect.get(
      objectPrototype,
      "sideEffects"
    );
    const hadSchemaId = Object.hasOwn(objectPrototype, "schemaId");
    const hadPaths = Object.hasOwn(objectPrototype, "paths");
    const hadIncorporationRules = Object.hasOwn(
      objectPrototype,
      "incorporationRules"
    );
    const hadId = Object.hasOwn(objectPrototype, "id");
    const hadDeterministic = Object.hasOwn(objectPrototype, "deterministic");
    const hadSideEffects = Object.hasOwn(objectPrototype, "sideEffects");

    Reflect.set(objectPrototype, "schemaId", "schema_main");
    Reflect.set(objectPrototype, "paths", [
      { collection: "ordered", path: "messages" },
    ]);
    Reflect.set(objectPrototype, "incorporationRules", []);
    Reflect.set(objectPrototype, "id", "model_call");
    Reflect.set(objectPrototype, "deterministic", false);
    Reflect.set(objectPrototype, "sideEffects", false);

    try {
      expect(() => {
        assertTurnTreeSchema({});
      }).toThrow("schemaId must be a non-empty string");
      expect(() => {
        assertStepDeclaration({});
      }).toThrow("id must be a non-empty string");
    } finally {
      restorePrototypeValue(
        objectPrototype,
        "schemaId",
        hadSchemaId,
        originalSchemaId
      );
      restorePrototypeValue(objectPrototype, "paths", hadPaths, originalPaths);
      restorePrototypeValue(
        objectPrototype,
        "incorporationRules",
        hadIncorporationRules,
        originalIncorporationRules
      );
      restorePrototypeValue(objectPrototype, "id", hadId, originalId);
      restorePrototypeValue(
        objectPrototype,
        "deterministic",
        hadDeterministic,
        originalDeterministic
      );
      restorePrototypeValue(
        objectPrototype,
        "sideEffects",
        hadSideEffects,
        originalSideEffects
      );
    }
  });

  test("enforces collection-kind-specific path values", () => {
    expect(() => {
      assertPathValueForCollectionKind(
        kernelProtocolLogicalFixtures.turnTreeChangeSet.messages,
        "ordered"
      );
    }).not.toThrow();
    expect(() => {
      assertPathValueForCollectionKind(
        kernelProtocolLogicalFixtures.turnTreeChangeSet["context.manifest"],
        "single"
      );
    }).not.toThrow();
    expect(() => {
      assertPathValueForCollectionKind(
        kernelProtocolLogicalFixtures.turnTreeChangeSet.messages,
        "single"
      );
    }).toThrow("must be a HashString or null for a single path");
  });

  test("rejects sparse ordered-path arrays", () => {
    expect(() => {
      assertPathValue(
        kernelProtocolInvalidFixtures.invalidSparseOrderedPathValue
      );
    }).toThrow("must be a HashString, HashString[], or null");
    expect(() => {
      assertPathValueForCollectionKind(
        kernelProtocolInvalidFixtures.invalidSparseOrderedPathValue,
        "ordered"
      );
    }).toThrow("must be a HashString[] for an ordered path");
  });

  test("rejects non-data array shapes in path validation", () => {
    expect(() => {
      assertPathValueForCollectionKind(
        kernelProtocolInvalidFixtures.invalidArrayWithEnumerableMetadata,
        "ordered"
      );
    }).toThrow("must be a HashString[] for an ordered path");
    expect(() => {
      assertPathValueForCollectionKind(
        kernelProtocolInvalidFixtures.invalidArrayWithAccessorIndex,
        "ordered"
      );
    }).toThrow("must be a HashString[] for an ordered path");
  });

  test("does not accept sparse arrays that borrow values from Array.prototype", () => {
    const inheritedHash =
      "4848484848484848484848484848484848484848484848484848484848484848";
    const inheritedArray: unknown[] = [];
    inheritedArray.length = 1;
    const localPrototype = { 0: inheritedHash };
    Object.setPrototypeOf(
      localPrototype,
      Reflect.getPrototypeOf(inheritedArray)
    );
    Object.setPrototypeOf(inheritedArray, localPrototype);
    expect(Array.isArray(inheritedArray)).toBe(true);
    expect(inheritedArray[0]).toBe(inheritedHash);
    expect(Object.hasOwn(inheritedArray, 0)).toBe(false);
    expect(() => {
      assertObserveResult({ annotations: inheritedArray, signals: [] });
    }).toThrow("annotations must be a dense data-only array");
    expect(() => {
      assertStepContext({
        currentTurnNodeHash:
          "4949494949494949494949494949494949494949494949494949494949494949",
        schema: {
          incorporationRules: [],
          paths: [{ collection: "ordered", path: "messages" }],
          schemaId: "schema_main",
        },
        signals: inheritedArray,
        step: {
          deterministic: false,
          id: "model_call",
          sideEffects: false,
        },
      });
    }).toThrow("signals must be a dense data-only array");
  });
});
