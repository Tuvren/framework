import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import type { ConformancePlanAssertion } from "../../plan-compiler/index.ts";
import {
  diagnoseAssertions,
  evaluateAssertions,
} from "../assertion-engine/index.ts";
import { encodeIdentity } from "../kernel-integrity.ts";

const fixtureRoot = path.resolve(
  import.meta.dirname,
  "../../../../spec/conformance/kernel/fixtures"
);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const object = (value: unknown): Record<string, unknown> => {
  if (!isRecord(value)) {
    throw new Error("expected object");
  }
  return value;
};
const check = (assertion: ConformancePlanAssertion) => ({
  assertions: [assertion],
  checkId: "integrity",
  operation: "kernel.node.get",
});
const status = (assertion: ConformancePlanAssertion, result: unknown) =>
  evaluateAssertions(check(assertion), { result })[0]?.status;
const expectedIntegrityStatus = (
  assertion: ConformancePlanAssertion,
  value: unknown,
  hash: string
): "pass" | "fail" =>
  assertion.kind === "referenceWalk" &&
  isRecord(value) &&
  typeof value.hash === "string" &&
  value.hash !== hash
    ? "fail"
    : "pass";
const bytes = (hex: string) => ({ $bytes: hex });
const flip = (hex: string): string =>
  `${hex.startsWith("00") ? "01" : "00"}${hex.slice(2)}`;
const families: Record<string, string> = {
  rawOpaqueBytes: "opaque-object",
  turnNodeIdentityRecord: "turn-node",
  turnTreeIdentityRecord: "turn-tree",
  turnTreeSchemaRecord: "schema",
};

test("TurnTree encoder reproduces the committed vector independently of manifest insertion order", () => {
  const fixture = object(
    JSON.parse(
      readFileSync(
        path.join(fixtureRoot, "kernel-protocol-turn-tree.json"),
        "utf-8"
      )
    )
  );
  const value = object(fixture.turnTreeIdentityRecord);
  const expected = fixture.turnTreeIdentityRecordCborHex;
  expect(Buffer.from(encodeIdentity("turn-tree", value)).toString("hex")).toBe(
    expected
  );
  expect(
    Buffer.from(
      encodeIdentity("turn-tree", {
        ...value,
        manifest: Object.fromEntries(
          Object.entries(object(value.manifest)).toReversed()
        ),
      })
    ).toString("hex")
  ).toBe(expected);
});

const fixtureFiles = readdirSync(fixtureRoot).filter(
  (name) => name.endsWith(".json") && !name.endsWith(".bytes.json")
);
test("pins all committed identity vectors and their lossless copies", () => {
  expect(fixtureFiles).toHaveLength(27);
  let identities = 0;
  for (const file of fixtureFiles) {
    const fixture = object(
      JSON.parse(readFileSync(path.join(fixtureRoot, file), "utf-8"))
    );
    const copy = object(
      JSON.parse(
        readFileSync(
          path.join(fixtureRoot, file.replace(".json", ".bytes.json")),
          "utf-8"
        )
      )
    );
    const keys = Object.keys(fixture).filter((key) =>
      key.endsWith("Sha256Hex")
    );
    expect(
      Object.keys(object(copy.expected)).filter((key) =>
        key.endsWith("Sha256Hex")
      )
    ).toEqual(keys);
    for (const [field, recordType] of Object.entries(families)) {
      if (recordType !== "opaque-object" && fixture[field] !== undefined) {
        expect(
          Buffer.from(encodeIdentity(recordType, fixture[field])).toString(
            "hex"
          )
        ).toBe(
          Buffer.from(
            encodeIdentity(recordType, object(copy.input)[field])
          ).toString("hex")
        );
      }
    }
    identities += keys.length;
  }
  expect(identities).toBe(60);
});

for (const file of fixtureFiles) {
  const fixture = object(
    JSON.parse(readFileSync(path.join(fixtureRoot, file), "utf-8"))
  );
  for (const [field, recordType] of Object.entries(families)) {
    const expected = fixture[`${field}Sha256Hex`];
    if (typeof expected !== "string") {
      continue;
    }
    test(`${file}: integrity assertions recompute the committed ${recordType} vector and reject corruption`, () => {
      const copy = object(
        JSON.parse(
          readFileSync(
            path.join(fixtureRoot, file.replace(".json", ".bytes.json")),
            "utf-8"
          )
        )
      );
      const value = object(copy.input)[field];
      const encoded =
        recordType === "opaque-object"
          ? value
          : object(copy.expected)[`${field}CborBytes`];
      const result = {
        encoded,
        hash: expected,
        links: {
          hash: expected,
          heads: [["main", expected]],
          manifest: { $map: [["objects", [expected, expected]]] },
          parents: [{ previousTurnNodeHash: expected }],
          staged: [{ objectHash: expected }],
        },
        records: [{ hash: expected, value }],
        singleton: value,
        value,
      };
      const assertions: [
        ConformancePlanAssertion,
        ConformancePlanAssertion,
        ConformancePlanAssertion,
        ConformancePlanAssertion,
      ] = [
        {
          equalsPath: "$.result.hash",
          kind: "digest",
          path: "$.result.encoded",
        },
        {
          equalsPath: "$.result.encoded",
          kind: "canonicalCbor",
          path: "$.result.value",
          recordType,
        },
        {
          equalsPath: "$.result.hash",
          kind: "identity",
          path: "$.result.value",
          recordType,
        },
        {
          kind: "referenceWalk",
          path: "$.result.links",
          references: [
            {
              path: "$.hash",
              recordType,
              targetPath: "$.result.records",
              valuePath: "$.value",
            },
            { path: "$.hash", recordType, targetPath: "$.result.singleton" },
            ...[
              "$.parents.*.previousTurnNodeHash",
              "$.heads.*.1",
              "$.staged.*.objectHash",
              "$.manifest.$map.*.1",
            ].map((referencePath) => ({
              length: referencePath.includes("manifest") ? 2 : 1,
              path: referencePath,
              recordType,
              targetPath: "$.result.records",
              valuePath: "$.value",
            })),
          ],
        },
      ];
      for (const assertion of assertions) {
        expect(status(assertion, result)).toBe(
          expectedIntegrityStatus(assertion, value, expected)
        );
      }
      const encodedHex = object(encoded).$bytes;
      if (typeof encodedHex !== "string") {
        throw new TypeError("expected bytes");
      }
      expect(
        status(assertions[0], {
          ...result,
          encoded: bytes(flip(encodedHex)),
        })
      ).toBe("fail");
      expect(
        status(assertions[1], {
          ...result,
          encoded: bytes(flip(encodedHex)),
        })
      ).toBe("fail");
      expect(
        status(assertions[2], {
          ...result,
          hash: flip(expected),
        })
      ).toBe("fail");
      expect(
        status(assertions[3], {
          ...result,
          links: { ...result.links, hash: flip(expected) },
        })
      ).toBe("fail");
      const changed = structuredClone(value);
      if (recordType === "opaque-object") {
        object(changed).$bytes = flip(String(object(changed).$bytes));
      } else if (recordType === "turn-node") {
        object(changed).turnTreeHash = flip(
          String(object(changed).turnTreeHash)
        );
      } else {
        object(changed).schemaId =
          `${String(object(changed).schemaId)}-altered`;
      }
      const corrupted = {
        ...result,
        encoded: bytes(
          Buffer.from(encodeIdentity(recordType, changed)).toString("hex")
        ),
        records: [{ hash: expected, value: changed }],
        singleton: changed,
        value: changed,
      };
      for (const assertion of assertions) {
        expect(
          status(
            assertion,
            assertion.kind === "canonicalCbor"
              ? { ...corrupted, encoded: result.encoded }
              : corrupted
          )
        ).toBe("fail");
      }
      if (recordType === "turn-node" || recordType === "schema") {
        const withoutOptional = structuredClone(value);
        const optionalRecords =
          recordType === "turn-node"
            ? object(withoutOptional).consumedStagedResults
            : object(withoutOptional).paths;
        if (!Array.isArray(optionalRecords)) {
          throw new TypeError("missing vector records");
        }
        const optionalField =
          recordType === "turn-node" ? "interruptPayload" : "metadata";
        const optional: unknown = optionalRecords.find((entry: unknown) =>
          Object.hasOwn(object(entry), optionalField)
        );
        if (optional !== undefined) {
          if (optionalField === "interruptPayload") {
            delete object(optional).interruptPayload;
          } else {
            delete object(optional).metadata;
          }
          const dropped = {
            ...result,
            encoded: bytes(
              Buffer.from(encodeIdentity(recordType, withoutOptional)).toString(
                "hex"
              )
            ),
            records: [{ hash: expected, value: withoutOptional }],
            singleton: withoutOptional,
            value: withoutOptional,
          };
          for (const assertion of assertions) {
            expect(
              status(
                assertion,
                assertion.kind === "canonicalCbor"
                  ? { ...dropped, encoded: result.encoded }
                  : dropped
              )
            ).toBe("fail");
          }
        }
      }
      for (const assertion of assertions) {
        const [diagnosis] = diagnoseAssertions(check(assertion), {});
        expect(diagnosis?.evaluation.status).toBe("fail");
        expect(diagnosis?.unresolved).toBe(true);
      }
    });
  }
}

test("noncanonical map byte order is rejected while JSON insertion order is immaterial", () => {
  const value = { manifest: { a: null, z: null }, schemaId: "s" };
  const canonical = bytes(
    "a2686d616e6966657374a26161f6617af668736368656d6149646173"
  );
  const reordered = bytes(
    "a268736368656d6149646173686d616e6966657374a2617af66161f6"
  );
  const assertion: ConformancePlanAssertion = {
    equalsPath: "$.result.encoded",
    kind: "canonicalCbor",
    path: "$.result.value",
    recordType: "turn-tree",
  };
  expect(status(assertion, { encoded: canonical, value })).toBe("pass");
  expect(status(assertion, { encoded: reordered, value })).toBe("fail");
  expect(
    status(assertion, {
      encoded: canonical,
      value: { manifest: { a: null, z: null }, schemaId: "s" },
    })
  ).toBe("pass");
});

test("optional-field removal and altered references invalidate content integrity", () => {
  const fixture = object(
    JSON.parse(
      readFileSync(
        path.join(
          fixtureRoot,
          "kernel-protocol-staged-result-interrupted.bytes.json"
        ),
        "utf-8"
      )
    )
  );
  const value = object(
    structuredClone(object(fixture.input).turnNodeIdentityRecord)
  );
  const staged = value.consumedStagedResults;
  if (!Array.isArray(staged)) {
    throw new TypeError("expected staged results");
  }
  delete object(staged[0]).interruptPayload;
  const expected = object(fixture.expected);
  for (const assertion of [
    {
      equalsPath: "$.result.encoded",
      kind: "canonicalCbor",
      path: "$.result.value",
      recordType: "turn-node",
    },
    {
      equalsPath: "$.result.hash",
      kind: "identity",
      path: "$.result.value",
      recordType: "turn-node",
    },
    {
      kind: "referenceWalk",
      path: "$.result.links",
      references: [
        {
          path: "$.hash",
          recordType: "turn-node",
          targetPath: "$.result.records",
          valuePath: "$.value",
        },
      ],
    },
  ] satisfies ConformancePlanAssertion[]) {
    expect(
      status(assertion, {
        encoded: expected.turnNodeIdentityRecordCborBytes,
        hash: expected.turnNodeIdentityRecordSha256Hex,
        links: { hash: expected.turnNodeIdentityRecordSha256Hex },
        records: [{ hash: expected.turnNodeIdentityRecordSha256Hex, value }],
        value,
      })
    ).toBe("fail");
  }
});

test("reference walks require resolved targets and explicit collection cardinality", () => {
  const reference = {
    path: "$.hashes",
    recordType: "opaque-object",
    targetPath: "$.result.records",
    valuePath: "$.bytes",
  };
  const assertion: ConformancePlanAssertion = {
    kind: "referenceWalk",
    path: "$.result.links",
    references: [reference],
  };
  expect(status(assertion, { links: { hashes: [] }, records: [] })).toBe(
    "fail"
  );
  expect(
    status(
      { ...assertion, references: [{ ...reference, length: 0 }] },
      { links: { hashes: [] }, records: [] }
    )
  ).toBe("pass");
  expect(
    status(
      {
        ...assertion,
        references: [{ ...reference, length: 0, path: "$.missing" }],
      },
      { links: {}, records: [] }
    )
  ).toBe("fail");
  expect(
    diagnoseAssertions(check(assertion), {
      result: { links: { hashes: [] } },
    })[0]?.unresolved
  ).toBe(true);
});

test("tagged maps preserve text keys that resemble transport tags", () => {
  const assertion: ConformancePlanAssertion = {
    equalsPath: "$.result.encoded",
    kind: "canonicalCbor",
    path: "$.result.value",
    recordType: "turn-tree",
  };
  const prefix = "a2686d616e6966657374";
  const suffix = "68736368656d6149646173";
  expect(
    status(assertion, {
      encoded: bytes(`${prefix}a166246279746573820001${suffix}`),
      value: { manifest: { $map: [["$bytes", [0, 1]]] }, schemaId: "s" },
    })
  ).toBe("pass");
  expect(
    status(assertion, {
      encoded: bytes(`${prefix}a2616101616102${suffix}`),
      value: {
        manifest: {
          $map: [
            ["a", 1],
            ["a", 2],
          ],
        },
        schemaId: "s",
      },
    })
  ).toBe("fail");
});
