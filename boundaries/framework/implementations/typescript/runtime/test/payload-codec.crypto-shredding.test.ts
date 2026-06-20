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

// KRT-BF005 — Host-Key-Encrypted Untrusted-Edge Payload Envelope (ADR-051).
//
// End-to-end proof of crypto-shredding over a real memory backend: a provider
// (and user) message produced during a turn is encrypted under a host-held key
// before it reaches the kernel store, the kernel only ever holds the ciphertext
// envelope, destroying the key renders the payload unrecoverable while leaving
// the lineage hash structure byte-identical, and the durable read of an erased
// payload is a typed total result rather than a crash.

import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { createMemoryBackend } from "@tuvren/backend-memory";
import {
  createAesGcmPayloadCodec,
  isErasedPayload,
  isPayloadEnvelope,
  type PayloadKeyring,
} from "@tuvren/core/lifecycle";
import { createRuntimeKernel } from "@tuvren/kernel-runtime";
import { createTuvrenRuntime } from "../src/index.ts";
import {
  createDriverRegistry,
  createStaticDriver,
} from "./orchestration-runtime-driver-helpers.ts";
import { assistantText, textSignal } from "./runtime-core-test-helpers.ts";

const SCOPE = "tenant.crypto-shredding";
const PROVIDER_SECRET = "SENSITIVE-PROVIDER-RESULT-4242";
const USER_SECRET = "USER-PII-name-and-ssn";

function createKeyring(keys: Map<string, Uint8Array>): PayloadKeyring {
  return { resolve: (keyRef) => keys.get(keyRef) };
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
        messages: [assistantText(PROVIDER_SECRET)],
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
    signal: textSignal(USER_SECRET),
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

describe("KRT-BF005 crypto-shredding payload envelope", () => {
  test("encrypts untrusted-edge messages so the kernel only holds ciphertext", async () => {
    const keys = new Map([[SCOPE, new Uint8Array(randomBytes(32))]]);
    const runtime = buildRuntime({ keys });
    const { branchId } = await runOneTurn(runtime);

    const messageHashes = await readMessageHashes(runtime.kernel, branchId);
    // The user input and the provider result are both staged as messages.
    expect(messageHashes.length).toBeGreaterThanOrEqual(2);

    for (const hash of messageHashes) {
      const stored = await runtime.kernel.store.get(hash);
      if (stored === null) {
        throw new Error(`message ${hash} missing from store`);
      }
      // The kernel holds a ciphertext envelope, never the plaintext secrets.
      expect(isPayloadEnvelope(stored)).toBe(true);
      expect(bytesContainText(stored, PROVIDER_SECRET)).toBe(false);
      expect(bytesContainText(stored, USER_SECRET)).toBe(false);
    }

    // The durable read decrypts back to the original plaintext.
    const read = await runtime.framework.readBranchMessages({ branchId });
    const flattened = JSON.stringify(read.messages);
    expect(flattened).toContain(PROVIDER_SECRET);
    expect(flattened).toContain(USER_SECRET);
  });

  test("destroying the key makes the payload unrecoverable while the lineage hash structure is unchanged and the read is a typed erased result", async () => {
    const keys = new Map([[SCOPE, new Uint8Array(randomBytes(32))]]);
    const runtime = buildRuntime({ keys });
    const { branchId } = await runOneTurn(runtime);

    const branchBefore = await runtime.kernel.branch.get(branchId);
    const headBefore = branchBefore?.headTurnNodeHash;
    const hashesBefore = await readMessageHashes(runtime.kernel, branchId);
    expect(hashesBefore.length).toBeGreaterThanOrEqual(2);

    // Crypto-shred: the host destroys the scope key.
    keys.delete(SCOPE);

    // The read is total: every shredded message surfaces as a typed erased
    // marker rather than throwing, and none of the plaintext is recoverable.
    const read = await runtime.framework.readBranchMessages({ branchId });
    expect(read.messages.length).toBe(hashesBefore.length);
    for (const message of read.messages) {
      expect(isErasedPayload(message)).toBe(true);
    }
    const flattened = JSON.stringify(read.messages);
    expect(flattened).not.toContain(PROVIDER_SECRET);
    expect(flattened).not.toContain(USER_SECRET);

    // The lineage hash structure that references the payload is byte-identical:
    // erasure rewrote no history. The head node and message objects still exist.
    const branchAfter = await runtime.kernel.branch.get(branchId);
    expect(branchAfter?.headTurnNodeHash).toBe(headBefore as string);
    expect(await readMessageHashes(runtime.kernel, branchId)).toEqual(
      hashesBefore
    );
    expect(await runtime.kernel.node.get(headBefore as string)).not.toBeNull();
    for (const hash of hashesBefore) {
      expect(await runtime.kernel.store.has(hash)).toBe(true);
    }
  });

  test("attempting to resume execution over a shredded conversation fails with a typed error rather than feeding ciphertext to the model", async () => {
    const keys = new Map([[SCOPE, new Uint8Array(randomBytes(32))]]);
    const runtime = buildRuntime({ keys });
    const { branchId, threadId } = await runOneTurn(runtime);

    keys.delete(SCOPE);

    const handle = runtime.framework.executeTurn({
      branchId,
      config: { name: "agent" },
      signal: textSignal("continue"),
      threadId,
    });
    const result = await handle.awaitResult();
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect((result.error as { code?: string }).code).toBe(
        "kernel_payload_erased"
      );
    }
  });

  test("with no codec the kernel stores plaintext and reads it back (back-compatible)", async () => {
    const runtime = buildRuntime({});
    const { branchId } = await runOneTurn(runtime);

    const messageHashes = await readMessageHashes(runtime.kernel, branchId);
    expect(messageHashes.length).toBeGreaterThanOrEqual(2);

    let sawProviderPlaintext = false;
    for (const hash of messageHashes) {
      const stored = await runtime.kernel.store.get(hash);
      if (stored === null) {
        throw new Error(`message ${hash} missing from store`);
      }
      // No envelope: stored bytes are the plaintext kernel record.
      expect(isPayloadEnvelope(stored)).toBe(false);
      if (bytesContainText(stored, PROVIDER_SECRET)) {
        sawProviderPlaintext = true;
      }
    }
    expect(sawProviderPlaintext).toBe(true);

    const read = await runtime.framework.readBranchMessages({ branchId });
    expect(JSON.stringify(read.messages)).toContain(PROVIDER_SECRET);
  });
});
