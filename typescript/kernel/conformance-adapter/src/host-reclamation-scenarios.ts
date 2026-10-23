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

import { randomBytes } from "node:crypto";

import type { createRuntimeKernel } from "@tuvren/kernel-runtime";
import { createAesGcmPayloadCodec } from "@tuvren/sdk";

import { createProjection } from "./host-scenario-support.js";
import type { KernelAdapterConfig } from "./host-scenario-support.js";
import {
  createConformanceRuntimeKernel,
  loadCanonicalSchema,
  withConfiguredBackend,
  withConformanceKernel,
  withScopedBackendPair,
} from "./host-support.js";

/**
 * Runs one non-deterministic checkpoint step that stages the supplied message
 * into the branch-head turn tree and returns the checkpoint lineage details.
 */
const checkpointMessageIntoHead = async (
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
): Promise<{ objectHash: string; turnId: string; turnNodeHash: string }> => {
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
};

const bytesEqual = (left: Uint8Array, right: Uint8Array): boolean => {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
};

const isRecoverable = async (
  codec: ReturnType<typeof createAesGcmPayloadCodec>,
  stored: Uint8Array | null,
  context: { edge: string; scope: string },
  expectedPlaintext: Uint8Array
): Promise<boolean> => {
  if (stored === null) {
    return false;
  }
  const decrypted = await codec.decrypt(stored, context);
  return (
    decrypted.status === "available" &&
    bytesEqual(decrypted.plaintext, expectedPlaintext)
  );
};

export const createReclamationScenarios = (config: KernelAdapterConfig) => {
  // KRT-BE007 cross-scope isolation probe. Constructs two kernels over two
  // Scopes bound to one shared substrate, seeds content and an enumerable thread
  // under scope A, then reports — as raw observations, never graded here — what
  // each Scope can see. The plan's assertions decide pass/fail; this host only
  // measures store.has / store.get / enumeration across the scope boundary.
  const runCrossScopeProbe = async (): Promise<Record<string, unknown>> => {
    const schema = await loadCanonicalSchema();

    return await withScopedBackendPair(
      config,
      async ({ backendA, backendB }) => {
        const kernelA = createConformanceRuntimeKernel(config, {
          backend: backendA,
        });
        const kernelB = createConformanceRuntimeKernel(config, {
          backend: backendB,
        });
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
  };

  // KRT-BF007 reachability reclamation probe. Constructs decisive scenarios over a
  // reclamation-capable backend and reports — as raw observations, never graded
  // here — what the §9.4 mark-and-sweep released and retained. The plan's
  // assertions decide pass/fail. Two phases: (1) an archive rollback over a shared
  // non-root ancestor proves the keep closure is a set-union over live roots (a
  // structurally shared object survives via the live branch while the
  // archive-exclusive payload is released); (2) a deterministic clock orders writes
  // around an active execution lease to prove the grace window is the lease horizon.
  const runReclamationProbe = async (): Promise<Record<string, unknown>> => {
    const schema = await loadCanonicalSchema();

    const reachabilityObservations = await withConformanceKernel(
      schema,
      config,
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
      config,
      async (backend) => {
        const kernel = createConformanceRuntimeKernel(config, {
          backend,
          now: () => clock,
        });
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

    // KRT-BK002 leaseless-expiry probes. A leaseless running run (no
    // executionOwnerId/fencingToken/leaseExpiresAtMs at all) whose creator
    // crashes must eventually stop pinning the grace horizon, or an unrelated
    // orphan created after it would never become reclaimable (ADR-0050/
    // ADR-0051). Two phases mirror grace-window discipline: (A) a leaseless
    // running run whose updatedAtMs has gone quiet past the 24h default
    // administrative expiry horizon is excluded from pinning, so a
    // subsequently-created orphan is released; (B) the same shape, but with
    // reclaim invoked well within the expiry horizon, still pins the horizon so
    // the orphan is retained. Each phase uses its own clock closure so neither
    // perturbs `graceObservations`' clock above.
    let leaselessExpiredClock = 0;
    const leaselessExpiredObservations = await withConfiguredBackend(
      config,
      async (backend) => {
        const kernel = createConformanceRuntimeKernel(config, {
          backend,
          now: () => leaselessExpiredClock,
        });
        await kernel.schema.register(schema);

        const thread = await kernel.thread.create(
          "thread_leaseless_expired",
          schema.schemaId,
          "branch_leaseless_expired"
        );
        const turn = await kernel.turn.create(
          "turn_leaseless_expired",
          thread.threadId,
          thread.branchId,
          null,
          thread.rootTurnNodeHash
        );
        // A leaseless running run (no executionOwnerId/fencingToken/
        // leaseExpiresAtMs) whose creator crashes and never transitions it out
        // of "running".
        await kernel.run.create(
          "run_leaseless_expired",
          turn.turnId,
          thread.branchId,
          schema.schemaId,
          thread.rootTurnNodeHash,
          [{ deterministic: true, id: "work", sideEffects: false }]
        );

        leaselessExpiredClock = 10;
        const orphan = await kernel.store.put(
          new TextEncoder().encode("leaseless-expiry-orphan")
        );

        // Past the run's updatedAtMs (t=0) by more than the 24h default
        // leaseless-expiry horizon: the run is excluded from pinning the grace
        // horizon, so this orphan (created after the run, at t=10) becomes
        // reclaimable.
        leaselessExpiredClock = 86_400_000 + 5000;
        await kernel.maintenance.reclaim();

        return {
          leaselessRunPastAdminExpiryDoesNotPinReclamation:
            !(await kernel.store.has(orphan)),
        };
      },
      { now: () => leaselessExpiredClock }
    );

    let leaselessActiveClock = 0;
    const leaselessActiveObservations = await withConfiguredBackend(
      config,
      async (backend) => {
        const kernel = createConformanceRuntimeKernel(config, {
          backend,
          now: () => leaselessActiveClock,
        });
        await kernel.schema.register(schema);

        const thread = await kernel.thread.create(
          "thread_leaseless_active",
          schema.schemaId,
          "branch_leaseless_active"
        );
        const turn = await kernel.turn.create(
          "turn_leaseless_active",
          thread.threadId,
          thread.branchId,
          null,
          thread.rootTurnNodeHash
        );
        // A leaseless running run whose updatedAtMs (t=0) is still well within
        // the 24h default leaseless-expiry horizon at reclaim time.
        await kernel.run.create(
          "run_leaseless_active",
          turn.turnId,
          thread.branchId,
          schema.schemaId,
          thread.rootTurnNodeHash,
          [{ deterministic: true, id: "work", sideEffects: false }]
        );

        leaselessActiveClock = 10;
        const orphan = await kernel.store.put(
          new TextEncoder().encode("leaseless-active-orphan")
        );

        // Well under the 24h expiry horizon since run creation at t=0: the run
        // still pins the grace horizon, so this orphan (created after the run,
        // at t=10) stays retained.
        leaselessActiveClock = 1000;
        await kernel.maintenance.reclaim();

        return {
          leaselessRunWithinAdminExpiryStillPinsReclamation:
            await kernel.store.has(orphan),
        };
      },
      { now: () => leaselessActiveClock }
    );

    return createProjection({
      reclaim: {
        ...reachabilityObservations,
        ...graceObservations,
        ...leaselessExpiredObservations,
        ...leaselessActiveObservations,
      },
    });
  };

  // KRT-BF007 crypto-shredding erasure probe. The adapter plays the §4.17 host
  // role: it owns a payload codec and the key, encrypts at the edge, and hands the
  // kernel only the opaque ciphertext envelope. "Erasure" is the host destroying
  // the key (removing it from the keyring). The probe reports — as raw
  // observations — that the payload is recoverable before and unrecoverable after
  // key destruction, while the referencing kernel lineage stays byte/hash-identical
  // (the kernel never held the key, so nothing structural changes).
  const runErasureProbe = async (): Promise<Record<string, unknown>> => {
    const schema = await loadCanonicalSchema();

    return await withConformanceKernel(schema, config, async (kernel) => {
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
  };

  return Object.freeze({
    runCrossScopeProbe,
    runErasureProbe,
    runReclamationProbe,
  });
};
