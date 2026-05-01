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
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
 * implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import type {
  BranchHeadListEntry,
  BranchRecord,
  ObserveResult,
  RecoveryState,
  RunRecord,
  SetHeadResult,
  StagedResult,
  StepContext,
  StoredFlatOrderedTurnTreePath,
  StoredSingleTurnTreePath,
  StoredStagedResult,
  ThreadCreateResult,
  ThreadRecord,
  TurnNode,
  TurnRecord,
  TurnTreeChangeSet,
  TurnTreeSchema,
} from "@tuvren/kernel-protocol";
import { encodeDeterministicKernelRecord } from "@tuvren/kernel-protocol";

// Binding-local probes only: kernel protocol authority remains in neutral
// conformance fixtures/specs, not in this TypeScript test harness.
const orderedPathHashes = [
  "5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f",
  "6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a",
];

const orderedChunkHashes = [
  "7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b",
  "8c8c8c8c8c8c8c8c8c8c8c8c8c8c8c8c8c8c8c8c8c8c8c8c8c8c8c8c8c8c8c8c",
];

const turnTreeSchemaRecord: TurnTreeSchema = {
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
      metadata: { role: "chat" },
      path: "messages",
    },
    {
      collection: "single",
      metadata: { version: 1 },
      path: "context.manifest",
    },
  ],
  schemaId: "schema_main",
};

const turnNodeIdentityRecord: Omit<TurnNode, "hash"> = {
  consumedStagedResults: [
    {
      objectHash:
        "3333333333333333333333333333333333333333333333333333333333333333",
      objectType: "tool_result",
      status: "completed",
      taskId: "tool_call_1",
      timestamp: 1_717_171_717_171,
    },
  ],
  eventHash: "4444444444444444444444444444444444444444444444444444444444444444",
  previousTurnNodeHash: null,
  schemaId: "schema_main",
  turnTreeHash:
    "2222222222222222222222222222222222222222222222222222222222222222",
};

function bytesFromHex(hex: string): Uint8Array {
  return Uint8Array.from(Buffer.from(hex, "hex"));
}

export const kernelProtocolDeterministicFixtures = {
  rawOpaqueBytes: new Uint8Array([0, 1, 2, 3, 4, 5, 250, 255]),
  rawOpaqueBytesSha256Hex:
    "68e4b69f67af1d263b6c6818ef79cb2c48aa3f18bec18b7436806a316cb4204c",
  turnNodeIdentityRecord,
  turnNodeIdentityRecordCborHex:
    "a568736368656d6149646b736368656d615f6d61696e696576656e74486173687840343434343434343434343434343434343434343434343434343434343434343434343434343434343434343434343434343434343434343434343434343434346c7475726e54726565486173687840323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232327470726576696f75735475726e4e6f646548617368f675636f6e73756d6564537461676564526573756c747381a56673746174757369636f6d706c65746564667461736b49646b746f6f6c5f63616c6c5f316974696d657374616d701b0000018fcf6904336a6f626a656374486173687840333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333336a6f626a656374547970656b746f6f6c5f726573756c74",
  turnNodeIdentityRecordSha256Hex:
    "44ab935c53fcd44b91ede01abf694507fa9605827db0b93185e2a72f13814bbb",
  turnTreeSchemaRecord,
  turnTreeSchemaRecordCborHex:
    "a365706174687382a36470617468686d65737361676573686d65746164617461a164726f6c6564636861746a636f6c6c656374696f6e676f726465726564a3647061746870636f6e746578742e6d616e6966657374686d65746164617461a16776657273696f6e016a636f6c6c656374696f6e6673696e676c6568736368656d6149646b736368656d615f6d61696e72696e636f72706f726174696f6e52756c657382a26a6f626a65637454797065676d6573736167656a74617267657450617468686d65737361676573a26a6f626a6563745479706570636f6e746578745f6d616e69666573746a7461726765745061746870636f6e746578742e6d616e6966657374",
  turnTreeSchemaRecordSha256Hex:
    "addd90a22e8a72dc1aad6011e78dc324dba747ab380cb78b9b50f2a9dc33b098",
  storedOrderedPathChunkItemsCborHex:
    "82784037623762376237623762376237623762376237623762376237623762376237623762376237623762376237623762376237623762376237623762376237623762784038633863386338633863386338633863386338633863386338633863386338633863386338633863386338633863386338633863386338633863386338633863",
  storedRunCreatedTurnNodesCborHex:
    "81784066666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666",
  storedRunStepSequenceCborHex:
    "81a46269646a6d6f64656c5f63616c6c686d65746164617461a165706861736569726561736f6e696e676b7369646545666665637473f46d64657465726d696e6973746963f4",
  storedSchemaSchemaCborHex:
    "a365706174687382a36470617468686d65737361676573686d65746164617461a164726f6c6564636861746a636f6c6c656374696f6e676f726465726564a3647061746870636f6e746578742e6d616e6966657374686d65746164617461a16776657273696f6e016a636f6c6c656374696f6e6673696e676c6568736368656d6149646b736368656d615f6d61696e72696e636f72706f726174696f6e52756c657382a26a6f626a65637454797065676d6573736167656a74617267657450617468686d65737361676573a26a6f626a6563745479706570636f6e746578745f6d616e69666573746a7461726765745061746870636f6e746578742e6d616e6966657374",
  storedStagedResultInterruptPayloadCborHex:
    "a166726561736f6e716177616974696e675f617070726f76616c",
  storedTurnNodeConsumedStagedResultsCborHex:
    "81a56673746174757369636f6d706c65746564667461736b49646d6d73675f617373697374616e746974696d657374616d701b0000018fcf6904336a6f626a656374486173687840313631363136313631363136313631363136313631363136313631363136313631363136313631363136313631363136313631363136313631363136313631366a6f626a65637454797065676d657373616765",
  storedTurnTreeManifestCborHex:
    "a2686d657373616765738178403233323332333233323332333233323332333233323332333233323332333233323332333233323332333233323332333233323332333233323332333233323370636f6e746578742e6d616e6966657374784032323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232",
  storedTurnTreePathOrderedInlineCborHex:
    "82784035663566356635663566356635663566356635663566356635663566356635663566356635663566356635663566356635663566356635663566356635663566784036613661366136613661366136613661366136613661366136613661366136613661366136613661366136613661366136613661366136613661366136613661",
};

export const kernelProtocolLogicalFixtures = {
  branchHeadListEntry: [
    "branch_main",
    "9999999999999999999999999999999999999999999999999999999999999999",
  ] satisfies BranchHeadListEntry,
  branchRecord: {
    branchId: "branch_main",
    headTurnNodeHash:
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    threadId: "thread_main",
  } satisfies BranchRecord,
  observeResult: {
    annotations: [{ kind: "note", severity: 1 }],
    signals: [{ kind: "post_step", severity: 1 }],
  } satisfies ObserveResult,
  recoveryState: {
    consumedStagedResults: [
      {
        objectHash:
          "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        objectType: "message",
        status: "completed",
        taskId: "msg_assistant",
        timestamp: 1_717_171_717_171,
      },
    ],
    lastCompletedStepId: "tool_execution",
    lastTurnNodeHash:
      "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    stepSequence: [
      {
        deterministic: false,
        id: "model_call",
        metadata: { phase: "reasoning" },
        sideEffects: false,
      },
      {
        deterministic: false,
        id: "tool_execution",
        metadata: { phase: "tooling" },
        sideEffects: true,
      },
    ],
    uncommittedStagedResults: [
      {
        interruptPayload: { reason: "awaiting_approval" },
        objectHash:
          "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
        objectType: "tool_result",
        status: "interrupted",
        taskId: "tool_call_pending",
        timestamp: 1_717_171_717_272,
      },
    ],
  } satisfies RecoveryState,
  runRecord: {
    branchId: "branch_main",
    createdTurnNodes: [
      "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    ],
    currentStepIndex: 0,
    runId: "run_main",
    schemaId: "schema_main",
    startTurnNodeHash:
      "abababababababababababababababababababababababababababababababab",
    status: "running",
    stepSequence: [
      {
        deterministic: false,
        id: "model_call",
        metadata: { phase: "reasoning" },
        sideEffects: false,
      },
    ],
    turnId: "turn_main",
  } satisfies RunRecord,
  setHeadResult: {
    archiveBranch: {
      branchId: "branch_archive",
      headTurnNodeHash:
        "cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd",
      threadId: "thread_main",
    },
    branch: {
      branchId: "branch_main",
      headTurnNodeHash:
        "dededededededededededededededededededededededededededededededede",
      threadId: "thread_main",
    },
  } satisfies SetHeadResult,
  stagedResult: {
    interruptPayload: { reason: "awaiting_approval" },
    objectHash:
      "efefefefefefefefefefefefefefefefefefefefefefefefefefefefefefefef",
    objectType: "tool_result",
    status: "interrupted",
    taskId: "tool_call_pending",
    timestamp: 1_717_171_717_272,
  } satisfies StagedResult,
  stepContext: {
    currentTurnNodeHash:
      "1212121212121212121212121212121212121212121212121212121212121212",
    schema: {
      incorporationRules: [
        { objectType: "message", targetPath: "messages" },
        { objectType: "runtime_status", targetPath: "runtime.status" },
      ],
      paths: [
        { collection: "ordered", path: "messages" },
        { collection: "single", path: "runtime.status" },
      ],
      schemaId: "schema_main",
    },
    signals: [{ kind: "carry_forward", count: 1 }],
    step: {
      deterministic: false,
      id: "tool_execution",
      metadata: { phase: "tooling" },
      sideEffects: true,
    },
  } satisfies StepContext,
  threadCreateResult: {
    branchId: "branch_main",
    rootTurnNodeHash:
      "1313131313131313131313131313131313131313131313131313131313131313",
    rootTurnTreeHash:
      "1414141414141414141414141414141414141414141414141414141414141414",
    threadId: "thread_main",
  } satisfies ThreadCreateResult,
  threadRecord: {
    rootTurnNodeHash:
      "1515151515151515151515151515151515151515151515151515151515151515",
    schemaId: "schema_main",
    threadId: "thread_main",
  } satisfies ThreadRecord,
  turnNode: {
    consumedStagedResults: [
      {
        objectHash:
          "1616161616161616161616161616161616161616161616161616161616161616",
        objectType: "message",
        status: "completed",
        taskId: "msg_assistant",
        timestamp: 1_717_171_717_171,
      },
    ],
    eventHash:
      "1717171717171717171717171717171717171717171717171717171717171717",
    hash: "2745372e24f80a65dd93639b70854a40710a82b033a0c5d4ffa0235ca06a306e",
    previousTurnNodeHash: null,
    schemaId: "schema_main",
    turnTreeHash:
      "1919191919191919191919191919191919191919191919191919191919191919",
  } satisfies TurnNode,
  turnRecord: {
    branchId: "branch_main",
    headTurnNodeHash:
      "2020202020202020202020202020202020202020202020202020202020202020",
    parentTurnId: null,
    startTurnNodeHash:
      "2121212121212121212121212121212121212121212121212121212121212121",
    threadId: "thread_main",
    turnId: "turn_main",
  } satisfies TurnRecord,
  turnTreeChangeSet: {
    "context.manifest":
      "2222222222222222222222222222222222222222222222222222222222222222",
    messages: [
      "2323232323232323232323232323232323232323232323232323232323232323",
    ],
  } satisfies TurnTreeChangeSet,
};

export const kernelProtocolStoredFixtures = {
  storedBranch: {
    archivedFromBranchId: "branch_archive",
    branchId: "branch_main",
    createdAtMs: 1_717_171_717_171,
    headTurnNodeHash:
      "2424242424242424242424242424242424242424242424242424242424242424",
    threadId: "thread_main",
    updatedAtMs: 1_717_171_717_272,
  },
  storedObject: {
    byteLength: 4,
    bytes: new Uint8Array([1, 2, 3, 4]),
    createdAtMs: 1_717_171_717_171,
    hash: "9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a",
    mediaType: "application/json",
  },
  storedOrderedPathChunk: {
    chunkHash:
      "f44cfe9356859374d8600ab20def5ea4a4c91a8bd7f13ea6def7959080bf2584",
    createdAtMs: 1_717_171_717_171,
    itemCount: 2,
    itemsCbor: bytesFromHex(
      kernelProtocolDeterministicFixtures.storedOrderedPathChunkItemsCborHex
    ),
  },
  storedRun: {
    branchId: "branch_main",
    createdAtMs: 1_717_171_717_171,
    createdTurnNodesCbor: bytesFromHex(
      kernelProtocolDeterministicFixtures.storedRunCreatedTurnNodesCborHex
    ),
    currentStepIndex: 1,
    runId: "run_main",
    schemaId: "schema_main",
    startTurnNodeHash:
      "2727272727272727272727272727272727272727272727272727272727272727",
    status: "paused",
    stepSequenceCbor: bytesFromHex(
      kernelProtocolDeterministicFixtures.storedRunStepSequenceCborHex
    ),
    turnId: "turn_main",
    updatedAtMs: 1_717_171_717_272,
  },
  storedSchema: {
    createdAtMs: 1_717_171_717_171,
    schemaCbor: bytesFromHex(
      kernelProtocolDeterministicFixtures.storedSchemaSchemaCborHex
    ),
    schemaId: "schema_main",
  },
  storedStagedResult: {
    createdAtMs: 1_717_171_717_171,
    interruptPayloadCbor: bytesFromHex(
      kernelProtocolDeterministicFixtures.storedStagedResultInterruptPayloadCborHex
    ),
    objectHash:
      "2828282828282828282828282828282828282828282828282828282828282828",
    objectType: "tool_result",
    runId: "run_main",
    status: "interrupted",
    taskId: "tool_call_pending",
  } satisfies StoredStagedResult,
  storedThread: {
    createdAtMs: 1_717_171_717_171,
    rootTurnNodeHash:
      "2929292929292929292929292929292929292929292929292929292929292929",
    schemaId: "schema_main",
    threadId: "thread_main",
  },
  storedTurn: {
    branchId: "branch_main",
    createdAtMs: 1_717_171_717_171,
    headTurnNodeHash:
      "3030303030303030303030303030303030303030303030303030303030303030",
    parentTurnId: null,
    startTurnNodeHash:
      "3131313131313131313131313131313131313131313131313131313131313131",
    threadId: "thread_main",
    turnId: "turn_main",
    updatedAtMs: 1_717_171_717_272,
  },
  storedTurnNode: {
    consumedStagedResultsCbor: bytesFromHex(
      kernelProtocolDeterministicFixtures.storedTurnNodeConsumedStagedResultsCborHex
    ),
    createdAtMs: 1_717_171_717_171,
    eventHash:
      "3232323232323232323232323232323232323232323232323232323232323232",
    hash: "9f673cb7c64a109783e80543568729059f7473ea3422db40eca33719c3ee7f7e",
    previousTurnNodeHash: null,
    schemaId: "schema_main",
    turnTreeHash:
      "3434343434343434343434343434343434343434343434343434343434343434",
  },
  storedTurnTree: {
    createdAtMs: 1_717_171_717_171,
    hash: "98d7b1f35f6ebf506508b1bfbd6be173147a80bc85917a17756c66d97faf8b87",
    manifestCbor: bytesFromHex(
      kernelProtocolDeterministicFixtures.storedTurnTreeManifestCborHex
    ),
    schemaId: "schema_main",
  },
  storedTurnTreePath: {
    collectionKind: "single",
    path: "context.manifest",
    singleHash:
      "2222222222222222222222222222222222222222222222222222222222222222",
    turnTreeHash:
      "98d7b1f35f6ebf506508b1bfbd6be173147a80bc85917a17756c66d97faf8b87",
  } satisfies StoredSingleTurnTreePath,
  storedTurnTreePathOrdered: {
    collectionKind: "ordered",
    orderedCount: 2,
    orderedEncoding: "flat",
    orderedInlineCbor: bytesFromHex(
      kernelProtocolDeterministicFixtures.storedTurnTreePathOrderedInlineCborHex
    ),
    path: "messages",
    turnTreeHash:
      "98d7b1f35f6ebf506508b1bfbd6be173147a80bc85917a17756c66d97faf8b87",
  } satisfies StoredFlatOrderedTurnTreePath,
};

export const kernelProtocolInvalidFixtures = {
  invalidBranchHeadListEntry: ["", "not_a_hash"],
  duplicatePathSchema: {
    incorporationRules: [{ objectType: "message", targetPath: "messages" }],
    paths: [
      { collection: "ordered", path: "messages" },
      { collection: "ordered", path: "messages" },
    ],
    schemaId: "schema_main",
  },
  duplicateRuleSchema: {
    incorporationRules: [
      { objectType: "message", targetPath: "messages" },
      { objectType: "message", targetPath: "messages" },
    ],
    paths: [{ collection: "ordered", path: "messages" }],
    schemaId: "schema_main",
  },
  invalidObserveResult: {
    annotations: ["note"],
    signals: ["okay"],
  },
  invalidSchemaPathSchema: {
    incorporationRules: [],
    paths: [{ collection: "ordered", path: "messages..results" }],
    schemaId: "schema_main",
  },
  invalidNonCanonicalKernelRecordBytes: Uint8Array.from(
    Buffer.from("fb41f0000000000000", "hex")
  ),
  invalidTruncatedKernelRecordBytes: Uint8Array.from([130, 1]),
  invalidNonCanonicalKernelNumberBytes: {
    float: Uint8Array.from(Buffer.from("fb3ff8000000000000", "hex")),
    infinity: Uint8Array.from(Buffer.from("f97c00", "hex")),
    nan: Uint8Array.from(Buffer.from("f97e00", "hex")),
  },
  invalidRunRecordPastStepSequence: {
    branchId: "branch_main",
    createdTurnNodes: [],
    currentStepIndex: 5,
    runId: "run_main",
    schemaId: "schema_main",
    startTurnNodeHash:
      "4545454545454545454545454545454545454545454545454545454545454545",
    status: "running",
    stepSequence: [
      {
        deterministic: false,
        id: "model_call",
        sideEffects: false,
      },
    ],
    turnId: "turn_main",
  },
  invalidRunningRunRecordAtSequenceEnd: {
    branchId: "branch_main",
    createdTurnNodes: [],
    currentStepIndex: 1,
    runId: "run_main",
    schemaId: "schema_main",
    startTurnNodeHash:
      "4545454545454545454545454545454545454545454545454545454545454546",
    status: "running",
    stepSequence: [
      {
        deterministic: false,
        id: "model_call",
        sideEffects: false,
      },
    ],
    turnId: "turn_main",
  },
  invalidRunningRunRecordWithEmptyStepSequence: {
    branchId: "branch_main",
    createdTurnNodes: [],
    currentStepIndex: 0,
    runId: "run_main",
    schemaId: "schema_main",
    startTurnNodeHash:
      "4545454545454545454545454545454545454545454545454545454545454547",
    status: "running",
    stepSequence: [],
    turnId: "turn_main",
  },
  invalidCompletedRunRecordBeforeSequenceEnd: {
    branchId: "branch_main",
    createdTurnNodes: [],
    currentStepIndex: 0,
    runId: "run_main",
    schemaId: "schema_main",
    startTurnNodeHash:
      "4545454545454545454545454545454545454545454545454545454545454548",
    status: "completed",
    stepSequence: [
      {
        deterministic: false,
        id: "model_call",
        sideEffects: false,
      },
    ],
    turnId: "turn_main",
  },
  invalidSchemaWithAccessorPathMetadata: (() => {
    const pathDefinition = { path: "messages", collection: "ordered" };
    Object.defineProperty(pathDefinition, "metadata", {
      enumerable: true,
      get() {
        return { phase: "x" };
      },
    });

    return {
      schemaId: "schema_main",
      paths: [pathDefinition],
      incorporationRules: [],
    };
  })(),
  invalidSchemaWithSymbolKey: (() => {
    const schema: Record<PropertyKey, unknown> = {
      schemaId: "schema_main",
      paths: [{ path: "messages", collection: "ordered" }],
      incorporationRules: [],
    };
    schema[Symbol("meta")] = 1;
    return schema;
  })(),
  invalidSchemaWithDateMetadata: {
    incorporationRules: [],
    paths: [
      {
        collection: "ordered",
        metadata: new Date("2026-01-01T00:00:00.000Z"),
        path: "messages",
      },
    ],
    schemaId: "schema_main",
  },
  invalidSchemaWithConflictingDuplicatePathDefinitions: {
    incorporationRules: [],
    paths: [
      { collection: "ordered", path: "messages" },
      { collection: "single", path: "messages" },
    ],
    schemaId: "schema_main",
  },
  invalidSchemaWithNonDensePathsArray: (() => {
    const paths = Object.assign([{ collection: "ordered", path: "messages" }], {
      meta: 1,
    });

    return {
      incorporationRules: [],
      paths,
      schemaId: "schema_main",
    };
  })(),
  invalidSparseOrderedPathValue: new Array(1),
  invalidArrayWithAccessorIndex: (() => {
    const arrayValue = [
      "4646464646464646464646464646464646464646464646464646464646464646",
    ];
    Object.defineProperty(arrayValue, "0", {
      enumerable: true,
      get() {
        return "4646464646464646464646464646464646464646464646464646464646464646";
      },
    });
    return arrayValue;
  })(),
  invalidArrayWithEnumerableMetadata: (() => {
    const arrayValue = [
      "4747474747474747474747474747474747474747474747474747474747474747",
    ];
    Object.defineProperty(arrayValue, "meta", {
      enumerable: true,
      value: 1,
    });
    return arrayValue;
  })(),
  invalidStagedResultWithCompletedInterruptPayload: {
    interruptPayload: { reason: "should_not_exist" },
    objectHash:
      "3737373737373737373737373737373737373737373737373737373737373737",
    objectType: "tool_result",
    status: "completed",
    taskId: "tool_call_done",
    timestamp: 1_717_171_717_272,
  },
  invalidStoredObjectByteLength: {
    byteLength: 999,
    bytes: new Uint8Array([1, 2, 3, 4]),
    createdAtMs: 1_717_171_717_171,
    hash: "3838383838383838383838383838383838383838383838383838383838383838",
    mediaType: "application/json",
  },
  invalidStoredObjectMismatchedHash: {
    byteLength: 4,
    bytes: new Uint8Array([1, 2, 3, 4]),
    createdAtMs: 1_717_171_717_171,
    hash: "5353535353535353535353535353535353535353535353535353535353535353",
    mediaType: "application/json",
  },
  invalidStoredStagedResultWithCompletedInterruptPayload: {
    createdAtMs: 1_717_171_717_171,
    interruptPayloadCbor: encodeDeterministicKernelRecord({
      reason: "should_not_exist",
    }),
    objectHash:
      "3939393939393939393939393939393939393939393939393939393939393939",
    objectType: "tool_result",
    runId: "run_main",
    status: "completed",
    taskId: "tool_call_done",
  },
  invalidStoredRunPastStepSequence: {
    branchId: "branch_main",
    createdAtMs: 1_717_171_717_171,
    createdTurnNodesCbor: encodeDeterministicKernelRecord([]),
    currentStepIndex: 5,
    runId: "run_main",
    schemaId: "schema_main",
    startTurnNodeHash:
      "3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c",
    status: "running",
    stepSequenceCbor: encodeDeterministicKernelRecord([
      {
        deterministic: false,
        id: "model_call",
        sideEffects: false,
      },
    ]),
    turnId: "turn_main",
    updatedAtMs: 1_717_171_717_272,
  },
  invalidStoredRunningRunAtSequenceEnd: {
    branchId: "branch_main",
    createdAtMs: 1_717_171_717_171,
    createdTurnNodesCbor: encodeDeterministicKernelRecord([]),
    currentStepIndex: 1,
    runId: "run_main",
    schemaId: "schema_main",
    startTurnNodeHash:
      "3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3d",
    status: "running",
    stepSequenceCbor: encodeDeterministicKernelRecord([
      {
        deterministic: false,
        id: "model_call",
        sideEffects: false,
      },
    ]),
    turnId: "turn_main",
    updatedAtMs: 1_717_171_717_272,
  },
  invalidStoredRunningRunWithEmptyStepSequence: {
    branchId: "branch_main",
    createdAtMs: 1_717_171_717_171,
    createdTurnNodesCbor: encodeDeterministicKernelRecord([]),
    currentStepIndex: 0,
    runId: "run_main",
    schemaId: "schema_main",
    startTurnNodeHash:
      "3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3e",
    status: "running",
    stepSequenceCbor: encodeDeterministicKernelRecord([]),
    turnId: "turn_main",
    updatedAtMs: 1_717_171_717_272,
  },
  invalidStoredCompletedRunBeforeSequenceEnd: {
    branchId: "branch_main",
    createdAtMs: 1_717_171_717_171,
    createdTurnNodesCbor: encodeDeterministicKernelRecord([]),
    currentStepIndex: 0,
    runId: "run_main",
    schemaId: "schema_main",
    startTurnNodeHash:
      "3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3f",
    status: "completed",
    stepSequenceCbor: encodeDeterministicKernelRecord([
      {
        deterministic: false,
        id: "model_call",
        sideEffects: false,
      },
    ]),
    turnId: "turn_main",
    updatedAtMs: 1_717_171_717_272,
  },
  invalidStoredRunWithMalformedCreatedTurnNodesCbor: {
    branchId: "branch_main",
    createdAtMs: 1_717_171_717_171,
    createdTurnNodesCbor: new Uint8Array([255]),
    currentStepIndex: 0,
    runId: "run_main",
    schemaId: "schema_main",
    startTurnNodeHash:
      "3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d",
    status: "running",
    stepSequenceCbor: encodeDeterministicKernelRecord([]),
    turnId: "turn_main",
    updatedAtMs: 1_717_171_717_272,
  },
  invalidStoredSchemaMismatchedSchemaId: {
    createdAtMs: 1_717_171_717_171,
    schemaCbor: encodeDeterministicKernelRecord({
      incorporationRules: [],
      paths: [{ collection: "ordered", path: "messages" }],
      schemaId: "inner_schema",
    }),
    schemaId: "outer_schema",
  },
  invalidStoredSchemaMalformedCbor: {
    createdAtMs: 1_717_171_717_171,
    schemaCbor: new Uint8Array([255]),
    schemaId: "schema_main",
  },
  invalidStoredStagedResultWithMalformedInterruptPayloadCbor: {
    createdAtMs: 1_717_171_717_171,
    interruptPayloadCbor: new Uint8Array([255]),
    objectHash:
      "3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e",
    objectType: "tool_result",
    runId: "run_main",
    status: "interrupted",
    taskId: "tool_call_pending",
  },
  invalidRecoveryStateWithUnknownCompletedStepId: {
    consumedStagedResults: [],
    lastCompletedStepId: "not_in_sequence",
    lastTurnNodeHash:
      "3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a",
    stepSequence: [
      {
        deterministic: false,
        id: "model_call",
        sideEffects: false,
      },
    ],
    uncommittedStagedResults: [],
  },
  invalidRecoveryStateWithConsumedResultsButNullCompletedStepId: {
    consumedStagedResults: [
      {
        interruptPayload: { reason: "awaiting_approval" },
        objectHash:
          "edededededededededededededededededededededededededededededededed",
        objectType: "tool_result",
        status: "interrupted",
        taskId: "tool_call_pending",
        timestamp: 1_717_171_717_272,
      },
    ],
    lastCompletedStepId: null,
    lastTurnNodeHash:
      "ecececececececececececececececececececececececececececececececec",
    stepSequence: [
      {
        deterministic: false,
        id: "model_call",
        sideEffects: false,
      },
    ],
    uncommittedStagedResults: [],
  },
  invalidStoredOrderedPathChunkCountMismatch: {
    chunkHash:
      "3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b",
    createdAtMs: 1_717_171_717_171,
    itemCount: 999,
    itemsCbor: encodeDeterministicKernelRecord([orderedChunkHashes[0]]),
  },
  invalidStoredOrderedPathChunkMismatchedHash: {
    chunkHash:
      "5959595959595959595959595959595959595959595959595959595959595959",
    createdAtMs: 1_717_171_717_171,
    itemCount: 2,
    itemsCbor: encodeDeterministicKernelRecord(orderedChunkHashes),
  },
  invalidStoredTurnNodeMismatchedHash: {
    consumedStagedResultsCbor: encodeDeterministicKernelRecord(
      kernelProtocolLogicalFixtures.turnNode.consumedStagedResults
    ),
    createdAtMs: 1_717_171_717_171,
    eventHash:
      "3232323232323232323232323232323232323232323232323232323232323232",
    hash: "5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a",
    previousTurnNodeHash: null,
    schemaId: "schema_main",
    turnTreeHash:
      "3434343434343434343434343434343434343434343434343434343434343434",
  },
  invalidStoredTurnNodeMalformedConsumedStagedResultsCbor: {
    consumedStagedResultsCbor: new Uint8Array([255]),
    createdAtMs: 1_717_171_717_171,
    eventHash:
      "3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f",
    hash: "5050505050505050505050505050505050505050505050505050505050505050",
    previousTurnNodeHash: null,
    schemaId: "schema_main",
    turnTreeHash:
      "5151515151515151515151515151515151515151515151515151515151515151",
  },
  invalidStoredTurnTreeMalformedManifestCbor: {
    createdAtMs: 1_717_171_717_171,
    hash: "5252525252525252525252525252525252525252525252525252525252525252",
    manifestCbor: new Uint8Array([255]),
    schemaId: "schema_main",
  },
  invalidStoredTurnTreeMismatchedHash: {
    createdAtMs: 1_717_171_717_171,
    hash: "5454545454545454545454545454545454545454545454545454545454545454",
    manifestCbor: encodeDeterministicKernelRecord(
      kernelProtocolLogicalFixtures.turnTreeChangeSet
    ),
    schemaId: "schema_main",
  },
  invalidStoredTurnTreePathMissingOrderedPayload: {
    collectionKind: "ordered",
    orderedCount: 2,
    orderedEncoding: "flat",
    path: "messages",
    turnTreeHash:
      "4040404040404040404040404040404040404040404040404040404040404040",
  },
  invalidStoredTurnTreePathSingleWithOrderedFields: {
    collectionKind: "single",
    orderedCount: 1,
    orderedEncoding: "flat",
    orderedInlineCbor: new Uint8Array([129, 1]),
    path: "context.manifest",
    singleHash: null,
    turnTreeHash:
      "4141414141414141414141414141414141414141414141414141414141414141",
  },
  invalidStoredTurnTreePathWithOrderedSingleHash: {
    collectionKind: "ordered",
    orderedCount: 2,
    orderedEncoding: "chunked",
    orderedChunkListCbor: new Uint8Array([129, 1]),
    path: "messages",
    singleHash:
      "4242424242424242424242424242424242424242424242424242424242424242",
    turnTreeHash:
      "4343434343434343434343434343434343434343434343434343434343434343",
  },
  invalidStoredTurnTreePathWithWrongEncodingPayload: {
    collectionKind: "ordered",
    orderedCount: 2,
    orderedEncoding: "flat",
    orderedChunkListCbor: new Uint8Array([129, 1]),
    orderedInlineCbor: new Uint8Array([130, 1, 2]),
    path: "messages",
    turnTreeHash:
      "4444444444444444444444444444444444444444444444444444444444444444",
  },
  invalidStoredTurnTreePathOrderedCountMismatch: {
    collectionKind: "ordered",
    orderedCount: 999,
    orderedEncoding: "flat",
    orderedInlineCbor: encodeDeterministicKernelRecord([orderedPathHashes[0]]),
    path: "messages",
    turnTreeHash:
      "4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a",
  },
  invalidStoredTurnTreePathChunkedWithoutChunkRefs: {
    collectionKind: "ordered",
    orderedCount: 1,
    orderedEncoding: "chunked",
    orderedChunkListCbor: encodeDeterministicKernelRecord([]),
    path: "messages",
    turnTreeHash:
      "5555555555555555555555555555555555555555555555555555555555555555",
  },
  invalidStoredTurnTreePathWithMalformedPath: {
    collectionKind: "single",
    path: "messages..results",
    singleHash:
      "5656565656565656565656565656565656565656565656565656565656565656",
    turnTreeHash:
      "5757575757575757575757575757575757575757575757575757575757575757",
  },
  unknownPathSchema: {
    incorporationRules: [{ objectType: "message", targetPath: "missing" }],
    paths: [{ collection: "ordered", path: "messages" }],
    schemaId: "schema_main",
  },
};
