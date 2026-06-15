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

import { describe, expect, test } from "bun:test";
import {
  createReplTranscriptWriter,
  parseReplTranscriptRecord,
  type ReplTranscriptHeader,
  readReplTranscriptFromLines,
  redactReplTranscriptBackendOptions,
} from "../src/lib/repl-transcript.ts";

function header(backendOptions: unknown): ReplTranscriptHeader {
  return {
    config: {
      backend: { kind: "postgres", options: backendOptions },
      providerMode: "aimock-openai",
    },
    recordedAtMs: 1,
    recordKind: "header",
    runtimeVersion: "test",
    v: 1,
  };
}

async function captureHeaderLine(h: ReplTranscriptHeader): Promise<string> {
  const lines: string[] = [];
  await createReplTranscriptWriter({
    header: h,
    write(line) {
      lines.push(line);
    },
  });
  return lines[0] ?? "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

describe("repl transcript backend-options redaction (KRT-BD002)", () => {
  test("masks PostgreSQL connectionString and password while keeping topology", () => {
    const redacted = redactReplTranscriptBackendOptions({
      connectionString: "postgres://app:hunter2@db.internal:5432/appdb",
      database: "appdb",
      password: "hunter2",
      schemaName: "public",
    });
    expect(redacted).toEqual({
      connectionString: "***",
      database: "appdb",
      password: "***",
      schemaName: "public",
    });
  });

  test("masks any credential-shaped key and embedded-URL credential values", () => {
    const redacted = redactReplTranscriptBackendOptions({
      accessKey: "AKIA...",
      apiKey: "sk-secret",
      authToken: "bearer-xyz",
      dsn: "mysql://root:rootpw@127.0.0.1/db",
      host: "db.internal",
      port: 5432,
      pwd: "p1",
      passwd: "p2",
    }) as Record<string, unknown>;
    expect(redacted.accessKey).toBe("***");
    expect(redacted.apiKey).toBe("***");
    expect(redacted.authToken).toBe("***");
    expect(redacted.dsn).toBe("***");
    expect(redacted.pwd).toBe("***");
    expect(redacted.passwd).toBe("***");
    // Topology fields, including the URL "authority", are not over-masked.
    expect(redacted.host).toBe("db.internal");
    expect(redacted.port).toBe(5432);
  });

  test("the writer masks secret-bearing backend options in the recorded header", async () => {
    const line = await captureHeaderLine(
      header({
        connectionString: "postgres://app:hunter2@db.internal/appdb",
        database: "appdb",
        password: "hunter2",
        schemaName: "public",
      })
    );
    expect(line).not.toContain("hunter2");
    const record = parseReplTranscriptRecord(line);
    if (record.recordKind !== "header") {
      throw new Error("expected a header record");
    }
    const options = record.config.backend.options;
    if (!isRecord(options)) {
      throw new Error("expected backend options object");
    }
    expect(options.connectionString).toBe("***");
    expect(options.password).toBe("***");
    // The non-secret backend identity descriptor survives for replay topology.
    expect(options.database).toBe("appdb");
    expect(options.schemaName).toBe("public");
  });

  test("a transcript with only non-secret options is unchanged and stays replayable", async () => {
    const original = header({ database: "appdb", schemaName: "public" });
    const line = await captureHeaderLine(original);
    const readable = await readReplTranscriptFromLines([line, ""]);
    expect(readable.header.config.backend).toEqual({
      kind: "postgres",
      options: { database: "appdb", schemaName: "public" },
    });
  });
});
