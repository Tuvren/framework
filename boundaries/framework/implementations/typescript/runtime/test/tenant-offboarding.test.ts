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

// biome-ignore-all lint/suspicious/useAwait: Test drivers intentionally match the async framework driver contract.

// KRT-BF006 — Framework Maintenance Surface + Tenant-Offboarding Flow (ADR-051,
// architecture flow §4.17).
//
// End-to-end proof over real memory backends sharing one scope-keyed substrate:
// two tenants (Scopes A and B) each store sensitive untrusted-edge payloads
// under their own host-held key. Offboarding A — the host destroys A's key
// (crypto-shredding), then drives reclamation and the substrate partition drop
// through the framework maintenance surface — renders A's payloads unrecoverable
// and releases A's unreferenced state, while tenant B is wholly unaffected
// (cross-scope isolation preserved from Epic BE).

import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import {
  createMemoryBackend,
  createMemoryScopeStore,
  type MemoryScopeStore,
} from "@tuvren/backend-memory";
import { TuvrenRuntimeError } from "@tuvren/core";
import {
  createAesGcmPayloadCodec,
  isErasedPayload,
  type PayloadCodec,
  type PayloadKeyring,
} from "@tuvren/core/lifecycle";
import { createRuntimeKernel } from "@tuvren/kernel-runtime";
import { createTuvren, createTuvrenRuntime } from "../src/index.ts";
import {
  createDriverRegistry,
  createStaticDriver,
} from "./orchestration-runtime-driver-helpers.ts";
import { assistantText, textSignal } from "./runtime-core-test-helpers.ts";

const SCOPE_A = "tenant.A";
const SCOPE_B = "tenant.B";

interface Tenant {
  framework: ReturnType<typeof createTuvrenRuntime>;
  kernel: ReturnType<typeof createRuntimeKernel>;
  providerSecret: string;
}

function createKeyring(keys: Map<string, Uint8Array>): PayloadKeyring {
  return { resolve: (keyRef) => keys.get(keyRef) };
}

function buildTenant(input: {
  scope: string;
  store: MemoryScopeStore;
  codec: PayloadCodec;
  providerSecret: string;
}): Tenant {
  const backend = createMemoryBackend({
    scope: input.scope,
    store: input.store,
  });
  const kernel = createRuntimeKernel({ backend });
  const framework = createTuvrenRuntime({
    defaultDriverId: "fake",
    driverRegistry: createDriverRegistry([
      createStaticDriver(async () => ({
        messages: [assistantText(input.providerSecret)],
        resolution: { reason: "done", type: "end_turn" },
      })),
    ]),
    kernel,
    payloadCodec: input.codec,
    // The substrate partition-drop the offboarding flow drives is the owned
    // backend's purgeScope; `createTuvren` wires this automatically, and here we
    // wire it explicitly because the tenant drives a hand-built runtime.
    purgeScope: () => backend.purgeScope?.() ?? Promise.resolve(),
    scope: input.scope,
  });
  return { framework, kernel, providerSecret: input.providerSecret };
}

async function runTurn(
  tenant: Tenant,
  thread: { branchId: string; threadId: string },
  userSecret: string
): Promise<void> {
  const handle = tenant.framework.executeTurn({
    branchId: thread.branchId,
    config: { name: "agent" },
    signal: textSignal(userSecret),
    threadId: thread.threadId,
  });
  const result = await handle.awaitResult();
  expect(result.status).toBe("completed");
}

async function headHash(tenant: Tenant, branchId: string): Promise<string> {
  const branch = await tenant.kernel.branch.get(branchId);
  if (branch === null) {
    throw new Error("branch missing");
  }
  return branch.headTurnNodeHash;
}

async function readPlaintext(
  tenant: Tenant,
  branchId: string
): Promise<string> {
  const read = await tenant.framework.readBranchMessages({ branchId });
  return JSON.stringify(read.messages);
}

describe("KRT-BF006 tenant offboarding flow", () => {
  test("offboarding scope A shreds its payloads and reclaims its unreferenced state without touching scope B", async () => {
    const store = createMemoryScopeStore();
    const keys = new Map<string, Uint8Array>([
      [SCOPE_A, new Uint8Array(randomBytes(32))],
      [SCOPE_B, new Uint8Array(randomBytes(32))],
    ]);
    // One codec, keyed per-Scope from the call context, so the same instance
    // protects both tenants under their own keys.
    const codec = createAesGcmPayloadCodec({ keyring: createKeyring(keys) });

    const A_USER_SECRET = "A-user-pii-alpha";
    const A_PROVIDER_SECRET = "A-provider-result-alpha";
    const B_USER_SECRET = "B-user-pii-beta";
    const B_PROVIDER_SECRET = "B-provider-result-beta";

    const tenantA = buildTenant({
      codec,
      providerSecret: A_PROVIDER_SECRET,
      scope: SCOPE_A,
      store,
    });
    const tenantB = buildTenant({
      codec,
      providerSecret: B_PROVIDER_SECRET,
      scope: SCOPE_B,
      store,
    });

    // Each tenant runs a first turn that durably stores sensitive payloads.
    const threadA = await tenantA.framework.createThread({});
    const threadB = await tenantB.framework.createThread({});
    await runTurn(tenantA, threadA, A_USER_SECRET);
    await runTurn(tenantB, threadB, B_USER_SECRET);

    const liveHeadA = await headHash(tenantA, threadA.branchId);

    // Tenant A runs a second turn, then rolls its branch head back to the first
    // turn. The rolled-off segment is archived and becomes unreferenced state —
    // exactly what reclamation should release during offboarding.
    await runTurn(tenantA, threadA, "A-second-turn-abandoned");
    const rollback = await tenantA.framework.setBranchHead({
      branchId: threadA.branchId,
      turnNodeHash: liveHeadA,
    });
    expect(rollback.archiveBranchId).toBeDefined();

    // Before offboarding both tenants can read their own plaintext back.
    expect(await readPlaintext(tenantA, threadA.branchId)).toContain(
      A_USER_SECRET
    );
    expect(await readPlaintext(tenantB, threadB.branchId)).toContain(
      B_USER_SECRET
    );

    // ── Offboard tenant A ──────────────────────────────────────────────────
    // 1. The host destroys A's key (crypto-shredding). Keys are host-owned, so
    //    this is not a runtime call.
    keys.delete(SCOPE_A);

    // 2. The host drives reclamation for A through the framework maintenance
    //    surface; the unreferenced (archived) segment is released.
    const summaryA = await tenantA.framework.maintenance.reclaim();
    expect(summaryA.releasedArchivedBranchCount).toBeGreaterThanOrEqual(1);
    expect(summaryA.releasedObjectCount).toBeGreaterThanOrEqual(1);

    // A's sensitive payloads are now unrecoverable: the still-reachable first
    // turn reads back as typed erased markers, never plaintext.
    const readA = await tenantA.framework.readBranchMessages({
      branchId: threadA.branchId,
    });
    expect(readA.messages.length).toBeGreaterThanOrEqual(2);
    for (const message of readA.messages) {
      expect(isErasedPayload(message)).toBe(true);
    }
    const flattenedA = JSON.stringify(readA.messages);
    expect(flattenedA).not.toContain(A_USER_SECRET);
    expect(flattenedA).not.toContain(A_PROVIDER_SECRET);

    // A's archived branch is gone after reclamation.
    const branchesA = await tenantA.kernel.branch.list(threadA.threadId);
    expect(branchesA.some(([branchId]) => branchId.includes("archive"))).toBe(
      false
    );

    // Tenant B is wholly unaffected: its key is intact, its payloads decrypt,
    // and its state is present.
    expect(await readPlaintext(tenantB, threadB.branchId)).toContain(
      B_USER_SECRET
    );
    expect(await readPlaintext(tenantB, threadB.branchId)).toContain(
      B_PROVIDER_SECRET
    );
    expect(await tenantB.kernel.thread.get(threadB.threadId)).not.toBeNull();

    // 3. Full offboarding drops A's entire substrate partition.
    await tenantA.framework.maintenance.purgeScope();

    // A's partition is gone: its thread no longer resolves and a fresh scoped
    // view of the store sees no threads.
    expect(await tenantA.kernel.thread.get(threadA.threadId)).toBeNull();
    const survivorViewA = createRuntimeKernel({
      backend: createMemoryBackend({ scope: SCOPE_A, store }),
    });
    expect(await survivorViewA.thread.get(threadA.threadId)).toBeNull();

    // Tenant B remains fully intact after A's partition drop.
    expect(await tenantB.kernel.thread.get(threadB.threadId)).not.toBeNull();
    expect(await readPlaintext(tenantB, threadB.branchId)).toContain(
      B_USER_SECRET
    );
  });

  test("createTuvren wires the maintenance surface onto an owned backend", async () => {
    await using instance = await createTuvren({
      backend: { kind: "memory", options: { scope: SCOPE_A } },
    });

    // Reclamation runs through the kernel (memory advertises the capability).
    const summary = await instance.runtime.maintenance.reclaim();
    expect(summary.releasedObjectCount).toBe(0);

    // The owned backend supports partition drop, so purgeScope resolves.
    await instance.runtime.maintenance.purgeScope();
  });

  test("an externally supplied kernel leaves purgeScope unavailable", async () => {
    const kernel = createRuntimeKernel({
      backend: createMemoryBackend({ scope: SCOPE_B }),
    });
    // When a kernel is supplied it takes precedence and the (required) backend
    // spec is ignored — createTuvren never owns a substrate to drive a partition
    // drop against, so purgeScope stays unavailable.
    await using instance = await createTuvren({ backend: "memory", kernel });

    // Reclamation still works (it only needs the kernel), but the partition
    // drop has no owned substrate to act on and is reported as unsupported.
    await instance.runtime.maintenance.reclaim();
    await expect(instance.runtime.maintenance.purgeScope()).rejects.toThrow(
      TuvrenRuntimeError
    );
  });
});
