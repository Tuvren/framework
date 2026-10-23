/**
 * Copyright 2026 Oscar Yanez Cisterna (@SkrOYC)
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

export const statePrecedenceAdapterScript = `
  for await (const line of console) {
    const request = JSON.parse(line);
    const respond = (result) => {
      process.stdout.write(JSON.stringify({
        id: request.id,
        jsonrpc: "2.0",
        result
      }) + "\\n");
    };

    if (request.method === "initialize") {
      respond({
        adapterId: "state-precedence-adapter",
        capabilities: ["runner.state"],
        packetId: request.params.packetId,
        planVersion: request.params.planVersion
      });
      continue;
    }

    if (request.method === "dispatch") {
      respond({
        kind: "result",
        value: {
          state: { source: "dispatch" }
        }
      });
      continue;
    }

    if (request.method === "events") {
      respond([]);
      continue;
    }

    if (request.method === "inspectState") {
      respond({ source: "inspect" });
      continue;
    }

    if (request.method === "createInstance" || request.method === "destroyInstance") {
      respond(request.method === "createInstance" ? "instance" : null);
      continue;
    }
    if (request.method === "shutdown") {
      respond(null);
    }
  }
`;

export const errorStateAdapterScript = `
  for await (const line of console) {
    const request = JSON.parse(line);
    const respond = (result) => {
      process.stdout.write(JSON.stringify({
        id: request.id,
        jsonrpc: "2.0",
        result
      }) + "\\n");
    };

    if (request.method === "initialize") {
      respond({
        adapterId: "error-state-adapter",
        capabilities: ["runner.state"],
        packetId: request.params.packetId,
        planVersion: request.params.planVersion
      });
      continue;
    }

    if (request.method === "dispatch") {
      respond({
        error: {
          code: "adapter_failed",
          message: "operation failed"
        },
        kind: "error"
      });
      continue;
    }

    if (request.method === "events") {
      respond([]);
      continue;
    }

    if (request.method === "inspectState") {
      respond({ source: "inspect" });
      continue;
    }

    if (request.method === "createInstance" || request.method === "destroyInstance") {
      respond(request.method === "createInstance" ? "instance" : null);
      continue;
    }
    if (request.method === "shutdown") {
      respond(null);
    }
  }
`;

export const createProjectionProbeAdapterScript = (logPath: string): string => `
  import { appendFileSync } from "node:fs";
  for await (const line of console) {
    appendFileSync(${JSON.stringify(logPath)}, line + "\\n");
    const request = JSON.parse(line);
    const params = request.params ?? {};
    let result = null;
    if (request.method === "initialize") {
      result = {
        adapterId: "projection-probe",
        capabilities: ["projection"],
        packetId: params.packetId,
        planVersion: params.planVersion
      };
    }
    if (request.method === "createInstance") result = "instance-1";
    if (request.method === "dispatch") {
      result = {
        kind: "result",
        value: {
          result: { received: params.input, token: "token-" + params.operation }
        }
      };
    }
    if (request.method === "events") result = [];
    process.stdout.write(JSON.stringify({ id: request.id, jsonrpc: "2.0", result }) + "\\n");
  }
`;

export const failureProbeAdapterScript = `
  for await (const line of console) {
    const request = JSON.parse(line);
    const params = request.params ?? {};
    const respond = (result) => {
      process.stdout.write(JSON.stringify({ id: request.id, jsonrpc: "2.0", result }) + "\\n");
    };
    if (request.method === "initialize") {
      respond({
        adapterId: "failure-probe",
        capabilities: ["failure"],
        packetId: params.packetId,
        planVersion: params.planVersion
      });
      continue;
    }
    if (request.method === "dispatch" && params.operation === "malformed") {
      process.stdout.write("{not a json-rpc frame\\n");
      continue;
    }
    if (request.method === "dispatch" && params.operation === "transcript") {
      for (let index = 0; index < 300; index += 1) {
        process.stdout.write(JSON.stringify({
          id: 900000 + index,
          jsonrpc: "2.0",
          result: "n".repeat(5000)
        }) + "\\n");
      }
    }
    if (request.method === "dispatch" && params.operation === "provision") {
      await new Promise((resolve) => {
        process.stderr.write(
          "storage provisioning failed: connect ECONNREFUSED 127.0.0.1:5432\\n",
          resolve
        );
      });
      process.exit(3);
    }
    if (request.method === "dispatch") {
      respond({ kind: "result", value: { result: { status: "observed" } } });
      continue;
    }
    respond(request.method === "events" ? [] : null);
  }
`;
