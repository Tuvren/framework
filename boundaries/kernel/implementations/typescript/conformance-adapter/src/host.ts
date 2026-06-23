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

import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAesGcmPayloadCodec } from "@tuvren/core/lifecycle";
import type {
  RuntimeBackend,
  StoredBranch,
  StoredThread,
  TurnTreeSchema,
} from "@tuvren/kernel-protocol";
import {
  assertStagedResult,
  decodeDeterministicKernelRecord,
  hashKernelRecord,
  hashOpaqueObjectBytes,
  hashTurnNodeIdentity,
  type StagedResult,
} from "@tuvren/kernel-protocol";
import { createRuntimeKernel } from "@tuvren/kernel-runtime";
import {
  createCanonicalKernelTestSchema,
  createCanonicalTurnTreePaths,
  createFaultInjectingBackend,
  createStoredObjectRecord,
  createStoredSchemaRecord,
  createStoredTurnNodeRecord,
  createStoredTurnTreeRecord,
  type FaultPoint,
} from "@tuvren/kernel-testkit";
import type {
  AdapterCapabilities,
  AdapterControls,
  OperationOutcome,
} from "../../../../../../tools/conformance/adapter-protocol/index.js";
import { createAdapterErrorEnvelope } from "../../../../../../tools/conformance/adapter-protocol/index.js";
import { serveStdioAdapter } from "../../../../../../tools/conformance/adapter-protocol/stdio-host.js";
import {
  hexToBytes,
  loadCanonicalSchema,
  normalizeLogicalErrorCode,
  readErrorCode,
  readFixture,
  readLogicalFixture,
  readRecord,
  readString,
  result,
  runRestartRecoveryPhase,
  stageFixtureResult,
  withConfiguredBackend,
  withConformanceKernel,
  withScopedBackendPair,
} from "./host-support.js";

interface KernelAdapterConfig {
  adapterId: string;
  backend: "memory" | "postgres" | "sqlite";
  capabilities: string[];
}

interface DisposablePostgresBackend {
  close(): Promise<void>;
  destroy(options?: { dropSchema?: boolean }): Promise<void>;
  dropSchema(): Promise<void>;
}

interface ManagedRuntimeBackend extends RuntimeBackend {
  close?(): Promise<void>;
  destroy?(options?: { dropSchema?: boolean }): Promise<void>;
}

interface CrashRecoveryBackendHarness {
  cleanup(): Promise<void>;
  createBackend(): Promise<ManagedRuntimeBackend>;
}

const ADAPTER_CONFIG = readAdapterConfig(process.argv.slice(2));

class TypeScriptKernelAdapter {
  initialize(
    packetId: string,
    planVersion: string
  ): Promise<AdapterCapabilities> {
    return Promise.resolve({
      adapterId: ADAPTER_CONFIG.adapterId,
      capabilities: ADAPTER_CONFIG.capabilities,
      packetId,
      planVersion,
    });
  }

  async dispatch(
    operation: string,
    input: unknown,
    _controls: AdapterControls
  ): Promise<OperationOutcome> {
    try {
      switch (operation) {
        case "kernel.protocol.deterministic-hashing":
          return result(await deterministicHashing(readFixture(input)));
        case "kernel.protocol.schema-roundtrip":
          return result(schemaRoundtrip(readFixture(input)));
        case "kernel.protocol.modify-composition":
          return result(await runModifyComposition());
        case "kernel.protocol.edge-validation":
          return result(await runProtocolEdgeValidation());
        case "kernel.logical.diff-paths":
          return result(await runLogicalDiff(readFixture(input)));
        case "kernel.logical.branch-list":
          return result(await runBranchList(readFixture(input)));
        case "kernel.logical.recovery-state":
          return result(await runRecoveryState(readFixture(input)));
        case "kernel.logical.thread-list":
          return result(await runThreadList());
        case "kernel.lineage.cross-thread-rejection":
          return result(await runCrossThreadLineage());
        case "kernel.run-liveness.lease-renewal":
          return result(await runLeaseRenewal());
        case "kernel.run-liveness.expired-listing":
          return result(await runExpiredListing());
        case "kernel.run-liveness.stale-preemption":
          return result(await runStalePreemption());
        case "kernel.run-liveness.clock-skew-preemption":
          return result(await runClockSkewPreemption());
        case "kernel.restart-recovery.close-reopen-checkpoint":
          return result(await runRestartRecovery());
        case "kernel.restart-recovery.crash-recovery-durable":
          return result(await runDurableCrashRecovery());
        case "kernel.restart-recovery.crash-recovery-in-process":
          return result(await runInProcessCrashRecovery());
        case "kernel.restart-recovery.concurrent-writer":
          return result(await runConcurrentWriterConflict());
        case "kernel.scope-isolation.cross-scope-probe":
          return result(await runCrossScopeProbe());
        case "kernel.reclamation.reclaim-probe":
          return result(await runReclamationProbe());
        case "kernel.reclamation.erasure-probe":
          return result(await runErasureProbe());
        default:
          return {
            error: {
              code: "adapter_operation_not_implemented",
              message: `${ADAPTER_CONFIG.adapterId} does not implement ${operation}`,
            },
            kind: "error",
          };
      }
    } catch (error: unknown) {
      return {
        error: createAdapterErrorEnvelope(error),
        kind: "error",
      };
    }
  }
}

await serveStdioAdapter(new TypeScriptKernelAdapter());

function readAdapterConfig(args: readonly string[]): KernelAdapterConfig {
  const capabilities: string[] = [];
  let adapterId = "typescript-kernel-memory";
  let backend: KernelAdapterConfig["backend"] = "memory";

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--adapter-id") {
      const value = args[index + 1];
      if (value === undefined) {
        throw new Error("--adapter-id requires a value");
      }
      adapterId = value;
      index += 1;
      continue;
    }

    if (arg === "--backend") {
      const value = args[index + 1];
      if (value !== "memory" && value !== "postgres" && value !== "sqlite") {
        throw new Error("--backend must be memory, postgres, or sqlite");
      }
      backend = value;
      index += 1;
      continue;
    }

    if (arg === "--capability") {
      const value = args[index + 1];
      if (value === undefined) {
        throw new Error("--capability requires a value");
      }
      capabilities.push(value);
      index += 1;
    }
  }

  return {
    adapterId,
    backend,
    capabilities:
      capabilities.length > 0 ? capabilities : defaultCapabilities(backend),
  };
}

function defaultCapabilities(
  backend: KernelAdapterConfig["backend"]
): string[] {
  if (backend === "postgres") {
    return [
      "kernel.protocol",
      "kernel.edge-validation",
      "kernel.logical",
      "kernel.run-liveness",
      // Shared multi-owner rendezvous: PostgreSQL is the only backend that
      // advertises an authoritative shared lease clock (ADR-050, BackendCapability
      // shared-lease-clock). The clock-skew preemption check is gated on this
      // capability so it runs only where backend-time lease judgment applies;
      // single-writer embedded backends keep the in-process clock and are excluded.
      "kernel.shared-lease-clock",
      "kernel.persistence.durable",
      "kernel.restart-recovery",
      "kernel.scope-isolation",
      "kernel.reclamation",
      "kernel-protocol.thread.enumeration",
    ];
  }

  if (backend === "sqlite") {
    return [
      "kernel.protocol",
      "kernel.edge-validation",
      "kernel.logical",
      "kernel.run-liveness",
      "kernel.persistence.durable",
      "kernel.restart-recovery",
      "kernel.scope-isolation",
      "kernel.reclamation",
      "kernel-protocol.thread.enumeration",
    ];
  }

  return [
    "kernel.protocol",
    "kernel.edge-validation",
    "kernel.logical",
    "kernel.run-liveness",
    "kernel.restart-recovery",
    "kernel.scope-isolation",
    "kernel.reclamation",
    "kernel-protocol.thread.enumeration",
  ];
}

async function deterministicHashing(
  fixture: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const rawOpaqueBytes = readNumberArray(
    fixture.rawOpaqueBytes,
    "rawOpaqueBytes"
  );
  const schemaRecord = decodeDeterministicKernelRecord(
    hexToBytes(readString(fixture.turnTreeSchemaRecordCborHex, "schema cbor"))
  );
  const turnNodeIdentityRecord = readRecord(
    fixture.turnNodeIdentityRecord,
    "turnNodeIdentityRecord"
  );
  const turnNodeHash = await hashTurnNodeIdentity({
    consumedStagedResults: readStagedResults(
      turnNodeIdentityRecord.consumedStagedResults,
      "consumedStagedResults"
    ),
    eventHash: readNullableString(
      turnNodeIdentityRecord.eventHash,
      "eventHash"
    ),
    previousTurnNodeHash: readNullableString(
      turnNodeIdentityRecord.previousTurnNodeHash,
      "previousTurnNodeHash"
    ),
    schemaId: readString(turnNodeIdentityRecord.schemaId, "schemaId"),
    turnTreeHash: readString(
      turnNodeIdentityRecord.turnTreeHash,
      "turnTreeHash"
    ),
  });

  return createProjection({
    hashes: {
      rawOpaqueBytes: await hashOpaqueObjectBytes(
        Uint8Array.from(rawOpaqueBytes)
      ),
      turnNodeIdentity: turnNodeHash,
      turnTreeSchema: await hashKernelRecord(schemaRecord),
    },
  });
}

function schemaRoundtrip(
  fixture: Record<string, unknown>
): Record<string, unknown> {
  return createProjection({
    roundtrip: {
      turnNodeIdentityRecord: decodeDeterministicKernelRecord(
        hexToBytes(
          readString(
            fixture.turnNodeIdentityRecordCborHex,
            "turnNodeIdentityRecordCborHex"
          )
        )
      ),
      turnTreeSchemaRecord: decodeDeterministicKernelRecord(
        hexToBytes(
          readString(
            fixture.turnTreeSchemaRecordCborHex,
            "turnTreeSchemaRecordCborHex"
          )
        )
      ),
    },
  });
}

async function runModifyComposition(): Promise<Record<string, unknown>> {
  const schema = await loadCanonicalSchema();
  return await withConformanceKernel(schema, ADAPTER_CONFIG, async (kernel) => {
    const verdict = await kernel.verdicts.compose([
      {
        kind: "modify",
        transform: { extension: "first", mutation: "append-prefix" },
      },
      { kind: "proceed" },
      {
        kind: "modify",
        transform: { extension: "second", mutation: "append-suffix" },
      },
    ]);

    if (verdict.kind !== "modify") {
      throw new Error(
        `expected composed modify verdict, received ${verdict.kind}`
      );
    }

    return createProjection({
      verdict: {
        kind: verdict.kind,
        transform: verdict.transform,
      },
    });
  });
}

async function runLogicalDiff(
  fixture: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const schema = await loadCanonicalSchema();
  const logical = readLogicalFixture(fixture, schema);
  return await withConformanceKernel(schema, ADAPTER_CONFIG, async (kernel) => {
    const created = await kernel.thread.create(
      "thread_conformance",
      schema.schemaId,
      logical.branchHeadListEntry[0]
    );
    const changedTree = await kernel.tree.create(
      schema.schemaId,
      logical.turnTreeChangeSet,
      created.rootTurnTreeHash
    );
    const diffPaths = (
      await kernel.tree.diff(created.rootTurnTreeHash, changedTree)
    ).toSorted();

    return createProjection({ diffPaths });
  });
}

async function runBranchList(
  fixture: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const schema = await loadCanonicalSchema();
  const logical = readLogicalFixture(fixture, schema);
  return await withConformanceKernel(schema, ADAPTER_CONFIG, async (kernel) => {
    await kernel.thread.create(
      "thread_conformance",
      schema.schemaId,
      logical.branchHeadListEntry[0]
    );
    const branchEntries = await kernel.branch.list("thread_conformance");

    return createProjection({ branchEntries });
  });
}

async function runThreadList(): Promise<Record<string, unknown>> {
  const schema = await loadCanonicalSchema();
  return await withConformanceKernel(schema, ADAPTER_CONFIG, async (kernel) => {
    await kernel.thread.create(
      "thread_enum_a",
      schema.schemaId,
      "branch_enum_a"
    );
    await kernel.thread.create(
      "thread_enum_b",
      schema.schemaId,
      "branch_enum_b"
    );
    const { threads: allThreads } = await kernel.thread.list();
    const { threads: pagedThreads, nextCursor } = await kernel.thread.list({
      limit: 1,
    });
    return createProjection({
      threadEnumeration: {
        count: allThreads.length,
        firstThreadId: allThreads[0]?.threadId ?? null,
        pagedCount: pagedThreads.length,
        hasCursor: nextCursor !== undefined,
      },
    });
  });
}

// KRT-BE007 cross-scope isolation probe. Constructs two kernels over two
// Scopes bound to one shared substrate, seeds content and an enumerable thread
// under scope A, then reports — as raw observations, never graded here — what
// each Scope can see. The plan's assertions decide pass/fail; this host only
// measures store.has / store.get / enumeration across the scope boundary.
async function runCrossScopeProbe(): Promise<Record<string, unknown>> {
  const schema = await loadCanonicalSchema();

  return await withScopedBackendPair(
    ADAPTER_CONFIG,
    async ({ backendA, backendB }) => {
      const kernelA = createRuntimeKernel({ backend: backendA });
      const kernelB = createRuntimeKernel({ backend: backendB });
      await kernelA.schema.register(schema);

      const objectHash = await kernelA.store.put(
        new TextEncoder().encode("scope-a cross-scope probe content")
      );
      const threadId = "scope_probe_thread";
      await kernelA.thread.create(
        threadId,
        schema.schemaId,
        "scope_probe_branch"
      );

      const sameScopeStoreGet = await kernelA.store.get(objectHash);
      const crossScopeStoreGet = await kernelB.store.get(objectHash);
      const sameScopeThreads = await kernelA.thread.list();
      const crossScopeThreads = await kernelB.thread.list();

      return createProjection({
        enumeration: {
          crossScopeThreadVisible: crossScopeThreads.threads.some(
            (thread) => thread.threadId === threadId
          ),
          sameScopeThreadVisible: sameScopeThreads.threads.some(
            (thread) => thread.threadId === threadId
          ),
        },
        storeGet: {
          crossScopeReturnsNull: crossScopeStoreGet === null,
          sameScopeReturnsObject: sameScopeStoreGet !== null,
        },
        storeHas: {
          crossScopeObservesOtherContent: await kernelB.store.has(objectHash),
          sameScopeObservesOwnContent: await kernelA.store.has(objectHash),
        },
      });
    }
  );
}

// KRT-BF007 reachability reclamation probe. Constructs decisive scenarios over a
// reclamation-capable backend and reports — as raw observations, never graded
// here — what the §9.4 mark-and-sweep released and retained. The plan's
// assertions decide pass/fail. Two phases: (1) an archive rollback over a shared
// non-root ancestor proves the keep closure is a set-union over live roots (a
// structurally shared object survives via the live branch while the
// archive-exclusive payload is released); (2) a deterministic clock orders writes
// around an active execution lease to prove the grace window is the lease horizon.
async function runReclamationProbe(): Promise<Record<string, unknown>> {
  const schema = await loadCanonicalSchema();

  const reachabilityObservations = await withConformanceKernel(
    schema,
    ADAPTER_CONFIG,
    async (kernel) => {
      const thread = await kernel.thread.create(
        "thread_reclamation",
        schema.schemaId,
        "branch_reclamation"
      );
      // The shared object is a message staged at the (kept) live ancestor
      // checkpoint; the schema incorporates it into that turn tree's messages.
      const shared = await checkpointMessageIntoHead(kernel, {
        branchId: thread.branchId,
        messageBytes: new TextEncoder().encode(
          "shared-across-live-and-archived"
        ),
        parentTurnId: null,
        runId: "run_shared",
        schemaId: schema.schemaId,
        startTurnNodeHash: thread.rootTurnNodeHash,
        taskId: "msg_shared",
        threadId: thread.threadId,
        turnId: "turn_shared",
      });
      const sharedObjectHash = shared.objectHash;
      // The archive-exclusive object is staged at the forward checkpoint the
      // rollback abandons. Its turn tree inherits the shared message and adds the
      // archive-exclusive one, so the shared object is referenced by both the
      // kept and the swept node.
      const archived = await checkpointMessageIntoHead(kernel, {
        branchId: thread.branchId,
        messageBytes: new TextEncoder().encode("archived-exclusive-payload"),
        parentTurnId: shared.turnId,
        runId: "run_archived",
        schemaId: schema.schemaId,
        startTurnNodeHash: shared.turnNodeHash,
        taskId: "msg_archived",
        threadId: thread.threadId,
        turnId: "turn_archived",
      });
      const archivedOnlyObjectHash = archived.objectHash;

      // Confirm the soon-to-be-archived node genuinely references the shared
      // object, so retaining it after the sweep proves the set-union keep, not
      // mere exclusive-lineage release.
      const archivedNode = await kernel.node.get(archived.turnNodeHash);
      if (archivedNode === null) {
        throw new Error("expected archived node before rollback");
      }
      const archivedManifest = await kernel.tree.manifest(
        archivedNode.turnTreeHash
      );
      const sharedObjectReferencedByArchivedNode =
        Array.isArray(archivedManifest.messages) &&
        archivedManifest.messages.includes(sharedObjectHash);

      // Roll the live head back to the shared ancestor: the forward segment is
      // archived into an archive branch and becomes unreferenced state.
      const rollback = await kernel.branch.setHead(
        thread.branchId,
        shared.turnNodeHash
      );
      const archivedIntoBranch =
        rollback.archiveBranch?.headTurnNodeHash === archived.turnNodeHash;

      // An orphan unreachable from any live root, with no active lease in play
      // (grace horizon is unbounded), so it is releasable.
      const orphanObjectHash = await kernel.store.put(
        new TextEncoder().encode("unreachable-orphan")
      );

      const summary = await kernel.maintenance.reclaim();

      const branchesAfter = await kernel.branch.list(thread.threadId);
      const threadAfter = await kernel.thread.get(thread.threadId);

      return {
        archivedBranchReleased:
          archivedIntoBranch &&
          !(await kernel.store.has(archivedOnlyObjectHash)) &&
          (await kernel.node.get(archived.turnNodeHash)) === null &&
          !branchesAfter.some(([branchId]) => branchId.includes("archive")) &&
          summary.releasedArchivedBranchCount >= 1,
        reachableFromLiveRootRetained:
          (await kernel.store.has(sharedObjectHash)) &&
          (await kernel.node.get(shared.turnNodeHash)) !== null &&
          threadAfter?.rootTurnNodeHash === thread.rootTurnNodeHash,
        sharedObjectRetainedViaLiveRoot:
          sharedObjectReferencedByArchivedNode &&
          (await kernel.store.has(sharedObjectHash)) &&
          !(await kernel.store.has(archivedOnlyObjectHash)) &&
          (await kernel.node.get(archived.turnNodeHash)) === null,
        unreachablePastGraceReleased:
          !(await kernel.store.has(orphanObjectHash)) &&
          summary.releasedObjectCount >= 1,
      };
    }
  );

  let clock = 0;
  const graceObservations = await withConfiguredBackend(
    ADAPTER_CONFIG,
    async (backend) => {
      const kernel = createRuntimeKernel({ backend, now: () => clock });
      await kernel.schema.register(schema);

      clock = 10;
      const orphanBeforeLease = await kernel.store.put(new Uint8Array([1]));

      clock = 20;
      const thread = await kernel.thread.create(
        "thread_grace",
        schema.schemaId,
        "branch_grace"
      );
      const turn = await kernel.turn.create(
        "turn_grace",
        thread.threadId,
        thread.branchId,
        null,
        thread.rootTurnNodeHash
      );
      // An active (running) run holds the oldest execution lease at t=20.
      await kernel.run.create(
        "run_grace",
        turn.turnId,
        thread.branchId,
        schema.schemaId,
        thread.rootTurnNodeHash,
        [{ deterministic: true, id: "work", sideEffects: false }]
      );

      clock = 30;
      const orphanAfterLease = await kernel.store.put(new Uint8Array([2]));

      clock = 40;
      await kernel.maintenance.reclaim();

      // The older orphan (before the lease horizon) is released; the newer orphan
      // (after the horizon) is retained even though it too is unreachable.
      return {
        graceWindowHeldUnderActiveLease:
          !(await kernel.store.has(orphanBeforeLease)) &&
          (await kernel.store.has(orphanAfterLease)),
      };
    },
    { now: () => clock }
  );

  return createProjection({
    reclaim: {
      ...reachabilityObservations,
      ...graceObservations,
    },
  });
}

// KRT-BF007 crypto-shredding erasure probe. The adapter plays the §4.17 host
// role: it owns a payload codec and the key, encrypts at the edge, and hands the
// kernel only the opaque ciphertext envelope. "Erasure" is the host destroying
// the key (removing it from the keyring). The probe reports — as raw
// observations — that the payload is recoverable before and unrecoverable after
// key destruction, while the referencing kernel lineage stays byte/hash-identical
// (the kernel never held the key, so nothing structural changes).
async function runErasureProbe(): Promise<Record<string, unknown>> {
  const schema = await loadCanonicalSchema();

  return await withConformanceKernel(schema, ADAPTER_CONFIG, async (kernel) => {
    const keyRef = "tuvren.scope.conformance-erasure";
    const keyring = new Map<string, Uint8Array>([
      [keyRef, new Uint8Array(randomBytes(32))],
    ]);
    const codec = createAesGcmPayloadCodec({
      keyring: { resolve: (ref) => keyring.get(ref) },
    });
    const context = { edge: "message", scope: keyRef };
    const plaintext = new TextEncoder().encode(
      "sensitive-untrusted-edge-payload"
    );

    // Encrypt at the host edge, then stage only the ciphertext envelope as a
    // message so the kernel incorporates it into the branch-head turn tree.
    const envelope = await codec.encrypt(plaintext, context);
    const thread = await kernel.thread.create(
      "thread_erasure",
      schema.schemaId,
      "branch_erasure"
    );
    const checkpoint = await checkpointMessageIntoHead(kernel, {
      branchId: thread.branchId,
      messageBytes: envelope,
      parentTurnId: null,
      runId: "run_erasure",
      schemaId: schema.schemaId,
      startTurnNodeHash: thread.rootTurnNodeHash,
      taskId: "msg_erasure",
      threadId: thread.threadId,
      turnId: "turn_erasure",
    });
    const envelopeHash = checkpoint.objectHash;

    const branchBefore = await kernel.branch.get(thread.branchId);
    const nodeBefore = await kernel.node.get(checkpoint.turnNodeHash);
    if (branchBefore === null || nodeBefore === null) {
      throw new Error("expected branch and node before erasure");
    }

    // Before erasure the host can still decrypt the stored envelope.
    const storedBefore = await kernel.store.get(envelopeHash);
    const recoverableBeforeErasure = await isRecoverable(
      codec,
      storedBefore,
      context,
      plaintext
    );

    // ── Crypto-shredding erasure: the host destroys the key. ──
    keyring.delete(keyRef);

    const storedAfter = await kernel.store.get(envelopeHash);
    const decryptAfter =
      storedAfter === null ? null : await codec.decrypt(storedAfter, context);
    const unrecoverableAfterErasure = decryptAfter?.status === "erased";

    // The referencing lineage is byte/hash-identical after erasure.
    const branchAfter = await kernel.branch.get(thread.branchId);
    const nodeAfter = await kernel.node.get(checkpoint.turnNodeHash);
    const manifestAfter =
      nodeAfter === null
        ? null
        : await kernel.tree.manifest(nodeAfter.turnTreeHash);
    const manifestReferencesEnvelope =
      manifestAfter !== null &&
      Array.isArray(manifestAfter.messages) &&
      manifestAfter.messages.includes(envelopeHash);
    const lineageStructurallyIntactAfterErasure =
      branchAfter !== null &&
      branchAfter.headTurnNodeHash === branchBefore.headTurnNodeHash &&
      nodeAfter !== null &&
      nodeAfter.turnTreeHash === nodeBefore.turnTreeHash &&
      manifestReferencesEnvelope &&
      storedAfter !== null &&
      bytesEqual(storedAfter, envelope);

    return createProjection({
      erasure: {
        lineageStructurallyIntactAfterErasure,
        recoverableBeforeErasure,
        unrecoverableAfterErasure,
      },
    });
  });
}

/**
 * Runs one non-deterministic checkpoint step that stages `messageBytes` as a
 * `message`, so the schema incorporates it into the branch-head turn tree's
 * `messages` path (and a checkpoint chained on top inherits it). Returns the
 * checkpoint turn node, its owning turn id, and the stored message object hash so
 * a caller can chain a second checkpoint and reason about the shared object.
 */
async function checkpointMessageIntoHead(
  kernel: ReturnType<typeof createRuntimeKernel>,
  input: {
    branchId: string;
    messageBytes: Uint8Array;
    parentTurnId: string | null;
    runId: string;
    schemaId: string;
    startTurnNodeHash: string;
    taskId: string;
    threadId: string;
    turnId: string;
  }
): Promise<{ objectHash: string; turnId: string; turnNodeHash: string }> {
  const turn = await kernel.turn.create(
    input.turnId,
    input.threadId,
    input.branchId,
    input.parentTurnId,
    input.startTurnNodeHash
  );
  await kernel.run.create(
    input.runId,
    turn.turnId,
    input.branchId,
    input.schemaId,
    input.startTurnNodeHash,
    [{ deterministic: false, id: "checkpoint", sideEffects: false }]
  );
  await kernel.run.beginStep(input.runId, "checkpoint");
  const staged = await kernel.staging.stage(
    input.runId,
    input.messageBytes,
    input.taskId,
    "message",
    "completed"
  );
  const completed = await kernel.run.completeStep(input.runId, "checkpoint");
  if (completed.turnNodeHash === undefined) {
    throw new Error("expected checkpoint turn node hash");
  }
  await kernel.run.complete(input.runId, "completed");
  return {
    objectHash: staged.objectHash,
    turnId: turn.turnId,
    turnNodeHash: completed.turnNodeHash,
  };
}

async function isRecoverable(
  codec: ReturnType<typeof createAesGcmPayloadCodec>,
  stored: Uint8Array | null,
  context: { edge: string; scope: string },
  expectedPlaintext: Uint8Array
): Promise<boolean> {
  if (stored === null) {
    return false;
  }
  const decrypted = await codec.decrypt(stored, context);
  return (
    decrypted.status === "available" &&
    bytesEqual(decrypted.plaintext, expectedPlaintext)
  );
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

async function runRecoveryState(
  fixture: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const schema = await loadCanonicalSchema();
  const logical = readLogicalFixture(fixture, schema);
  return await withConformanceKernel(schema, ADAPTER_CONFIG, async (kernel) => {
    const thread = await kernel.thread.create(
      "thread_conformance",
      schema.schemaId,
      logical.branchHeadListEntry[0]
    );
    const turn = await kernel.turn.create(
      "turn_recovery",
      thread.threadId,
      thread.branchId,
      null,
      thread.rootTurnNodeHash
    );
    await kernel.run.create(
      "run_recovery",
      turn.turnId,
      thread.branchId,
      schema.schemaId,
      thread.rootTurnNodeHash,
      logical.recoveryState.stepSequence
    );

    const [firstStep, secondStep] = logical.recoveryState.stepSequence;

    if (firstStep === undefined || secondStep === undefined) {
      throw new Error(
        "logical recovery fixture must declare at least two steps"
      );
    }

    await kernel.run.beginStep("run_recovery", firstStep.id);
    await kernel.run.completeStep("run_recovery", firstStep.id);
    await kernel.run.beginStep("run_recovery", secondStep.id);

    for (const [
      index,
      stagedResult,
    ] of logical.recoveryState.consumedStagedResults.entries()) {
      await stageFixtureResult(kernel, "run_recovery", stagedResult, index);
    }

    await kernel.run.completeStep("run_recovery", secondStep.id);

    for (const [
      index,
      stagedResult,
    ] of logical.recoveryState.uncommittedStagedResults.entries()) {
      await stageFixtureResult(kernel, "run_recovery", stagedResult, index);
    }

    const recovery = await kernel.run.recover("run_recovery");

    return createProjection({
      recovery: {
        consumedStagedResults: recovery.consumedStagedResults.length,
        lastCompletedStepId: recovery.lastCompletedStepId,
        uncommittedStagedResults: recovery.uncommittedStagedResults.length,
      },
    });
  });
}

async function runCrossThreadLineage(): Promise<Record<string, unknown>> {
  const schema = await loadCanonicalSchema();
  return await withConformanceKernel(schema, ADAPTER_CONFIG, async (kernel) => {
    const threadA = await kernel.thread.create(
      "thread_a",
      schema.schemaId,
      "branch_a"
    );
    const turnA = await kernel.turn.create(
      "turn_a",
      threadA.threadId,
      threadA.branchId,
      null,
      threadA.rootTurnNodeHash
    );
    await kernel.run.create(
      "run_a",
      turnA.turnId,
      threadA.branchId,
      schema.schemaId,
      threadA.rootTurnNodeHash,
      [{ deterministic: false, id: "step_a", sideEffects: false }]
    );
    const completed = await kernel.run.completeStep("run_a", "step_a");

    if (completed.turnNodeHash === undefined) {
      throw new Error(
        "expected checkpoint hash for cross-thread lineage check"
      );
    }

    await kernel.thread.create("thread_b", schema.schemaId, "branch_b");

    try {
      await kernel.branch.create(
        "branch_cross_thread",
        "thread_b",
        completed.turnNodeHash
      );

      // Unexpected acceptance is surfaced as evidence instead of crashing the
      // adapter so the shared runner can report one semantic failure cleanly.
      return createProjection({
        diagnostics: ["thread A node unexpectedly seeded thread B branch"],
        errorCode: "unexpected_success",
      });
    } catch (error: unknown) {
      return createProjection({
        errorCode: normalizeLogicalErrorCode(readErrorCode(error)),
      });
    }
  });
}

async function runProtocolEdgeValidation(): Promise<Record<string, unknown>> {
  const schema = await loadCanonicalSchema();
  return await withConformanceKernel(schema, ADAPTER_CONFIG, async (kernel) => {
    const firstPath = schema.paths[0];

    if (firstPath === undefined) {
      throw new Error("canonical schema must define at least one path");
    }

    const duplicatePathCode = await captureSemanticErrorCode(async () => {
      await kernel.schema.register({
        ...schema,
        paths: [...schema.paths, { ...firstPath }],
        schemaId: "schema_edge_duplicate_path",
      });
    });

    const missingRequiredPathCode = await captureSemanticErrorCode(async () => {
      await kernel.tree.create(schema.schemaId, { messages: [] });
    });

    const alternateSchema = {
      ...schema,
      schemaId: "schema_edge_alternate",
    };
    await kernel.schema.register(alternateSchema);
    const canonicalTree = await kernel.tree.create(schema.schemaId, {
      "context.manifest": null,
      messages: [],
    });
    const alternateTree = await kernel.tree.create(alternateSchema.schemaId, {
      "context.manifest": null,
      messages: [],
    });
    const schemaMismatchCode = await captureSemanticErrorCode(async () => {
      await kernel.tree.diff(canonicalTree, alternateTree);
    });

    const busyThread = await kernel.thread.create(
      "thread_edge_busy_branch",
      schema.schemaId,
      "branch_edge_busy_branch"
    );
    const busyTurn = await kernel.turn.create(
      "turn_edge_busy_branch",
      busyThread.threadId,
      busyThread.branchId,
      null,
      busyThread.rootTurnNodeHash
    );
    await kernel.run.create(
      "run_edge_busy_branch_active",
      busyTurn.turnId,
      busyThread.branchId,
      schema.schemaId,
      busyThread.rootTurnNodeHash,
      [{ deterministic: false, id: "first", sideEffects: false }]
    );
    const busyBranchCode = await captureSemanticErrorCode(async () => {
      await kernel.run.create(
        "run_edge_busy_branch_rejected",
        busyTurn.turnId,
        busyThread.branchId,
        schema.schemaId,
        busyThread.rootTurnNodeHash,
        [{ deterministic: false, id: "next", sideEffects: false }]
      );
    });

    const orderedThread = await kernel.thread.create(
      "thread_edge_step_order",
      schema.schemaId,
      "branch_edge_step_order"
    );
    const orderedTurn = await kernel.turn.create(
      "turn_edge_step_order",
      orderedThread.threadId,
      orderedThread.branchId,
      null,
      orderedThread.rootTurnNodeHash
    );
    await kernel.run.create(
      "run_edge_step_order",
      orderedTurn.turnId,
      orderedThread.branchId,
      schema.schemaId,
      orderedThread.rootTurnNodeHash,
      [
        { deterministic: false, id: "first", sideEffects: false },
        { deterministic: false, id: "second", sideEffects: false },
      ]
    );
    const outOfOrderStepCode = await captureSemanticErrorCode(async () => {
      await kernel.run.beginStep("run_edge_step_order", "second");
    });

    const missingEventThread = await kernel.thread.create(
      "thread_edge_missing_event",
      schema.schemaId,
      "branch_edge_missing_event"
    );
    const missingEventTurn = await kernel.turn.create(
      "turn_edge_missing_event",
      missingEventThread.threadId,
      missingEventThread.branchId,
      null,
      missingEventThread.rootTurnNodeHash
    );
    await kernel.run.create(
      "run_edge_missing_event",
      missingEventTurn.turnId,
      missingEventThread.branchId,
      schema.schemaId,
      missingEventThread.rootTurnNodeHash,
      [{ deterministic: false, id: "event_step", sideEffects: false }]
    );
    const missingEventObjectCode = await captureSemanticErrorCode(async () => {
      await kernel.run.completeStep(
        "run_edge_missing_event",
        "event_step",
        "a".repeat(64)
      );
    });

    const lateralThread = await kernel.thread.create(
      "thread_edge_lateral",
      schema.schemaId,
      "branch_edge_lateral_main"
    );
    const bootstrapTurn = await kernel.turn.create(
      "turn_edge_lateral_bootstrap",
      lateralThread.threadId,
      lateralThread.branchId,
      null,
      lateralThread.rootTurnNodeHash
    );
    await kernel.run.create(
      "run_edge_lateral_bootstrap",
      bootstrapTurn.turnId,
      lateralThread.branchId,
      schema.schemaId,
      lateralThread.rootTurnNodeHash,
      [{ deterministic: false, id: "bootstrap", sideEffects: false }]
    );
    const bootstrapCheckpoint = await kernel.run.completeStep(
      "run_edge_lateral_bootstrap",
      "bootstrap"
    );

    if (bootstrapCheckpoint.turnNodeHash === undefined) {
      throw new Error("expected bootstrap lateral checkpoint");
    }

    await kernel.run.complete("run_edge_lateral_bootstrap", "completed");
    const mainTurn = await kernel.turn.create(
      "turn_edge_lateral_main",
      lateralThread.threadId,
      lateralThread.branchId,
      bootstrapTurn.turnId,
      bootstrapCheckpoint.turnNodeHash
    );
    await kernel.run.create(
      "run_edge_lateral_main",
      mainTurn.turnId,
      lateralThread.branchId,
      schema.schemaId,
      bootstrapCheckpoint.turnNodeHash,
      [{ deterministic: false, id: "main", sideEffects: false }]
    );
    const mainEventHash = await kernel.store.put(
      new TextEncoder().encode("lateral-main")
    );
    const mainCheckpoint = await kernel.run.completeStep(
      "run_edge_lateral_main",
      "main",
      mainEventHash
    );

    if (mainCheckpoint.turnNodeHash === undefined) {
      throw new Error("expected main lateral checkpoint");
    }

    await kernel.run.complete("run_edge_lateral_main", "completed");
    const forkBranch = await kernel.branch.create(
      "branch_edge_lateral_fork",
      lateralThread.threadId,
      bootstrapCheckpoint.turnNodeHash
    );
    const forkTurn = await kernel.turn.create(
      "turn_edge_lateral_fork",
      lateralThread.threadId,
      forkBranch.branchId,
      bootstrapTurn.turnId,
      bootstrapCheckpoint.turnNodeHash
    );
    await kernel.run.create(
      "run_edge_lateral_fork",
      forkTurn.turnId,
      forkBranch.branchId,
      schema.schemaId,
      bootstrapCheckpoint.turnNodeHash,
      [{ deterministic: false, id: "fork", sideEffects: false }]
    );
    const forkEventHash = await kernel.store.put(
      new TextEncoder().encode("lateral-fork")
    );
    const forkCheckpoint = await kernel.run.completeStep(
      "run_edge_lateral_fork",
      "fork",
      forkEventHash
    );

    const forkTurnNodeHash = forkCheckpoint.turnNodeHash;

    if (forkTurnNodeHash === undefined) {
      throw new Error("expected fork lateral checkpoint");
    }

    await kernel.run.complete("run_edge_lateral_fork", "completed");
    const lateralHeadCode = await captureSemanticErrorCode(async () => {
      await kernel.branch.setHead(lateralThread.branchId, forkTurnNodeHash);
    });

    return createProjection({
      protocolEdgeValidation: {
        branch: { lateralHeadCode },
        run: {
          busyBranchCode,
          missingEventObjectCode,
          outOfOrderStepCode,
        },
        schema: { duplicatePathCode },
        tree: {
          missingRequiredPathCode,
          schemaMismatchCode,
        },
      },
    });
  });
}

async function captureSemanticErrorCode(
  execute: () => Promise<unknown>
): Promise<string> {
  try {
    await execute();
    return "unexpected_success";
  } catch (error: unknown) {
    return normalizeLogicalErrorCode(readErrorCode(error));
  }
}

async function runLeaseRenewal(): Promise<Record<string, unknown>> {
  const schema = await loadCanonicalSchema();
  return await withConfiguredBackend(
    ADAPTER_CONFIG,
    async (backend) => {
      const kernel = createRuntimeKernel({
        backend,
        now: () => 10,
      });
      await kernel.schema.register(schema);
      const thread = await kernel.thread.create(
        "thread_liveness_renewal",
        schema.schemaId,
        "branch_liveness_renewal"
      );
      const turn = await kernel.turn.create(
        "turn_liveness_renewal",
        thread.threadId,
        thread.branchId,
        null,
        thread.rootTurnNodeHash
      );
      const leasedRun = await kernel.runLiveness.createLeasedRun({
        branchId: thread.branchId,
        executionOwnerId: "owner-primary",
        leaseExpiresAtMs: 20,
        runId: "run_liveness_renewal",
        schemaId: schema.schemaId,
        startTurnNodeHash: thread.rootTurnNodeHash,
        steps: [{ deterministic: false, id: "iterate", sideEffects: true }],
        turnId: turn.turnId,
      });
      const staleToken = leasedRun.fencingToken ?? "";
      const renewed = await kernel.runLiveness.renewLease(
        leasedRun.runId,
        "owner-primary",
        staleToken,
        40
      );

      let ownerMismatchCode = "unexpected_success";
      try {
        await kernel.runLiveness.renewLease(
          leasedRun.runId,
          "owner-secondary",
          renewed.fencingToken,
          50
        );
      } catch (error: unknown) {
        ownerMismatchCode = normalizeLogicalErrorCode(readErrorCode(error));
      }

      let staleTokenCode = "unexpected_success";
      try {
        await kernel.runLiveness.renewLease(
          leasedRun.runId,
          "owner-primary",
          staleToken,
          50
        );
      } catch (error: unknown) {
        staleTokenCode = normalizeLogicalErrorCode(readErrorCode(error));
      }

      return createProjection({
        renewal: {
          ownerMismatchCode,
          renewedLeaseExpiresAtMs: renewed.leaseExpiresAtMs,
          staleTokenCode,
        },
      });
    },
    // Align the backend's authoritative lease clock with the kernel clock so the
    // backend-time re-base (ADR-050) is a no-op for shared-lease-clock backends
    // and the deterministic expected lease values hold across all backends.
    { now: () => 10 }
  );
}

async function runExpiredListing(): Promise<Record<string, unknown>> {
  const schema = await loadCanonicalSchema();
  return await withConfiguredBackend(
    ADAPTER_CONFIG,
    async (backend) => {
      const kernel = createRuntimeKernel({ backend, now: () => 10 });
      await kernel.schema.register(schema);
      const expiredThread = await kernel.thread.create(
        "thread_liveness_listing_expired",
        schema.schemaId,
        "branch_liveness_listing_expired"
      );
      const freshThread = await kernel.thread.create(
        "thread_liveness_listing_fresh",
        schema.schemaId,
        "branch_liveness_listing_fresh"
      );
      const pausedThread = await kernel.thread.create(
        "thread_liveness_listing_paused",
        schema.schemaId,
        "branch_liveness_listing_paused"
      );
      const expiredTurn = await kernel.turn.create(
        "turn_liveness_listing_expired",
        expiredThread.threadId,
        expiredThread.branchId,
        null,
        expiredThread.rootTurnNodeHash
      );
      const freshTurn = await kernel.turn.create(
        "turn_liveness_listing_fresh",
        freshThread.threadId,
        freshThread.branchId,
        null,
        freshThread.rootTurnNodeHash
      );
      const pausedTurn = await kernel.turn.create(
        "turn_liveness_listing_paused",
        pausedThread.threadId,
        pausedThread.branchId,
        null,
        pausedThread.rootTurnNodeHash
      );
      await kernel.runLiveness.createLeasedRun({
        branchId: expiredThread.branchId,
        executionOwnerId: "owner-primary",
        leaseExpiresAtMs: 5,
        runId: "run_expired",
        schemaId: schema.schemaId,
        startTurnNodeHash: expiredThread.rootTurnNodeHash,
        steps: [{ deterministic: false, id: "iterate", sideEffects: true }],
        turnId: expiredTurn.turnId,
      });
      const freshRun = await kernel.runLiveness.createLeasedRun({
        branchId: freshThread.branchId,
        executionOwnerId: "owner-primary",
        leaseExpiresAtMs: 50,
        runId: "run_fresh",
        schemaId: schema.schemaId,
        startTurnNodeHash: freshThread.rootTurnNodeHash,
        steps: [{ deterministic: false, id: "iterate", sideEffects: true }],
        turnId: freshTurn.turnId,
      });
      const pausedRun = await kernel.runLiveness.createLeasedRun({
        branchId: pausedThread.branchId,
        executionOwnerId: "owner-primary",
        // This lease is already stale before the pause so the evidence proves that
        // paused status, not remaining lease time, keeps it out of expired listings.
        leaseExpiresAtMs: 5,
        runId: "run_paused",
        schemaId: schema.schemaId,
        startTurnNodeHash: pausedThread.rootTurnNodeHash,
        steps: [{ deterministic: false, id: "iterate", sideEffects: true }],
        turnId: pausedTurn.turnId,
      });
      await kernel.run.complete(freshRun.runId, "failed");
      await kernel.run.complete(pausedRun.runId, "paused");
      const expiredRuns = await kernel.runLiveness.listExpired(10);
      const pausedStoredRun = await backend.transact(async (tx) => {
        return await tx.runs.get(pausedRun.runId);
      });

      if (pausedStoredRun === null) {
        throw new Error("expected paused stored run");
      }

      return createProjection({
        listing: {
          expiredRunIds: expiredRuns.map((run) => run.runId),
          pausedRunListed: expiredRuns.some(
            (run) => run.runId === pausedRun.runId
          ),
          pausedRunStatus: pausedStoredRun.status,
        },
      });
    },
    // Align the backend's authoritative lease clock with the kernel clock so the
    // backend-time re-base (ADR-050) is a no-op for shared-lease-clock backends
    // and the deterministic expected lease values hold across all backends.
    { now: () => 10 }
  );
}

async function runStalePreemption(): Promise<Record<string, unknown>> {
  const schema = await loadCanonicalSchema();
  return await withConfiguredBackend(
    ADAPTER_CONFIG,
    async (backend) => {
      const storageKernel = createRuntimeKernel({ backend, now: () => 10 });
      await storageKernel.schema.register(schema);
      const thread = await storageKernel.thread.create(
        "thread_liveness_preemption",
        schema.schemaId,
        "branch_liveness_preemption"
      );
      const turn = await storageKernel.turn.create(
        "turn_liveness_preemption",
        thread.threadId,
        thread.branchId,
        null,
        thread.rootTurnNodeHash
      );
      const leasedRun = await storageKernel.runLiveness.createLeasedRun({
        branchId: thread.branchId,
        executionOwnerId: "owner-primary",
        leaseExpiresAtMs: 5,
        runId: "run_liveness_preemption",
        schemaId: schema.schemaId,
        startTurnNodeHash: thread.rootTurnNodeHash,
        steps: [{ deterministic: false, id: "iterate", sideEffects: true }],
        turnId: turn.turnId,
      });
      await storageKernel.run.beginStep(leasedRun.runId, "iterate");
      await storageKernel.staging.stage(
        leasedRun.runId,
        new TextEncoder().encode("assistant"),
        "assistant_message",
        "message",
        "completed"
      );
      const recovery = await storageKernel.runLiveness.preemptExpired(
        leasedRun.runId,
        "owner-secondary",
        10,
        "stale_running_recovery"
      );

      const storedRun = await backend.transact(async (tx) => {
        return await tx.runs.get(leasedRun.runId);
      });

      if (storedRun === null) {
        throw new Error("expected preempted stored run");
      }
      const updatedBranch = await storageKernel.branch.get(thread.branchId);

      if (updatedBranch === null) {
        throw new Error("expected preempted branch");
      }

      return createProjection({
        preemption: {
          branchHeadTurnNodeHash: updatedBranch.headTurnNodeHash,
          leaseCleared:
            storedRun.executionOwnerId === undefined &&
            storedRun.fencingToken === undefined &&
            storedRun.leaseExpiresAtMs === undefined,
          preemptionReason: storedRun.preemptionReason ?? null,
          recoveryHeadMatchesBranchHead:
            recovery.lastTurnNodeHash === updatedBranch.headTurnNodeHash,
          recoveryLastTurnNodeHash: recovery.lastTurnNodeHash,
          runStatus: storedRun.status,
          uncommittedStagedResults: recovery.uncommittedStagedResults.length,
        },
      });
    },
    // Align the backend's authoritative lease clock with the kernel clock so the
    // backend-time re-base (ADR-050) is a no-op for shared-lease-clock backends
    // and the deterministic expected lease values hold across all backends.
    { now: () => 10 }
  );
}

/**
 * Preemption under worker clock skew against a backend-authoritative lease clock
 * (KRT-BG005; ADR-050 composed with ADR-052 side-effect-once).
 *
 * Two execution owners share one backend. owner-secondary's wall clock runs
 * ahead of the backend's own clock, the scenario the SaaS-readiness lease model
 * must survive: a GC-paused or clock-skewed peer must not be able to preempt a
 * lease the *backend* still considers live, because backend-authoritative
 * clocking judges expiry by the backend's clock within the lease transaction,
 * not by either worker's wall clock.
 *
 * Phase 1 proves no split brain: although owner-secondary's local clock is well
 * past the lease expiry, the backend clock is the authority, so listExpired
 * (judged by tx.now()) does not surface the still-live lease and the peer cannot
 * preempt it. Phase 2 advances the backend's own clock past expiry and proves
 * that genuine preemption then recovers the run, that the completed,
 * durably-staged side-effecting tool call survives by its callId/taskId so a
 * resuming owner skips it (the external side effect is therefore driven at most
 * once, §4.9), and that recovery's reported head agrees with the durable branch
 * head read back independently. Preemption does incorporate the staged result in
 * one transaction (the head advances exactly once); at-most-once is enforced by
 * the failed run status and the cleared lease, which are asserted separately. The
 * dead owner's lease is cleared.
 */
async function runClockSkewPreemption(): Promise<Record<string, unknown>> {
  const schema = await loadCanonicalSchema();
  // Backend-authoritative clock (ADR-050), mutable so the probe can advance the
  // backend's own clock between phases without relying on wall-clock sleeps.
  let backendClockMs = 1000;
  const backendNow = () => backendClockMs;
  // owner-secondary's wall clock is skewed 300ms ahead of the backend, so by its
  // own reading the lease (expiry 1100 in backend time) is already expired in
  // phase 1 — yet the backend clock (1000) says it is not.
  const secondaryNowMs = 1300;
  const leaseExpiresAtMs = 1100;

  return await withConfiguredBackend(
    ADAPTER_CONFIG,
    async (backend) => {
      // owner-primary's wall clock is aligned with the backend at grant time, so
      // the ADR-050 re-base is a no-op and the stored expiry is 1100 in backend
      // time (supplied 1100 - primary now 1000 = 100ms duration; 1000 + 100).
      const primaryKernel = createRuntimeKernel({ backend, now: () => 1000 });
      await primaryKernel.schema.register(schema);
      const thread = await primaryKernel.thread.create(
        "thread_clock_skew",
        schema.schemaId,
        "branch_clock_skew"
      );
      const turn = await primaryKernel.turn.create(
        "turn_clock_skew",
        thread.threadId,
        thread.branchId,
        null,
        thread.rootTurnNodeHash
      );
      const leasedRun = await primaryKernel.runLiveness.createLeasedRun({
        branchId: thread.branchId,
        executionOwnerId: "owner-primary",
        leaseExpiresAtMs,
        runId: "run_clock_skew",
        schemaId: schema.schemaId,
        startTurnNodeHash: thread.rootTurnNodeHash,
        steps: [
          { deterministic: false, id: "side_effect_call", sideEffects: true },
        ],
        turnId: turn.turnId,
      });
      await primaryKernel.run.beginStep(leasedRun.runId, "side_effect_call");
      // A completed, durably-staged side-effecting tool result committed as a
      // tool message and keyed by its callId (the staging taskId §4.9 keys on).
      // On recovery this completed call is incorporated into committed history,
      // so a resuming owner skips it by callId rather than re-driving it — the
      // external side effect happens at most once.
      await primaryKernel.staging.stage(
        leasedRun.runId,
        new TextEncoder().encode("side-effect-result"),
        "call_side_effect",
        "message",
        "completed"
      );

      const secondaryKernel = createRuntimeKernel({
        backend,
        now: () => secondaryNowMs,
      });

      // Phase 1 — no split brain. The backend clock (1000) is still below the
      // lease expiry (1100), so the lease is not preemptable even though the
      // secondary's local clock (1300) is past it.
      const expiredBeforeBackendExpiry =
        await secondaryKernel.runLiveness.listExpired(secondaryNowMs);
      const splitBrainPreemptionBlocked = !expiredBeforeBackendExpiry.some(
        (run) => run.runId === leasedRun.runId
      );

      // Phase 2 — genuine expiry by the backend's own clock.
      backendClockMs = 1200;
      const expiredAfterBackendExpiry =
        await secondaryKernel.runLiveness.listExpired(secondaryNowMs);
      const preemptedAfterBackendExpiry = expiredAfterBackendExpiry.some(
        (run) => run.runId === leasedRun.runId
      );
      const recovery = await secondaryKernel.runLiveness.preemptExpired(
        leasedRun.runId,
        "owner-secondary",
        secondaryNowMs,
        "stale_running_recovery"
      );

      const storedRun = await backend.transact(async (tx) => {
        return await tx.runs.get(leasedRun.runId);
      });
      if (storedRun === null) {
        throw new Error("expected preempted stored run");
      }
      const updatedBranch = await primaryKernel.branch.get(thread.branchId);
      if (updatedBranch === null) {
        throw new Error("expected preempted branch");
      }

      return createProjection({
        clockSkew: {
          // The backend clock surfaces zero expired leases while it is still
          // below the expiry, even though the peer's skewed clock would expire it.
          backendClockExpiredCountBeforeExpiry:
            expiredBeforeBackendExpiry.length,
          leaseCleared:
            storedRun.executionOwnerId === undefined &&
            storedRun.fencingToken === undefined &&
            storedRun.leaseExpiresAtMs === undefined,
          preemptedAfterBackendExpiry,
          preemptionReason: storedRun.preemptionReason ?? null,
          // The completed side-effecting call is incorporated into committed
          // history during recovery, so a resuming owner skips it by callId and
          // drives the side effect at most once.
          recoveredStagedResultTaskIds: recovery.consumedStagedResults.map(
            (staged) => staged.taskId
          ),
          recoveryHeadMatchesBranchHead:
            recovery.lastTurnNodeHash === updatedBranch.headTurnNodeHash,
          runStatus: storedRun.status,
          uncommittedStagedResultCount:
            recovery.uncommittedStagedResults.length,
          splitBrainPreemptionBlocked,
          // The skew is real: by its own clock the peer would have expired the
          // lease in phase 1.
          workerClockWouldExpire: secondaryNowMs > leaseExpiresAtMs,
        },
      });
    },
    { now: backendNow }
  );
}

async function runRestartRecovery(): Promise<Record<string, unknown>> {
  const tempDirectory = await mkdtemp(join(tmpdir(), "tuvren-kernel-restart-"));
  const databasePath = join(tempDirectory, "kernel.sqlite");
  const metadataPath = join(tempDirectory, "restart-metadata.json");

  try {
    if (ADAPTER_CONFIG.backend === "postgres") {
      return await runPostgresRestartRecovery();
    }

    await runRestartRecoveryPhase("write", databasePath, metadataPath);
    const reopened = await runRestartRecoveryPhase(
      "read",
      databasePath,
      metadataPath
    );

    return createProjection({
      restartRecovery: reopened,
    });
  } finally {
    await rm(tempDirectory, { force: true, recursive: true });
  }
}

async function runPostgresRestartRecovery(): Promise<Record<string, unknown>> {
  const { createPostgresBackend } = await import(
    new URL("../../backend-postgres/dist/index.js", import.meta.url).href
  );
  const restartSchema: TurnTreeSchema = {
    incorporationRules: [{ objectType: "message", targetPath: "messages" }],
    paths: [
      { collection: "ordered", path: "messages" },
      { collection: "single", path: "context.manifest" },
    ],
    schemaId: "schema_restart_recovery",
  };
  const schemaName = `restart_${randomUUID().replaceAll("-", "_")}`;
  const firstBackend = createPostgresBackend({
    database: process.env.PGDATABASE ?? "tuvren_runtime",
    schemaName,
  }) as ReturnType<typeof createPostgresBackend> & DisposablePostgresBackend;
  let reopenedBackend:
    | (ReturnType<typeof createPostgresBackend> & DisposablePostgresBackend)
    | undefined;

  try {
    const firstKernel = createRuntimeKernel({ backend: firstBackend });
    const schemaId = await firstKernel.schema.register(restartSchema);
    const thread = await firstKernel.thread.create(
      "thread_restart",
      schemaId,
      "branch_restart"
    );
    const turn = await firstKernel.turn.create(
      "turn_restart",
      thread.threadId,
      thread.branchId,
      null,
      thread.rootTurnNodeHash
    );
    await firstKernel.run.create(
      "run_restart",
      turn.turnId,
      thread.branchId,
      schemaId,
      thread.rootTurnNodeHash,
      [
        { deterministic: false, id: "model_call", sideEffects: false },
        { deterministic: false, id: "tool_execution", sideEffects: true },
      ]
    );
    await firstKernel.run.beginStep("run_restart", "model_call");
    const committed = await firstKernel.staging.stage(
      "run_restart",
      new TextEncoder().encode("committed assistant output"),
      "message_committed",
      "message",
      "completed"
    );
    const checkpoint = await firstKernel.run.completeStep(
      "run_restart",
      "model_call"
    );

    if (checkpoint.turnNodeHash === undefined) {
      throw new Error("expected checkpoint hash for postgres restart recovery");
    }

    await firstKernel.run.beginStep("run_restart", "tool_execution");
    const uncommitted = await firstKernel.staging.stage(
      "run_restart",
      new TextEncoder().encode("uncommitted tool output"),
      "message_uncommitted",
      "message",
      "completed"
    );

    // Close the first backend client before reopening the same disposable
    // schema so repeated conformance runs do not accumulate idle pools.
    await firstBackend.close();
    reopenedBackend = createPostgresBackend({
      database: process.env.PGDATABASE ?? "tuvren_runtime",
      schemaName,
    }) as ReturnType<typeof createPostgresBackend> & DisposablePostgresBackend;
    const reopenedKernel = createRuntimeKernel({
      backend: reopenedBackend,
    });
    const branch = await reopenedKernel.branch.get(thread.branchId);

    if (branch === null) {
      throw new Error(`expected branch "${thread.branchId}" after reopen`);
    }

    const committedNode = await reopenedKernel.node.get(
      checkpoint.turnNodeHash
    );

    if (committedNode === null) {
      throw new Error(
        `expected committed turn node "${checkpoint.turnNodeHash}" after reopen`
      );
    }

    const manifest = await reopenedKernel.tree.manifest(
      committedNode.turnTreeHash
    );
    const committedMessages = Array.isArray(manifest.messages)
      ? manifest.messages
      : [];
    const recovery = await reopenedKernel.run.recover("run_restart");
    const walkBackHashes: string[] = [];

    for await (const turnNode of reopenedKernel.node.walkBack(
      branch.headTurnNodeHash
    )) {
      walkBackHashes.push(turnNode.hash);

      if (walkBackHashes.length === 2) {
        break;
      }
    }

    return createProjection({
      restartRecovery: {
        checkpointLineageSurvivesRestart:
          committedNode.previousTurnNodeHash === thread.rootTurnNodeHash &&
          walkBackHashes[0] === checkpoint.turnNodeHash &&
          walkBackHashes[1] === thread.rootTurnNodeHash,
        committedMessageCount: committedMessages.length,
        committedStateVisible:
          branch.headTurnNodeHash === checkpoint.turnNodeHash &&
          committedMessages.length === 1 &&
          committedMessages[0] === committed.objectHash,
        recoveredLastCompletedStepId: recovery.lastCompletedStepId,
        recoveredUncommittedCount: recovery.uncommittedStagedResults.length,
        recoveryHeadMatchesCommittedCheckpoint:
          recovery.lastTurnNodeHash === checkpoint.turnNodeHash,
        uncommittedNotPromoted:
          !committedMessages.includes(uncommitted.objectHash) &&
          recovery.uncommittedStagedResults.some(
            (stagedResult) => stagedResult.objectHash === uncommitted.objectHash
          ),
      },
    });
  } finally {
    await firstBackend.close();

    if (reopenedBackend === undefined) {
      await firstBackend.dropSchema();
    } else {
      await reopenedBackend.destroy({ dropSchema: true });
    }
  }
}

async function runDurableCrashRecovery(): Promise<Record<string, unknown>> {
  const harness = await createCrashRecoveryHarness(ADAPTER_CONFIG.backend);

  try {
    return createProjection({
      crashRecovery: {
        afterCommitBeforeAck: await runCrashRecoveryFaultPoint(
          harness,
          "after-commit-before-ack",
          true
        ),
        beforeCommit: await runCrashRecoveryFaultPoint(
          harness,
          "before-commit",
          true
        ),
        midCommit: await runCrashRecoveryFaultPoint(
          harness,
          "mid-commit",
          true
        ),
      },
    });
  } finally {
    await harness.cleanup();
  }
}

async function runInProcessCrashRecovery(): Promise<Record<string, unknown>> {
  const harness = await createCrashRecoveryHarness(ADAPTER_CONFIG.backend);

  try {
    return createProjection({
      crashRecovery: {
        afterCommitBeforeAck: await runCrashRecoveryFaultPoint(
          harness,
          "after-commit-before-ack",
          false
        ),
        beforeCommit: await runCrashRecoveryFaultPoint(
          harness,
          "before-commit",
          false
        ),
        midCommit: await runCrashRecoveryFaultPoint(
          harness,
          "mid-commit",
          false
        ),
      },
    });
  } finally {
    await harness.cleanup();
  }
}

async function runCrashRecoveryFaultPoint(
  harness: CrashRecoveryBackendHarness,
  point: FaultPoint,
  reopenDurably: boolean
): Promise<Record<string, unknown>> {
  const baseBackend = await harness.createBackend();
  const kernel = createRuntimeKernel({ backend: baseBackend });
  const schema = {
    ...createCanonicalKernelTestSchema(),
    schemaId: `schema_fault_${point.replaceAll("-", "_")}`,
  } satisfies TurnTreeSchema;
  const schemaId = await kernel.schema.register(schema);
  const thread = await kernel.thread.create(
    `thread_fault_${point.replaceAll("-", "_")}`,
    schemaId,
    `branch_fault_${point.replaceAll("-", "_")}`
  );
  const turn = await kernel.turn.create(
    `turn_fault_${point.replaceAll("-", "_")}`,
    thread.threadId,
    thread.branchId,
    null,
    thread.rootTurnNodeHash
  );
  const runId = `run_fault_${point.replaceAll("-", "_")}`;

  await kernel.run.create(
    runId,
    turn.turnId,
    thread.branchId,
    schemaId,
    thread.rootTurnNodeHash,
    [
      { deterministic: false, id: "model_call", sideEffects: false },
      { deterministic: false, id: "tool_execution", sideEffects: true },
    ]
  );

  await kernel.run.beginStep(runId, "model_call");
  const committed = await kernel.staging.stage(
    runId,
    new TextEncoder().encode(`committed output ${point}`),
    `message_committed_${point.replaceAll("-", "_")}`,
    "message",
    "completed"
  );
  const firstCheckpoint = await kernel.run.completeStep(runId, "model_call");

  if (firstCheckpoint.turnNodeHash === undefined) {
    throw new Error(`expected baseline checkpoint for ${point}`);
  }

  const faultBackend = createFaultInjectingBackend(baseBackend, {
    match: { operation: "checkpoint" },
    point,
    policy: "once",
  }) as ManagedRuntimeBackend;
  const faultKernel = createRuntimeKernel({ backend: faultBackend });

  await faultKernel.run.beginStep(runId, "tool_execution");
  const pending = await faultKernel.staging.stage(
    runId,
    new TextEncoder().encode(`pending output ${point}`),
    `message_pending_${point.replaceAll("-", "_")}`,
    "message",
    "completed"
  );

  let injectedErrorCode = "no_error";

  try {
    await faultKernel.run.completeStep(runId, "tool_execution");
  } catch (error: unknown) {
    injectedErrorCode = readErrorCode(error);
  }

  let inspectionBackend: ManagedRuntimeBackend = baseBackend;

  if (reopenDurably) {
    await closeManagedBackend(baseBackend);
    inspectionBackend = await harness.createBackend();
  }

  try {
    const inspectionKernel = createRuntimeKernel({
      backend: inspectionBackend,
    });
    const branch = await inspectionKernel.branch.get(thread.branchId);

    if (branch === null) {
      throw new Error(`expected branch "${thread.branchId}" after ${point}`);
    }

    const headNode = await inspectionKernel.node.get(branch.headTurnNodeHash);

    if (headNode === null) {
      throw new Error(
        `expected branch head "${branch.headTurnNodeHash}" after ${point}`
      );
    }

    const manifest = await inspectionKernel.tree.manifest(
      headNode.turnTreeHash
    );
    const messages = Array.isArray(manifest.messages) ? manifest.messages : [];
    const recovery = await inspectionKernel.run.recover(runId);
    const walkBackHashes: string[] = [];

    for await (const turnNode of inspectionKernel.node.walkBack(
      branch.headTurnNodeHash
    )) {
      walkBackHashes.push(turnNode.hash);

      if (walkBackHashes.length === 3) {
        break;
      }
    }

    const committedFaultCheckpoint = point !== "before-commit";

    return {
      headMatchesExpectedCheckpoint: committedFaultCheckpoint
        ? branch.headTurnNodeHash !== firstCheckpoint.turnNodeHash
        : branch.headTurnNodeHash === firstCheckpoint.turnNodeHash,
      injectedErrorCode,
      lineageConsistent: committedFaultCheckpoint
        ? walkBackHashes[1] === firstCheckpoint.turnNodeHash &&
          walkBackHashes[2] === thread.rootTurnNodeHash
        : walkBackHashes[0] === firstCheckpoint.turnNodeHash &&
          walkBackHashes[1] === thread.rootTurnNodeHash,
      pendingMessageCommitted: messages.includes(pending.objectHash),
      recoveryStateConsistent: committedFaultCheckpoint
        ? recovery.lastCompletedStepId === "tool_execution" &&
          recovery.lastTurnNodeHash === branch.headTurnNodeHash &&
          recovery.uncommittedStagedResults.length === 0
        : recovery.lastCompletedStepId === "model_call" &&
          recovery.lastTurnNodeHash === firstCheckpoint.turnNodeHash &&
          recovery.uncommittedStagedResults.some(
            (stagedResult) => stagedResult.objectHash === pending.objectHash
          ),
      visibleCommittedMessageCount: messages.filter(
        (hash) => hash === committed.objectHash || hash === pending.objectHash
      ).length,
    };
  } finally {
    if (inspectionBackend !== baseBackend) {
      await closeManagedBackend(inspectionBackend);
    }
  }
}

async function runConcurrentWriterConflict(): Promise<Record<string, unknown>> {
  if (ADAPTER_CONFIG.backend === "memory") {
    const { createMemoryBackend } = await import(
      new URL("../../backend-memory/dist/index.js", import.meta.url).href
    );
    const seamBackend = createMemoryBackend();
    const raceBackend = createMemoryBackend();

    return createProjection({
      crashRecoveryConcurrency: await runConcurrentWriterConflictOnBackends(
        raceBackend,
        raceBackend
      ),
      faultPlanConcurrentWriter:
        await runFaultPlanConcurrentWriterExercise(seamBackend),
    });
  }

  const harness = await createCrashRecoveryHarness(ADAPTER_CONFIG.backend);

  try {
    const [seamBackend, firstBackend, secondBackend] = await Promise.all([
      harness.createBackend(),
      harness.createBackend(),
      harness.createBackend(),
    ]);

    try {
      return createProjection({
        crashRecoveryConcurrency: await runConcurrentWriterConflictOnBackends(
          firstBackend,
          secondBackend
        ),
        faultPlanConcurrentWriter:
          await runFaultPlanConcurrentWriterExercise(seamBackend),
      });
    } finally {
      await Promise.all([
        closeManagedBackend(seamBackend),
        closeManagedBackend(firstBackend),
        closeManagedBackend(secondBackend),
      ]);
    }
  } finally {
    await harness.cleanup();
  }
}

async function runConcurrentWriterConflictOnBackends(
  primaryBackend: RuntimeBackend,
  secondaryBackend: RuntimeBackend
): Promise<Record<string, unknown>> {
  const schema = createCanonicalKernelTestSchema();
  const schemaRecord = createStoredSchemaRecord(schema, 1);
  const turnTree = await createStoredTurnTreeRecord(
    schema,
    {
      "context.manifest": null,
      messages: [],
    },
    2
  );
  const eventObjectA = await createStoredObjectRecord(new Uint8Array([1]), 3);
  const eventObjectB = await createStoredObjectRecord(new Uint8Array([2]), 4);
  const rootNode = await createStoredTurnNodeRecord({
    consumedStagedResults: [],
    createdAtMs: 5,
    eventHash: null,
    previousTurnNodeHash: null,
    schemaId: schema.schemaId,
    turnTreeHash: turnTree.hash,
  });
  const siblingNodeA = await createStoredTurnNodeRecord({
    consumedStagedResults: [],
    createdAtMs: 6,
    eventHash: eventObjectA.hash,
    previousTurnNodeHash: rootNode.hash,
    schemaId: schema.schemaId,
    turnTreeHash: turnTree.hash,
  });
  const siblingNodeB = await createStoredTurnNodeRecord({
    consumedStagedResults: [],
    createdAtMs: 7,
    eventHash: eventObjectB.hash,
    previousTurnNodeHash: rootNode.hash,
    schemaId: schema.schemaId,
    turnTreeHash: turnTree.hash,
  });
  const thread: StoredThread = {
    createdAtMs: 8,
    rootTurnNodeHash: rootNode.hash,
    schemaId: schema.schemaId,
    threadId: "thread_concurrent_branch_head",
  };
  const branch: StoredBranch = {
    branchId: "branch_concurrent_branch_head",
    createdAtMs: 9,
    headTurnNodeHash: rootNode.hash,
    threadId: thread.threadId,
    updatedAtMs: 9,
  };

  await primaryBackend.transact(async (tx) => {
    await tx.schemas.put(schemaRecord);
    await tx.turnTrees.put(turnTree);
    await tx.turnTreePaths.putMany(
      createCanonicalTurnTreePaths(turnTree, {
        "context.manifest": null,
        messages: [],
      })
    );
    await tx.objects.put(eventObjectA);
    await tx.objects.put(eventObjectB);
    await tx.turnNodes.put(rootNode);
    await tx.turnNodes.put(siblingNodeA);
    await tx.turnNodes.put(siblingNodeB);
    await tx.threads.put(thread);
    await tx.branches.set(branch);
  });

  const [firstResult, secondResult] = await Promise.allSettled([
    primaryBackend.transact(async (tx) => {
      await tx.branches.set({
        ...branch,
        headTurnNodeHash: siblingNodeA.hash,
        updatedAtMs: 10,
      });
    }),
    secondaryBackend.transact(async (tx) => {
      await tx.branches.set({
        ...branch,
        headTurnNodeHash: siblingNodeB.hash,
        updatedAtMs: 11,
      });
    }),
  ]);

  let finalHead: string | null = null;

  await primaryBackend.transact(async (tx) => {
    finalHead =
      (await tx.branches.get(branch.branchId))?.headTurnNodeHash ?? null;
  });

  const winningHead =
    firstResult.status === "fulfilled" ? siblingNodeA.hash : siblingNodeB.hash;
  const losingResult =
    firstResult.status === "rejected" ? firstResult : secondResult;
  const losingErrorCode =
    losingResult.status === "rejected"
      ? readErrorCode(losingResult.reason)
      : "missing_rejection";
  let retryAfterLossErrorCode: string | null = null;

  if (!losingErrorCode.endsWith("_branch_head_lateral_move")) {
    const losingBackend =
      firstResult.status === "rejected" ? primaryBackend : secondaryBackend;
    const losingHead =
      firstResult.status === "rejected" ? siblingNodeA.hash : siblingNodeB.hash;
    const followUpUpdatedAtMs = firstResult.status === "rejected" ? 12 : 13;

    try {
      await losingBackend.transact(async (tx) => {
        await tx.branches.set({
          ...branch,
          headTurnNodeHash: losingHead,
          updatedAtMs: followUpUpdatedAtMs,
        });
      });
    } catch (error: unknown) {
      retryAfterLossErrorCode = readErrorCode(error);
    }
  }

  return {
    finalHeadMatchesWinner: finalHead === winningHead,
    finalHeadIsCommittedSibling:
      finalHead === siblingNodeA.hash || finalHead === siblingNodeB.hash,
    losingErrorCode,
    retryAfterLossErrorCode,
    singleWriterRejected:
      [firstResult, secondResult].filter(
        (result) => result.status === "rejected"
      ).length === 1,
    typedLateralConflictObserved:
      losingErrorCode.endsWith("_branch_head_lateral_move") ||
      retryAfterLossErrorCode?.endsWith("_branch_head_lateral_move") === true,
  };
}

async function runFaultPlanConcurrentWriterExercise(
  baseBackend: RuntimeBackend
): Promise<Record<string, unknown>> {
  const schema = {
    ...createCanonicalKernelTestSchema(),
    schemaId: "schema_fault_plan_concurrent_writer",
  } satisfies TurnTreeSchema;
  const schemaRecord = createStoredSchemaRecord(schema, 21);
  const turnTree = await createStoredTurnTreeRecord(
    schema,
    {
      "context.manifest": null,
      messages: [],
    },
    22
  );
  const rootNode = await createStoredTurnNodeRecord({
    consumedStagedResults: [],
    createdAtMs: 23,
    eventHash: null,
    previousTurnNodeHash: null,
    schemaId: schema.schemaId,
    turnTreeHash: turnTree.hash,
  });
  const childNode = await createStoredTurnNodeRecord({
    consumedStagedResults: [],
    createdAtMs: 24,
    eventHash: null,
    previousTurnNodeHash: rootNode.hash,
    schemaId: schema.schemaId,
    turnTreeHash: turnTree.hash,
  });
  const thread: StoredThread = {
    createdAtMs: 25,
    rootTurnNodeHash: rootNode.hash,
    schemaId: schema.schemaId,
    threadId: "thread_fault_plan_concurrent_writer",
  };
  const branch: StoredBranch = {
    branchId: "branch_fault_plan_concurrent_writer",
    createdAtMs: 26,
    headTurnNodeHash: rootNode.hash,
    threadId: thread.threadId,
    updatedAtMs: 26,
  };

  await baseBackend.transact(async (tx) => {
    await tx.schemas.put(schemaRecord);
    await tx.turnTrees.put(turnTree);
    await tx.turnTreePaths.putMany(
      createCanonicalTurnTreePaths(turnTree, {
        "context.manifest": null,
        messages: [],
      })
    );
    await tx.turnNodes.put(rootNode);
    await tx.threads.put(thread);
    await tx.branches.set(branch);
  });

  const faultBackend = createFaultInjectingBackend(baseBackend, {
    concurrentWriter: {
      branchId: branch.branchId,
    },
    match: {
      branchId: branch.branchId,
      operation: "checkpoint",
    },
    point: "before-commit",
    policy: "once",
  });

  let injectedErrorCode = "no_error";

  try {
    await faultBackend.transact(async (tx) => {
      await tx.turnNodes.put(childNode);
      await tx.branches.set({
        ...branch,
        headTurnNodeHash: childNode.hash,
        updatedAtMs: 27,
      });
    });
  } catch (error: unknown) {
    injectedErrorCode = readErrorCode(error);
  }

  const inspection = await baseBackend.transact(async (tx) => {
    const currentBranch = await tx.branches.get(branch.branchId);
    const currentHead =
      currentBranch === null
        ? null
        : await tx.turnNodes.get(currentBranch.headTurnNodeHash);

    return {
      branch: currentBranch,
      head: currentHead,
    };
  });

  return {
    injectedErrorCode,
    writerAdvancedHead:
      inspection.branch !== null &&
      inspection.branch.headTurnNodeHash !== branch.headTurnNodeHash &&
      inspection.branch.headTurnNodeHash !== childNode.hash,
    writerProducedSiblingHead:
      inspection.head !== null &&
      inspection.head.previousTurnNodeHash === rootNode.hash,
  };
}

async function createCrashRecoveryHarness(
  backend: KernelAdapterConfig["backend"]
): Promise<CrashRecoveryBackendHarness> {
  if (backend === "memory") {
    const { createMemoryBackend } = await import(
      new URL("../../backend-memory/dist/index.js", import.meta.url).href
    );

    return {
      cleanup: async () => {
        // Memory harnesses have no external resources to release.
      },
      createBackend: async () => createMemoryBackend() as ManagedRuntimeBackend,
    };
  }

  if (backend === "sqlite") {
    const { createSqliteBackend } = await import(
      new URL("../../backend-sqlite/dist/index.js", import.meta.url).href
    );
    const tempDirectory = await mkdtemp(
      join(tmpdir(), `tuvren-crash-recovery-${process.pid}-`)
    );
    const databasePath = join(tempDirectory, "kernel.sqlite");
    const handles = new Set<ManagedRuntimeBackend>();

    return {
      cleanup: async () => {
        for (const handle of handles) {
          await closeManagedBackend(handle, true);
        }

        await rm(tempDirectory, { force: true, recursive: true });
      },
      createBackend: () => {
        const handle = createSqliteBackend({
          databasePath,
        }) as ManagedRuntimeBackend;
        handles.add(handle);
        return Promise.resolve(handle);
      },
    };
  }

  const postgresBackendModule = await import(
    new URL("../../backend-postgres/dist/index.js", import.meta.url).href
  );
  const schemaName = `crash_${randomUUID().replaceAll("-", "_")}`;
  const options = {
    database: process.env.PGDATABASE ?? "tuvren_runtime",
    schemaName,
  };
  const handles = new Set<ManagedRuntimeBackend>();

  return {
    cleanup: async () => {
      for (const handle of handles) {
        await closeManagedBackend(handle, true);
      }

      await postgresBackendModule.destroyPostgresBackend(options);
    },
    createBackend: () => {
      const handle = postgresBackendModule.createPostgresBackend(
        options
      ) as ManagedRuntimeBackend;
      handles.add(handle);
      return Promise.resolve(handle);
    },
  };
}

async function closeManagedBackend(
  backend: ManagedRuntimeBackend,
  ignoreErrors = false
): Promise<void> {
  if (typeof backend.close !== "function") {
    return;
  }

  try {
    await backend.close();
  } catch (error: unknown) {
    if (!ignoreErrors) {
      throw error;
    }
  }
}

function createProjection<T extends Record<string, unknown>>(
  evidence: T
): Record<string, unknown> {
  return {
    evidence,
    result: evidence,
  };
}

function readStagedResults(value: unknown, label: string): StagedResult[] {
  const results = Array.isArray(value)
    ? value
    : (() => {
        throw new Error(`${label} must be an array`);
      })();
  const stagedResults: StagedResult[] = [];

  for (const [index, result] of results.entries()) {
    assertStagedResult(result, `${label}[${index}]`);
    stagedResults.push(result);
  }

  return stagedResults;
}

function readNumberArray(value: unknown, label: string): number[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }

  const values = value;

  if (!values.every((entry) => typeof entry === "number")) {
    throw new Error(`${label} must contain numbers`);
  }

  return values;
}

function readNullableString(value: unknown, label: string): string | null {
  if (value === null) {
    return null;
  }

  if (typeof value !== "string") {
    throw new Error(`${label} must be a string`);
  }

  return value;
}
