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

/**
 * Headless remote peer for the REPL host's `--serve-ws` demo server (M6,
 * issue #102). Connects with `@tuvren/session-client`, registers a handler
 * for the demo `tuvren-client.demo` capability, logs every canonical stream
 * event to stdout as JSONL, and records each capability invocation's
 * `idempotencyKey` plus payload to a scratch NDJSON file so a driving test
 * (or a human) can externally verify dedup: a redelivered invocation for the
 * same logical call must always append the same `idempotencyKey`.
 *
 * Usage:
 *   bun scripts/ws-peer.ts --url ws://127.0.0.1:PORT --session-id sess-1 \
 *     --effects-log /tmp/ws-peer-effects.ndjson
 *
 * @packageDocumentation
 */

import { appendFile } from "node:fs/promises";
import process from "node:process";
import { createSessionClient } from "@tuvren/session-client";
import { DEMO_CLIENT_CAPABILITY_ID } from "../src/lib/repl-serve-ws.js";

interface PeerArgs {
  effectsLogPath: string;
  sessionId: string;
  url: string;
}

function parseArgs(argv: readonly string[]): PeerArgs {
  let url: string | undefined;
  let sessionId: string | undefined;
  let effectsLogPath: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--url") {
      url = argv[index + 1];
      index += 1;
    } else if (arg === "--session-id") {
      sessionId = argv[index + 1];
      index += 1;
    } else if (arg === "--effects-log") {
      effectsLogPath = argv[index + 1];
      index += 1;
    }
  }

  if (
    url === undefined ||
    sessionId === undefined ||
    effectsLogPath === undefined
  ) {
    throw new Error(
      "usage: ws-peer.ts --url <ws-url> --session-id <id> --effects-log <path>"
    );
  }

  return { effectsLogPath, sessionId, url };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const client = createSessionClient({
    capabilities: {
      [DEMO_CLIENT_CAPABILITY_ID]: async (input, ctx) => {
        // The externally-checkable side effect: append idempotencyKey +
        // input to a scratch file so a driving test can assert dedup by
        // reading this file back and counting entries per idempotencyKey,
        // independent of anything this process holds in memory.
        await appendFile(
          args.effectsLogPath,
          `${JSON.stringify({
            callId: ctx.callId,
            idempotencyKey: ctx.idempotencyKey,
            input,
            recordedAtMs: Date.now(),
          })}\n`
        );
        return { acknowledged: true };
      },
    },
    onEvent(event, cursor) {
      process.stdout.write(
        `${JSON.stringify({ cursor, event, kind: "event" })}\n`
      );
    },
    onRejection(rejection) {
      process.stdout.write(
        `${JSON.stringify({ kind: "rejection", rejection })}\n`
      );
    },
    onStatusChange(status) {
      process.stdout.write(`${JSON.stringify({ kind: "status", status })}\n`);
    },
    sessionId: args.sessionId,
    url: args.url,
  });

  process.on("SIGINT", () => {
    client.close(1000, "peer shutting down");
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    client.close(1000, "peer shutting down");
    process.exit(0);
  });

  client.connect();

  // Keep the process alive; the harness drives lifecycle via signals.
  await new Promise<void>(() => {
    // Intentionally never resolves.
  });
}

await main();
