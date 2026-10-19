import { test } from "bun:test";
import assert from "node:assert/strict";

import { spawn } from "bun";

interface ProtocolResponse {
  id: number;
  result?: Record<string, unknown>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isProtocolResponse = (value: unknown): value is ProtocolResponse =>
  isRecord(value) &&
  typeof value.id === "number" &&
  (value.result === undefined || isRecord(value.result));

interface HostResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

const runHost = async (requests: readonly string[]): Promise<HostResult> => {
  const child = spawn(
    ["bun", "typescript/providers/conformance-adapter/src/host.ts"],
    {
      cwd: process.cwd(),
      stderr: "pipe",
      stdin: "pipe",
      stdout: "pipe",
    }
  );
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();

  try {
    await child.stdin.write(`${requests.join("\n")}\n`);
    await child.stdin.end();

    const [exitCode, capturedStdout, capturedStderr] = await Promise.all([
      child.exited,
      stdout,
      stderr,
    ]);

    return { exitCode, stderr: capturedStderr, stdout: capturedStdout };
  } finally {
    if (!child.killed) {
      child.kill();
      await child.exited;
    }
    await Promise.allSettled([stdout, stderr]);
  }
};

test("provider host handles fixed JSONL protocol requests", async () => {
  const { exitCode, stderr, stdout } = await runHost([
    '{"id":1,"jsonrpc":"2.0","method":"dispatch","params":{"operation":"providers.bridge.generate-mapping"}}',
    '{"id":2,"jsonrpc":"2.0","method":"dispatch","params":{"operation":"constructor"}}',
    '{"id":3,"jsonrpc":"2.0","method":"dispatch","params":{"operation":"toString"}}',
    '{"id":4,"jsonrpc":"2.0","method":"dispatch","params":{"operation":"__proto__"}}',
  ]);

  assert.equal(exitCode, 0, stderr);
  const responses = stdout
    .trim()
    .split("\n")
    .map((line): ProtocolResponse => {
      const response: unknown = JSON.parse(line);
      assert.ok(isProtocolResponse(response));
      return response;
    });

  assert.equal(responses.length, 4);
  assert.deepEqual(
    responses.map((response) => response.id),
    [1, 2, 3, 4]
  );
  assert.equal(responses[0]?.result?.kind, "result");
  const value = responses[0]?.result?.value;
  assert.ok(isRecord(value));
  assert.ok("evidence" in value);

  for (const [index, operation] of [
    "constructor",
    "toString",
    "__proto__",
  ].entries()) {
    assert.deepEqual(responses[index + 1]?.result, {
      error: {
        code: "adapter_operation_not_implemented",
        message: `provider adapter does not implement ${operation}`,
      },
      kind: "error",
    });
  }
});
