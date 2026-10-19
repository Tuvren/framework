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
  const child = spawn(["bun", "typescript/conformance-adapter/src/host.ts"], {
    cwd: process.cwd(),
    stderr: "pipe",
    stdin: "pipe",
    stdout: "pipe",
  });
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

test("framework host handles fixed JSONL protocol requests", async () => {
  const { exitCode, stderr, stdout } = await runHost([
    '{"id":1,"jsonrpc":"2.0","method":"initialize","params":{"packetId":"framework-runtime","planVersion":"1.0.0"}}',
    '{"id":2,"jsonrpc":"2.0","method":"dispatch","params":{"operation":"runtime.capability-policy.exposure-dimensions"}}',
    '{"id":3,"jsonrpc":"2.0","method":"dispatch","params":{"operation":"constructor"}}',
    '{"id":4,"jsonrpc":"2.0","method":"dispatch","params":{"operation":"toString"}}',
    '{"id":5,"jsonrpc":"2.0","method":"dispatch","params":{"operation":"__proto__"}}',
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

  assert.equal(responses.length, 5);
  assert.deepEqual(
    responses.map((response) => response.id),
    [1, 2, 3, 4, 5]
  );
  assert.equal(responses[0]?.result?.adapterId, "typescript-framework");
  assert.equal(responses[1]?.result?.kind, "result");
  const value = responses[1]?.result?.value;
  assert.ok(isRecord(value));
  assert.ok("evidence" in value);

  for (const [index, operation] of [
    "constructor",
    "toString",
    "__proto__",
  ].entries()) {
    assert.deepEqual(responses[index + 2]?.result, {
      error: {
        code: "adapter_operation_failed",
        message: `unsupported promoted framework operation ${operation}`,
      },
      kind: "error",
    });
  }
});
