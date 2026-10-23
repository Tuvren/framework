import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

import { spawn } from "bun";

const root = path.resolve(import.meta.dirname, "../../../..");
const valid =
  '"activated":true,"activationCount":1,"kind":"implementation","mutantId":"probe","signal":"observed"';

for (const [name, fields] of [
  ["valid", valid],
  ["legacy duplicate", `${valid},"activationCount":1`],
  [
    "legacy fraction",
    valid.replace('"activationCount":1', '"activationCount":1.5'),
  ],
  ["duplicate", `${valid},"activationCount":1`],
  ["escaped duplicate", `${valid},"activation\\u0043ount":1`],
  ["fraction", valid.replace('"activationCount":1', '"activationCount":1.5')],
  [
    "rounded fraction",
    valid.replace(
      '"activationCount":1',
      '"activationCount":1.0000000000000001'
    ),
  ],
  [
    "unsafe integer",
    valid.replace('"activationCount":1', '"activationCount":9007199254740993'),
  ],
  [
    "negative zero",
    valid.replace('"activationCount":1', '"activationCount":-0'),
  ],
  ["undeclared", `${valid},"verdict":true`],
  ["map duplicate", `${valid},"payload":{"$map":[["a",1],["a",2]]}`],
  ["map non-string", `${valid},"payload":{"$map":[[1,2]]}`],
  ["events encoding", valid],
  ["state encoding", valid],
] as const) {
  test(`catalogued observation ${name} is validated before captures and assertions`, async () => {
    const accepted = name === "valid" || name.startsWith("legacy ");
    const dir = await mkdtemp(path.join(tmpdir(), "tuvren-db002-"));
    try {
      const packet = path.join(dir, "packet.json");
      const catalogPath = path.join(dir, "operations.json");
      const catalog = {
        catalogId: "probe.operations",
        catalogVersion: "0.1.0",
        packetId: "tuvren.kernel.protocol",
        operations: [
          {
            operationId: "kernel.mutant.activation",
            kind: "control",
            capability: "probe",
            input: {},
            observation: {
              result: {
                type: "object",
                additionalProperties: false,
                properties: {
                  activation: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      activated: { type: "boolean" },
                      activationCount: { type: "integer" },
                      kind: { type: "string" },
                      mutantId: { type: "string" },
                      signal: { type: "string" },
                      payload: {
                        $ref: "https://tuvren.dev/schemas/conformance-observation-encoding.schema.json#/$defs/record",
                      },
                    },
                  },
                },
              },
              events: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    payload: {
                      $ref: "https://tuvren.dev/schemas/conformance-observation-encoding.schema.json#/$defs/record",
                    },
                  },
                },
              },
              state: {
                type: "object",
                additionalProperties: false,
                properties: {
                  payload: {
                    $ref: "https://tuvren.dev/schemas/conformance-observation-encoding.schema.json#/$defs/record",
                  },
                },
              },
            },
          },
        ],
      };
      await writeFile(catalogPath, JSON.stringify(catalog));
      const plan = path.join(dir, "plan.json");
      const adapter = path.join(dir, "adapter.json");
      const host = path.join(dir, "host.ts");
      await writeFile(
        host,
        `for await (const line of console) {
        const r = JSON.parse(line);
        if (r.method === "dispatch") {
          process.stdout.write('{"id":' + r.id + ',"jsonrpc":"2.0","result":{"kind":"result","value":{"result":{"activation":{${fields}}}}}}\\n');
          continue;
        }
        const result = r.method === "initialize" ? { adapterId:"probe",capabilities:["probe"],packetId:r.params.packetId,planVersion:r.params.planVersion } : r.method === "events" ? ${name === "events encoding" ? '[{payload: {$bytes: "FF"}}]' : "[]"} : r.method === "inspectState" ? ${name === "state encoding" ? '{payload: {$bytes: "FF"}}' : "{}"} : null;
        process.stdout.write(JSON.stringify({id:r.id,jsonrpc:"2.0",result}) + "\\n");
      }`
      );
      await writeFile(
        packet,
        JSON.stringify({
          conformancePlans: [
            { path: plan, planId: "probe", planVersion: "0.1.0" },
          ],
          operationCatalog: catalogPath,
          packetId: "tuvren.kernel.protocol",
        })
      );
      await writeFile(
        adapter,
        JSON.stringify({
          adapterId: "probe",
          authorityPackets: [packet],
          boundary: "shared",
          capabilities: ["probe"],
          command: ["bun", host],
          implementationId: "probe",
          language: "typescript",
          protocol: {
            name: "tuvren.conformance-adapter",
            transport: "json-rpc-2.0-stdio",
            version: "0.2.0",
          },
          suiteId: "probe",
          suiteVersion: "0.1.0",
        })
      );
      await writeFile(
        plan,
        JSON.stringify({
          applicability: { capabilities: ["probe"] },
          checks: [
            {
              assertions: [
                {
                  equals: "observed",
                  field: "$.trace.read.result.activation.signal",
                  kind: "resultField",
                },
              ],
              checkId: "probe",
              operation: "probe.trace",
              steps: [
                {
                  arguments: {},
                  inspectState: {},
                  capture: [
                    { name: "signal", path: "result.activation.signal" },
                  ],
                  operation: name.startsWith("legacy ")
                    ? "probe.uncatalogued"
                    : "kernel.mutant.activation",
                  stepId: "read",
                },
              ],
            },
          ],
          packetId: "tuvren.kernel.protocol",
          planId: "probe",
          planVersion: "0.1.0",
        })
      );
      const child = spawn(
        ["bun", "tools/conformance/harness/run.ts", "--adapter", adapter],
        {
          cwd: root,
          env: { ...process.env, VERIFY_LOG_DIR: path.join(dir, "logs") },
          stderr: "pipe",
          stdout: "pipe",
        }
      );
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(stderr).not.toContain("SyntaxError");
      expect(code).toBe(accepted ? 0 : 1);
      const evidence: unknown = JSON.parse(stdout);
      expect(evidence).toMatchObject({
        checkResults: [
          accepted
            ? { status: "pass" }
            : {
                failure: { classification: "adapter_protocol" },
                status: "fail",
              },
        ],
      });
      if (!accepted) {
        expect(stdout).not.toContain('"errorEnvelope"');
      }
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });
}
