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

import { loadReplConfig } from "../src/lib/repl-config.ts";
import {
  createReplTranscriptWriter,
  parseReplTranscriptRecord,
  readReplTranscriptFromLines,
} from "../src/lib/repl-transcript.ts";
import type { ReplTranscriptHeader } from "../src/lib/repl-transcript.ts";

const SCOPE_A = "tuvren.scope.tenant-a";
const SCOPE_B = "tuvren.scope.tenant-b";

const scopedHeader = (scope: string | undefined): ReplTranscriptHeader => ({
  config: {
    backend: { kind: "memory" },
    providerMode: "fixture",
    ...(scope === undefined ? {} : { scope }),
  },
  recordKind: "header",
  recordedAtMs: 1,
  runtimeVersion: "test",
  v: 1,
});

const writeHeaderLines = async (
  header: ReplTranscriptHeader
): Promise<string[]> => {
  const lines: string[] = [];
  const writer = await createReplTranscriptWriter({
    header,
    write(line) {
      lines.push(line);
    },
  });
  await writer.writeEntry({
    input: ".status",
    ordinal: 0,
    recordKind: "input",
    recordedAtMs: 2,
    v: 1,
  });
  await writer.close();
  return lines;
};

describe("repl transcript scope correlation (KRT-BE008)", () => {
  test("records the host-bound scope in the header and round-trips it", async () => {
    const lines = await writeHeaderLines(scopedHeader(SCOPE_A));
    const readable = await readReplTranscriptFromLines([...lines, ""]);
    expect(readable.header.config.scope).toBe(SCOPE_A);
  });

  test("a transcript correlated to scope A carries no other scope identifier", async () => {
    const serialized = (await writeHeaderLines(scopedHeader(SCOPE_A))).join("");
    expect(serialized).toContain(SCOPE_A);
    expect(serialized).not.toContain(SCOPE_B);
  });

  test("remains backward compatible with scope-free transcripts", async () => {
    const lines = await writeHeaderLines(scopedHeader(undefined));
    const readable = await readReplTranscriptFromLines([...lines, ""]);
    expect(readable.header.config.scope).toBeUndefined();
  });

  test("rejects a non-string scope in the header", () => {
    expect(() =>
      parseReplTranscriptRecord(
        JSON.stringify({
          config: {
            backend: { kind: "memory" },
            providerMode: "fixture",
            scope: 42,
          },
          recordKind: "header",
          recordedAtMs: 1,
          runtimeVersion: "test",
          v: 1,
        })
      )
    ).toThrow("header.config.scope must be a string");
  });

  test("loads the host-bound scope from --scope and the environment", () => {
    expect(loadReplConfig({}, ["--scope", SCOPE_A]).scope).toBe(SCOPE_A);
    expect(loadReplConfig({ TUVREN_REPL_SCOPE: SCOPE_B }, []).scope).toBe(
      SCOPE_B
    );
    expect(loadReplConfig({}, []).scope).toBeUndefined();
  });
});
