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

import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CreateTuvrenOptions } from "@tuvren/runtime";
import { createTuvren } from "@tuvren/runtime";
import {
  type AdapterProjection,
  collectValues,
  createScenarioProvider,
  textSignal,
} from "./framework-adapter-runtime.ts";

const BATTERIES_INCLUDED_MOCK_RESPONSE = {
  finishReason: "stop" as const,
  parts: [{ text: "batteries-included-ok", type: "text" as const }],
  usage: { inputTokens: 5, outputTokens: 3 },
};

export function createFrameworkAdapterBatteriesIncluded(): {
  runBatteriesIncludedLifecycle(input: unknown): Promise<AdapterProjection>;
} {
  return { runBatteriesIncludedLifecycle };
}

async function runBatteriesIncludedLifecycle(
  input: unknown
): Promise<AdapterProjection> {
  const backendKind = readBackendKind(input);
  const { backendSpec, cleanupPath } = buildBackendSpec(backendKind);
  const provider = createScenarioProvider(
    [BATTERIES_INCLUDED_MOCK_RESPONSE],
    () => undefined
  );

  const instance = await createTuvren({
    backend: backendSpec,
    driver: { kind: "react", options: { providerCallMode: "generate" } },
    provider,
  });

  let turnCompleted = false;
  let messagesRead = false;
  let messageCount = 0;

  try {
    const { threadId, branchId } = await instance.runtime.createThread({});

    const handle = instance.orchestration.executeTurn({
      agent: "agent",
      branchId,
      signal: textSignal("run"),
      threadId,
    });

    const eventsPromise = collectValues(handle.allEvents());
    const result = await handle.awaitResult();
    await eventsPromise;
    turnCompleted = result.status === "completed";

    const read = await instance.runtime.readBranchMessages({ branchId });
    messagesRead = true;
    messageCount = read.messages.length;
  } finally {
    await instance[Symbol.asyncDispose]();
    if (cleanupPath !== undefined) {
      await rm(cleanupPath, { force: true, recursive: true });
    }
  }

  return {
    result: {
      batteriesIncluded: {
        lifecycle: {
          backend: backendKind,
          constructed: true,
          disposed: true,
          messageCount,
          messagesRead,
          turnCompleted,
        },
      },
    },
  };
}

function readBackendKind(input: unknown): string {
  if (typeof input !== "object" || input === null) {
    return "memory";
  }
  const checkInput = (input as Record<string, unknown>).checkInput;
  if (typeof checkInput !== "object" || checkInput === null) {
    return "memory";
  }
  const backend = (checkInput as Record<string, unknown>).backend;
  return typeof backend === "string" ? backend : "memory";
}

function buildBackendSpec(kind: string): {
  backendSpec: CreateTuvrenOptions["backend"];
  cleanupPath: string | undefined;
} {
  switch (kind) {
    case "memory":
      return { backendSpec: "memory", cleanupPath: undefined };
    case "sqlite": {
      const dir = join(tmpdir(), `tuvren-bi-${randomUUID()}`);
      const databasePath = join(dir, "kernel.sqlite");
      return {
        backendSpec: { kind: "sqlite", options: { databasePath } },
        cleanupPath: dir,
      };
    }
    case "postgres": {
      const schemaName = `bi_${randomUUID().replaceAll("-", "_")}`;
      return {
        backendSpec: {
          kind: "postgres",
          options: {
            database: process.env.PGDATABASE ?? "tuvren_runtime",
            host: process.env.PGHOST,
            password: process.env.PGPASSWORD,
            port:
              process.env.PGPORT === undefined
                ? undefined
                : Number(process.env.PGPORT),
            schemaName,
            username: process.env.PGUSER,
          },
        },
        cleanupPath: undefined,
      };
    }
    default:
      throw new Error(
        `batteries-included.lifecycle: unknown backend kind "${kind}"`
      );
  }
}
