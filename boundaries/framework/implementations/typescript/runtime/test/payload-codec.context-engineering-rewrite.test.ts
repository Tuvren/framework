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

// KRT-BF007 (carried from the BF005 milestone review) — crypto-shredding coverage
// for the context-engineering rewrite path. The BF005 suite exercises the codec
// through staged messages (provider/tool/client edges); this drives the codec
// through the context-engineering flush/handoff `putKernelRecord` path
// (runtime-core-transition-support.ts → runtime-core-context.ts), where a rewrite
// stores a message under a transient provisional (plaintext) hash that is then
// remapped to the canonical post-store (ciphertext) hash. The test proves the
// rewritten summary lands as a `TVE1` envelope, the head turn tree references the
// canonical ciphertext hash (so the provisional→canonical remap is correct), and
// the head-state read decrypts it back to plaintext.

import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { createMemoryBackend } from "@tuvren/backend-memory";
import {
  createAesGcmPayloadCodec,
  isPayloadEnvelope,
} from "@tuvren/core/lifecycle";
import { createRuntimeKernel } from "@tuvren/kernel-runtime";
import { createTuvrenRuntime } from "../src/index.ts";
import {
  createDriverRegistry,
  createStaticDriver,
} from "./orchestration-runtime-driver-helpers.ts";
import { assistantText, textSignal } from "./runtime-core-test-helpers.ts";

const SCOPE = "tenant.context-engineering";
const USER_SECRET = "USER-PII-rewrite-path-7777";
const PROVIDER_SECRET = "PROVIDER-RESULT-rewrite-path-8888";
const CE_SUMMARY_SECRET = "CONTEXT-ENGINEERING-SUMMARY-DIGEST-9999";

function buildEncryptedRuntime(keys: Map<string, Uint8Array>): {
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
    payloadCodec: createAesGcmPayloadCodec({
      keyring: { resolve: (keyRef) => keys.get(keyRef) },
    }),
    scope: SCOPE,
  });
  return { framework, kernel };
}

async function readHeadMessageHashes(
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
    ? resolved.filter((hash): hash is string => typeof hash === "string")
    : [];
}

function bytesContainText(bytes: Uint8Array, text: string): boolean {
  return Buffer.from(bytes).includes(Buffer.from(text, "utf8"));
}

describe("KRT-BF007 context-engineering rewrite crypto-shredding", () => {
  test("encrypts the rewrite-path summary and resolves its canonical ciphertext hash through the provisional remap", async () => {
    const keys = new Map([[SCOPE, new Uint8Array(randomBytes(32))]]);
    const { framework, kernel } = buildEncryptedRuntime(keys);

    const thread = await framework.createThread({});
    const handle = framework.executeTurn({
      branchId: thread.branchId,
      config: {
        // On the first iteration the context-engineering policy appends a summary
        // message; the framework persists it through the rewrite `putKernelRecord`
        // path, which encrypts it and remaps the provisional hash to canonical.
        contextPolicy: {
          evaluate(_manifest, iterationCount) {
            if (iterationCount !== 1) {
              return { action: "none" };
            }
            return {
              action: "append_ce_summary",
              execute(context) {
                return [
                  ...context.messageHashes,
                  context.helpers.storeMessage(
                    assistantText(CE_SUMMARY_SECRET)
                  ),
                ];
              },
            };
          },
        },
        name: "agent",
      },
      signal: textSignal(USER_SECRET),
      threadId: thread.threadId,
    });
    const result = await handle.awaitResult();
    expect(result.status).toBe("completed");

    const messageHashes = await readHeadMessageHashes(kernel, thread.branchId);
    // user input + context-engineering summary (rewrite path) + provider reply.
    expect(messageHashes.length).toBeGreaterThanOrEqual(3);

    // Every head-tree message hash — including the rewrite-path summary — is the
    // canonical post-store ciphertext hash. A correct provisional→canonical remap
    // means each hash resolves to a stored TVE1 envelope holding no plaintext; a
    // broken remap would leave the tree pointing at an unstored provisional hash.
    for (const hash of messageHashes) {
      const stored = await kernel.store.get(hash);
      if (stored === null) {
        throw new Error(`message ${hash} missing from store`);
      }
      expect(isPayloadEnvelope(stored)).toBe(true);
      expect(bytesContainText(stored, CE_SUMMARY_SECRET)).toBe(false);
      expect(bytesContainText(stored, USER_SECRET)).toBe(false);
      expect(bytesContainText(stored, PROVIDER_SECRET)).toBe(false);
    }

    // The head-state read decrypts the rewrite-path summary back to plaintext.
    const read = await framework.readBranchMessages({
      branchId: thread.branchId,
    });
    const flattened = JSON.stringify(read.messages);
    expect(flattened).toContain(USER_SECRET);
    expect(flattened).toContain(CE_SUMMARY_SECRET);
    expect(flattened).toContain(PROVIDER_SECRET);
  });

  test("destroying the key shreds the rewrite-path summary while the lineage stays byte-identical", async () => {
    const keys = new Map([[SCOPE, new Uint8Array(randomBytes(32))]]);
    const { framework, kernel } = buildEncryptedRuntime(keys);

    const thread = await framework.createThread({});
    const handle = framework.executeTurn({
      branchId: thread.branchId,
      config: {
        contextPolicy: {
          evaluate(_manifest, iterationCount) {
            if (iterationCount !== 1) {
              return { action: "none" };
            }
            return {
              action: "append_ce_summary",
              execute(context) {
                return [
                  ...context.messageHashes,
                  context.helpers.storeMessage(
                    assistantText(CE_SUMMARY_SECRET)
                  ),
                ];
              },
            };
          },
        },
        name: "agent",
      },
      signal: textSignal(USER_SECRET),
      threadId: thread.threadId,
    });
    expect((await handle.awaitResult()).status).toBe("completed");

    const headBefore = (await kernel.branch.get(thread.branchId))
      ?.headTurnNodeHash;
    const hashesBefore = await readHeadMessageHashes(kernel, thread.branchId);

    // Crypto-shred: the host destroys the scope key.
    keys.delete(SCOPE);

    // The rewrite-path summary is now unrecoverable, but the lineage that
    // references it is byte-identical — erasure rewrote no history.
    const read = await framework.readBranchMessages({
      branchId: thread.branchId,
    });
    expect(JSON.stringify(read.messages)).not.toContain(CE_SUMMARY_SECRET);
    expect((await kernel.branch.get(thread.branchId))?.headTurnNodeHash).toBe(
      headBefore as string
    );
    expect(await readHeadMessageHashes(kernel, thread.branchId)).toEqual(
      hashesBefore
    );
  });
});
