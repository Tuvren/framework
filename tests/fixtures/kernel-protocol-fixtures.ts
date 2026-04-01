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

export const kernelProtocolDeterministicFixtures = {
  rawOpaqueBytes: new Uint8Array([0, 1, 2, 3, 4, 5, 250, 255]),
  rawOpaqueBytesSha256Hex:
    "68e4b69f67af1d263b6c6818ef79cb2c48aa3f18bec18b7436806a316cb4204c",
  turnNodeRecord: {
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
    createdAtMs: 1_717_171_717_272,
    eventHash:
      "4444444444444444444444444444444444444444444444444444444444444444",
    hash: "1111111111111111111111111111111111111111111111111111111111111111",
    previousTurnNodeHash: null,
    schemaId: "schema_main",
    turnTreeHash:
      "2222222222222222222222222222222222222222222222222222222222222222",
  },
  turnNodeRecordCborHex:
    "a7646861736878403131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313168736368656d6149646b736368656d615f6d61696e696576656e74486173687840343434343434343434343434343434343434343434343434343434343434343434343434343434343434343434343434343434343434343434343434343434346b6372656174656441744d731b0000018fcf6904986c7475726e54726565486173687840323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232327470726576696f75735475726e4e6f646548617368f675636f6e73756d6564537461676564526573756c747381a56673746174757369636f6d706c65746564667461736b49646b746f6f6c5f63616c6c5f316974696d657374616d701b0000018fcf6904336a6f626a656374486173687840333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333336a6f626a656374547970656b746f6f6c5f726573756c74",
  turnNodeRecordSha256Hex:
    "2ca9eee956ea5ac26d5108b6b4eea4955985920ce6883ffef59c1397883357bd",
  turnTreeSchemaRecord: {
    incorporationRules: [
      {
        objectType: "message",
        targetPath: "messages",
      },
      {
        objectType: "context_manifest",
        targetPath: "context_manifest",
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
        path: "context_manifest",
      },
    ],
    schemaId: "schema_main",
  },
  turnTreeSchemaRecordCborHex:
    "a365706174687382a36470617468686d65737361676573686d65746164617461a164726f6c6564636861746a636f6c6c656374696f6e676f726465726564a3647061746870636f6e746578745f6d616e6966657374686d65746164617461a16776657273696f6e016a636f6c6c656374696f6e6673696e676c6568736368656d6149646b736368656d615f6d61696e72696e636f72706f726174696f6e52756c657382a26a6f626a65637454797065676d6573736167656a74617267657450617468686d65737361676573a26a6f626a6563745479706570636f6e746578745f6d616e69666573746a7461726765745061746870636f6e746578745f6d616e6966657374",
  turnTreeSchemaRecordSha256Hex:
    "5a807487d01657c0aa1c567110af3f71fc487813e0d96d4f0a7436705a4cf14c",
};

export const kernelProtocolLogicalFixtures = {
  branchRecord: {
    archivedFromBranchId: "branch_archive",
    branchId: "branch_main",
    createdAtMs: 1_717_171_717_171,
    headTurnNodeHash:
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    threadId: "thread_main",
    updatedAtMs: 1_717_171_717_272,
  },
  observeResult: {
    annotations: [
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    ],
    signals: [{ kind: "post_step", severity: 1 }],
  },
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
  },
  runRecord: {
    branchId: "branch_main",
    createdAtMs: 1_717_171_717_171,
    createdTurnNodes: [
      "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    ],
    currentStepIndex: 1,
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
    updatedAtMs: 1_717_171_717_272,
  },
  setHeadResult: {
    archiveBranch: {
      branchId: "branch_archive",
      createdAtMs: 1_717_171_717_171,
      headTurnNodeHash:
        "cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd",
      threadId: "thread_main",
      updatedAtMs: 1_717_171_717_272,
    },
    branch: {
      branchId: "branch_main",
      createdAtMs: 1_717_171_717_171,
      headTurnNodeHash:
        "dededededededededededededededededededededededededededededededede",
      threadId: "thread_main",
      updatedAtMs: 1_717_171_717_272,
    },
  },
  stagedResult: {
    interruptPayload: { reason: "awaiting_approval" },
    objectHash:
      "efefefefefefefefefefefefefefefefefefefefefefefefefefefefefefefef",
    objectType: "tool_result",
    status: "interrupted",
    taskId: "tool_call_pending",
    timestamp: 1_717_171_717_272,
  },
  stepContext: {
    currentTurnNodeHash:
      "1212121212121212121212121212121212121212121212121212121212121212",
    schema: {
      incorporationRules: [{ objectType: "message", targetPath: "messages" }],
      paths: [{ collection: "ordered", path: "messages" }],
      schemaId: "schema_main",
    },
    signals: [{ kind: "carry_forward", count: 1 }],
    step: {
      deterministic: false,
      id: "tool_execution",
      metadata: { phase: "tooling" },
      sideEffects: true,
    },
  },
  threadCreateResult: {
    branchId: "branch_main",
    rootTurnNodeHash:
      "1313131313131313131313131313131313131313131313131313131313131313",
    rootTurnTreeHash:
      "1414141414141414141414141414141414141414141414141414141414141414",
    threadId: "thread_main",
  },
  threadRecord: {
    createdAtMs: 1_717_171_717_171,
    rootTurnNodeHash:
      "1515151515151515151515151515151515151515151515151515151515151515",
    schemaId: "schema_main",
    threadId: "thread_main",
  },
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
    createdAtMs: 1_717_171_717_272,
    eventHash:
      "1717171717171717171717171717171717171717171717171717171717171717",
    hash: "1818181818181818181818181818181818181818181818181818181818181818",
    previousTurnNodeHash: null,
    schemaId: "schema_main",
    turnTreeHash:
      "1919191919191919191919191919191919191919191919191919191919191919",
  },
  turnRecord: {
    branchId: "branch_main",
    createdAtMs: 1_717_171_717_171,
    headTurnNodeHash:
      "2020202020202020202020202020202020202020202020202020202020202020",
    parentTurnId: null,
    startTurnNodeHash:
      "2121212121212121212121212121212121212121212121212121212121212121",
    threadId: "thread_main",
    turnId: "turn_main",
    updatedAtMs: 1_717_171_717_272,
  },
  turnTreeChangeSet: {
    context_manifest:
      "2222222222222222222222222222222222222222222222222222222222222222",
    messages: [
      "2323232323232323232323232323232323232323232323232323232323232323",
    ],
  },
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
    hash: "2525252525252525252525252525252525252525252525252525252525252525",
    mediaType: "application/json",
  },
  storedOrderedPathChunk: {
    chunkHash:
      "2626262626262626262626262626262626262626262626262626262626262626",
    createdAtMs: 1_717_171_717_171,
    itemCount: 2,
    itemsCbor: new Uint8Array([130, 1, 2]),
  },
  storedRun: {
    branchId: "branch_main",
    createdAtMs: 1_717_171_717_171,
    createdTurnNodesCbor: new Uint8Array([129, 1]),
    currentStepIndex: 1,
    runId: "run_main",
    schemaId: "schema_main",
    startTurnNodeHash:
      "2727272727272727272727272727272727272727272727272727272727272727",
    status: "paused",
    stepSequenceCbor: new Uint8Array([129, 2]),
    turnId: "turn_main",
    updatedAtMs: 1_717_171_717_272,
  },
  storedSchema: {
    createdAtMs: 1_717_171_717_171,
    schemaCbor: new Uint8Array([161, 97, 97, 1]),
    schemaId: "schema_main",
  },
  storedStagedResult: {
    createdAtMs: 1_717_171_717_171,
    interruptPayloadCbor: new Uint8Array([
      161, 102, 114, 101, 97, 115, 111, 110,
    ]),
    objectHash:
      "2828282828282828282828282828282828282828282828282828282828282828",
    objectType: "tool_result",
    runId: "run_main",
    status: "interrupted",
    taskId: "tool_call_pending",
  },
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
    consumedStagedResultsCbor: new Uint8Array([129, 1]),
    createdAtMs: 1_717_171_717_171,
    eventHash:
      "3232323232323232323232323232323232323232323232323232323232323232",
    hash: "3333333333333333333333333333333333333333333333333333333333333333",
    previousTurnNodeHash: null,
    schemaId: "schema_main",
    turnTreeHash:
      "3434343434343434343434343434343434343434343434343434343434343434",
  },
  storedTurnTree: {
    createdAtMs: 1_717_171_717_171,
    hash: "3535353535353535353535353535353535353535353535353535353535353535",
    manifestCbor: new Uint8Array([161, 97, 97, 1]),
    schemaId: "schema_main",
  },
  storedTurnTreePath: {
    collectionKind: "ordered",
    orderedCount: 2,
    orderedEncoding: "flat",
    orderedInlineCbor: new Uint8Array([130, 1, 2]),
    path: "messages",
    turnTreeHash:
      "3636363636363636363636363636363636363636363636363636363636363636",
  },
};

export const kernelProtocolInvalidFixtures = {
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
    annotations: [{ not: "a hash" }],
    signals: ["okay"],
  },
  invalidNonCanonicalKernelRecordBytes: Uint8Array.from(
    Buffer.from("fb41f0000000000000", "hex")
  ),
  invalidSparseOrderedPathValue: new Array(1),
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
  invalidStoredStagedResultWithCompletedInterruptPayload: {
    createdAtMs: 1_717_171_717_171,
    interruptPayloadCbor: new Uint8Array([
      161, 102, 114, 101, 97, 115, 111, 110,
    ]),
    objectHash:
      "3939393939393939393939393939393939393939393939393939393939393939",
    objectType: "tool_result",
    runId: "run_main",
    status: "completed",
    taskId: "tool_call_done",
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
    path: "context_manifest",
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
  unknownPathSchema: {
    incorporationRules: [{ objectType: "message", targetPath: "missing" }],
    paths: [{ collection: "ordered", path: "messages" }],
    schemaId: "schema_main",
  },
};
