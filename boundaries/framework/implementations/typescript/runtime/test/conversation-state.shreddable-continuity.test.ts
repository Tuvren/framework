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

// KRT-BH002 — Shreddable continuity artifacts (ADR-053 + ADR-051).
//
// ADR-053 makes the durable lineage the unconditional source of truth for a
// provider request: provider server-side state and carried continuity artifacts
// are reconstructable optimizations, never a correctness dependency, and must
// stay inside the tenant's erasure reach. There is no separate continuity
// persistence surface in the runtime — a carried continuity artifact rides as
// `providerMetadata` on the durable assistant message record, which is already
// routed through the single BF005 crypto-shredding seam (MESSAGE_PAYLOAD_EDGE).
//
// These tests assert that explicitly: continuity providerMetadata persisted on
// an assistant message is stored as a host-key-encrypted shreddable reference,
// destroying the key renders the continuity unrecoverable while the lineage hash
// structure stays byte-identical, and the durable read is a typed total result.

import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { createMemoryBackend } from "@tuvren/backend-memory";
import {
  createAesGcmPayloadCodec,
  isErasedPayload,
  isPayloadEnvelope,
  type PayloadKeyring,
} from "@tuvren/core/lifecycle";
import type { TuvrenMessage } from "@tuvren/core/messages";
import { createRuntimeKernel } from "@tuvren/kernel-runtime";
import { createTuvrenRuntime } from "../src/index.ts";
import {
  createDriverRegistry,
  createStaticDriver,
} from "./orchestration-runtime-driver-helpers.ts";
import { textSignal } from "./runtime-core-test-helpers.ts";

const SCOPE = "tenant.conversation-state-continuity";
// A provider-namespaced continuity artifact (e.g. a Google thought signature or
// an OpenAI response continuation token) carried back from a prior turn.
const CONTINUITY_SECRET = "CONTINUITY-thought-signature-9f3a";

function createKeyring(keys: Map<string, Uint8Array>): PayloadKeyring {
  return { resolve: (keyRef) => keys.get(keyRef) };
}

function assistantWithContinuity(text: string): TuvrenMessage {
  return {
    parts: [
      {
        providerMetadata: {
          google: { thoughtSignature: CONTINUITY_SECRET },
        },
        text,
        type: "text",
      },
    ],
    providerMetadata: {
      google: { thoughtSignature: CONTINUITY_SECRET },
    },
    role: "assistant",
  };
}

function buildRuntime(options: { keys?: Map<string, Uint8Array> }): {
  framework: ReturnType<typeof createTuvrenRuntime>;
  kernel: ReturnType<typeof createRuntimeKernel>;
} {
  const kernel = createRuntimeKernel({
    backend: createMemoryBackend({ scope: SCOPE }),
  });
  const framework = createTuvrenRuntime({
    defaultDriverId: "fake",
    driverRegistry: createDriverRegistry([
      createStaticDriver(async () => ({
        messages: [assistantWithContinuity("here is your answer")],
        resolution: { reason: "done", type: "end_turn" },
      })),
    ]),
    kernel,
    scope: SCOPE,
    ...(options.keys === undefined
      ? {}
      : {
          payloadCodec: createAesGcmPayloadCodec({
            keyring: createKeyring(options.keys),
          }),
        }),
  });
  return { framework, kernel };
}

async function runOneTurn(runtime: {
  framework: ReturnType<typeof createTuvrenRuntime>;
}): Promise<{ branchId: string; threadId: string }> {
  const thread = await runtime.framework.createThread({});
  const handle = runtime.framework.executeTurn({
    branchId: thread.branchId,
    config: { name: "agent" },
    signal: textSignal("what is the answer?"),
    threadId: thread.threadId,
  });
  const result = await handle.awaitResult();
  expect(result.status).toBe("completed");
  return { branchId: thread.branchId, threadId: thread.threadId };
}

async function readMessageHashes(
  kernel: ReturnType<typeof createRuntimeKernel>,
  branchId: string
): Promise<string[]> {
  const branch = await kernel.branch.get(branchId);
  if (branch === null) {
    throw new Error("branch missing");
  }
  const node = await kernel.node.get(branch.headTurnNodeHash);
  if (node === null) {
    throw new Error("head turn node missing");
  }
  const resolved = await kernel.tree.resolve(node.turnTreeHash, "messages");
  return Array.isArray(resolved)
    ? resolved.filter((h): h is string => typeof h === "string")
    : [];
}

function bytesContainText(bytes: Uint8Array, text: string): boolean {
  return Buffer.from(bytes).includes(Buffer.from(text, "utf8"));
}

describe("KRT-BH002 shreddable continuity artifacts", () => {
  test("carried continuity providerMetadata is stored only as a host-key-encrypted reference", async () => {
    const keys = new Map([[SCOPE, new Uint8Array(randomBytes(32))]]);
    const runtime = buildRuntime({ keys });
    const { branchId } = await runOneTurn(runtime);

    const messageHashes = await readMessageHashes(runtime.kernel, branchId);
    expect(messageHashes.length).toBeGreaterThanOrEqual(2);

    // The kernel only ever holds the ciphertext envelope; the continuity
    // artifact never appears in the durable bytes the kernel hashes.
    for (const hash of messageHashes) {
      const stored = await runtime.kernel.store.get(hash);
      if (stored === null) {
        throw new Error(`message ${hash} missing from store`);
      }
      expect(isPayloadEnvelope(stored)).toBe(true);
      expect(bytesContainText(stored, CONTINUITY_SECRET)).toBe(false);
    }

    // The durable read decrypts the continuity back for legitimate reconstruction.
    const read = await runtime.framework.readBranchMessages({ branchId });
    expect(JSON.stringify(read.messages)).toContain(CONTINUITY_SECRET);
  });

  test("destroying the key shreds the carried continuity while the lineage stays byte-identical", async () => {
    const keys = new Map([[SCOPE, new Uint8Array(randomBytes(32))]]);
    const runtime = buildRuntime({ keys });
    const { branchId } = await runOneTurn(runtime);

    const branchBefore = await runtime.kernel.branch.get(branchId);
    const headBefore = branchBefore?.headTurnNodeHash;
    const hashesBefore = await readMessageHashes(runtime.kernel, branchId);
    expect(hashesBefore.length).toBeGreaterThanOrEqual(2);

    // Crypto-shred: the host destroys the scope key (tenant erasure).
    keys.delete(SCOPE);

    const read = await runtime.framework.readBranchMessages({ branchId });
    expect(read.messages.length).toBe(hashesBefore.length);
    for (const message of read.messages) {
      expect(isErasedPayload(message)).toBe(true);
    }
    // The continuity artifact is unrecoverable — it was never a correctness
    // dependency and is now permanently gone with the rest of the message.
    expect(JSON.stringify(read.messages)).not.toContain(CONTINUITY_SECRET);

    // Erasure rewrote no history: the head node and every message object hash
    // that referenced the continuity are byte-identical.
    const branchAfter = await runtime.kernel.branch.get(branchId);
    expect(branchAfter?.headTurnNodeHash).toBe(headBefore as string);
    expect(await readMessageHashes(runtime.kernel, branchId)).toEqual(
      hashesBefore
    );
    for (const hash of hashesBefore) {
      expect(await runtime.kernel.store.has(hash)).toBe(true);
    }
  });

  test("with no codec the continuity is stored plaintext (back-compatible)", async () => {
    const runtime = buildRuntime({});
    const { branchId } = await runOneTurn(runtime);

    const messageHashes = await readMessageHashes(runtime.kernel, branchId);
    let sawContinuityPlaintext = false;
    for (const hash of messageHashes) {
      const stored = await runtime.kernel.store.get(hash);
      if (stored === null) {
        throw new Error(`message ${hash} missing from store`);
      }
      expect(isPayloadEnvelope(stored)).toBe(false);
      if (bytesContainText(stored, CONTINUITY_SECRET)) {
        sawContinuityPlaintext = true;
      }
    }
    expect(sawContinuityPlaintext).toBe(true);
  });
});
