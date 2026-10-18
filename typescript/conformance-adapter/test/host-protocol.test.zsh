#!/usr/bin/env zsh

set -euo pipefail

typeset responses
responses=$(bun typescript/conformance-adapter/src/host.ts <<'REQUESTS'
{"id":1,"jsonrpc":"2.0","method":"initialize","params":{"packetId":"framework-runtime","planVersion":"1.0.0"}}
{"id":2,"jsonrpc":"2.0","method":"dispatch","params":{"operation":"runtime.capability-policy.exposure-dimensions"}}
{"id":3,"jsonrpc":"2.0","method":"dispatch","params":{"operation":"constructor"}}
{"id":4,"jsonrpc":"2.0","method":"dispatch","params":{"operation":"toString"}}
{"id":5,"jsonrpc":"2.0","method":"dispatch","params":{"operation":"__proto__"}}
REQUESTS
)

bun -e '
import { strict as assert } from "node:assert/strict";

const responses = (await Bun.stdin.text())
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));
const inheritedOperations = ["constructor", "toString", "__proto__"];

assert.equal(responses.length, 5);
assert.deepEqual(responses.map((response) => response.id), [1, 2, 3, 4, 5]);
assert.equal(responses[0]?.result?.adapterId, "typescript-framework");
assert.equal(responses[1]?.result?.kind, "result");
assert.ok("evidence" in responses[1].result.value);

for (const [index, operation] of inheritedOperations.entries()) {
  assert.deepEqual(responses[index + 2]?.result, {
    error: {
      code: "adapter_operation_failed",
      message: `unsupported promoted framework operation ${operation}`,
    },
    kind: "error",
  });
}
' <<< "$responses"
