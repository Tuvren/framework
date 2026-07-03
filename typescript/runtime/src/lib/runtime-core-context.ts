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

import type { HashString } from "@tuvren/core";
import type {
  AgentConfig,
  ContextEngineeringHelpers,
  HandoffContextPlan,
  HandoffSourceContext,
} from "@tuvren/core/execution";
import type { TuvrenMessage } from "@tuvren/core/messages";
import { assertTuvrenMessage } from "@tuvren/core/messages";
import type { HeadState, LoopState } from "./runtime-core-loop.js";
import { cloneValue } from "./runtime-core-shared.js";

export interface HelperBundle {
  flush(): Promise<void>;
  helpers: ContextEngineeringHelpers;
  resolveHashes(hashes: HashString[]): HashString[];
}

export interface RuntimeCoreContextHost {
  cloneAgentConfigForRequest(config: AgentConfig): AgentConfig;
  createFrozenAgentConfig(config: AgentConfig): AgentConfig;
  createPendingKernelHash(value: Uint8Array): HashString;
  encodeMessageRecord(message: TuvrenMessage): Uint8Array;
  putKernelRecord(record: Uint8Array): Promise<HashString>;
}

export function createContextEngineeringHelpers(
  host: RuntimeCoreContextHost,
  messageHashes: HashString[],
  messages: TuvrenMessage[]
): HelperBundle {
  const existingMessages = new Map<HashString, TuvrenMessage>();
  const pendingMessages = new Map<HashString, TuvrenMessage>();
  const pendingRecords = new Map<
    HashString,
    { message: TuvrenMessage; record: Uint8Array }
  >();
  const resolvedHashes = new Map<HashString, HashString>();

  for (let index = 0; index < messageHashes.length; index += 1) {
    existingMessages.set(messageHashes[index], cloneValue(messages[index]));
  }

  return {
    async flush() {
      for (const [provisionalHash, pendingRecord] of pendingRecords) {
        const canonicalHash = await host.putKernelRecord(pendingRecord.record);
        resolvedHashes.set(provisionalHash, canonicalHash);
        pendingMessages.set(canonicalHash, cloneValue(pendingRecord.message));
      }
    },
    helpers: {
      loadMessage(hash) {
        const resolvedHash = resolvedHashes.get(hash) ?? hash;
        const message =
          pendingMessages.get(resolvedHash) ??
          pendingMessages.get(hash) ??
          existingMessages.get(resolvedHash) ??
          existingMessages.get(hash) ??
          null;

        if (message === null) {
          return null;
        }

        assertTuvrenMessage(message, `message "${hash}"`);
        return cloneValue(message);
      },
      storeMessage(message) {
        assertTuvrenMessage(message, "context engineering helper message");
        const encoded = host.encodeMessageRecord(message);
        const storedMessage = cloneValue(message);
        const provisionalHash = host.createPendingKernelHash(encoded);
        pendingMessages.set(provisionalHash, storedMessage);
        pendingRecords.set(provisionalHash, {
          message: storedMessage,
          record: encoded,
        });
        return provisionalHash;
      },
      storeMessages(messagesToStore) {
        return messagesToStore.map((message) => {
          assertTuvrenMessage(message, "context engineering helper message");
          const encoded = host.encodeMessageRecord(message);
          const storedMessage = cloneValue(message);
          const provisionalHash = host.createPendingKernelHash(encoded);
          pendingMessages.set(provisionalHash, storedMessage);
          pendingRecords.set(provisionalHash, {
            message: storedMessage,
            record: encoded,
          });
          return provisionalHash;
        });
      },
    },
    resolveHashes(hashes) {
      return hashes.map((hash) => resolvedHashes.get(hash) ?? hash);
    },
  };
}

export function resolveHandoffSourceContext(
  host: RuntimeCoreContextHost,
  plan: HandoffContextPlan,
  headState: HeadState,
  loopState: LoopState,
  targetConfig: AgentConfig,
  helpers: ContextEngineeringHelpers
): HandoffSourceContext {
  return {
    handoffIntent: cloneValue(plan.sourceContext.handoffIntent),
    helpers,
    manifest: cloneValue(headState.manifest),
    messages: cloneValue(headState.messages),
    sourceAgent: host.createFrozenAgentConfig(
      host.cloneAgentConfigForRequest(loopState.activeConfig)
    ),
    targetAgent: host.createFrozenAgentConfig(
      host.cloneAgentConfigForRequest(targetConfig)
    ),
  };
}

export function materializeContextMessages(
  hashes: HashString[],
  helpers: ContextEngineeringHelpers
): TuvrenMessage[] {
  const messages: TuvrenMessage[] = [];

  for (const hash of hashes) {
    const message = helpers.loadMessage(hash);

    if (message === null) {
      throw new Error(`message "${hash}" does not exist`);
    }

    messages.push(message);
  }

  return messages;
}
