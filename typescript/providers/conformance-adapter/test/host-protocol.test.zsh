#!/usr/bin/env zsh

set -euo pipefail

typeset responses
responses=$(bun typescript/providers/conformance-adapter/src/host.ts <<'REQUESTS'
{"id":1,"jsonrpc":"2.0","method":"dispatch","params":{"operation":"providers.bridge.generate-mapping"}}
{"id":2,"jsonrpc":"2.0","method":"dispatch","params":{"operation":"constructor"}}
{"id":3,"jsonrpc":"2.0","method":"dispatch","params":{"operation":"toString"}}
{"id":4,"jsonrpc":"2.0","method":"dispatch","params":{"operation":"__proto__"}}
REQUESTS
)

bun -e '
import { strict as assert } from "node:assert/strict";

const responses = (await Bun.stdin.text())
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));
const operations = ["constructor", "toString", "__proto__"];

assert.equal(responses.length, 4);
assert.deepEqual(responses.map((response) => response.id), [1, 2, 3, 4]);
assert.equal(responses[0]?.result?.kind, "result");
assert.ok("evidence" in responses[0].result.value);

for (const [index, operation] of operations.entries()) {
  assert.deepEqual(responses[index + 1]?.result, {
    error: {
      code: "adapter_operation_not_implemented",
      message: `provider adapter does not implement ${operation}`,
    },
    kind: "error",
  });
}
' <<< "$responses"
