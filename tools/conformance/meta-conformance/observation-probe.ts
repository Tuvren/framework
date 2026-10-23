#!/usr/bin/env bun
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

import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const separator = process.argv.indexOf("--");
const destination = process.argv[2];
const command = process.argv.slice(separator + 1);
if (destination === undefined || separator < 0 || command.length === 0) {
  throw new Error(
    "observation probe requires <directory> -- <adapter command>"
  );
}
const child = spawn(command[0] ?? "", command.slice(1), {
  stdio: ["pipe", "pipe", "inherit"],
});
const requests = new Map<unknown, { method: string; operation?: string }>();
let observations: unknown[] = [];
const frame = (line: string): Record<string, unknown> => {
  const value: unknown = JSON.parse(line);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("probe received a non-object RPC frame");
  }
  return Object.fromEntries(Object.entries(value));
};
createInterface({ input: child.stdout }).on("line", (line) => {
  const response = frame(line);
  const request = requests.get(response.id);
  requests.delete(response.id);
  if (request?.method === "createInstance") {
    observations = [];
  } else if (request?.method === "destroyInstance") {
    appendFileSync(
      `${destination}/${process.pid}.jsonl`,
      `${JSON.stringify(observations)}\n`
    );
    observations = [];
  } else if (
    request !== undefined &&
    request.method !== "initialize" &&
    request.method !== "shutdown"
  ) {
    observations.push({
      method: request.method,
      operation: request.operation,
      outcome: response.result,
      ...(response.error === undefined ? {} : { error: response.error }),
    });
  }
  process.stdout.write(`${line}\n`);
});
child.on("error", (error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
child.on("close", (code) => {
  process.exitCode = code ?? 1;
});
process.on("SIGTERM", () => {
  child.kill("SIGTERM");
});
for await (const line of createInterface({ input: process.stdin })) {
  const request = frame(line);
  const params = request.params;
  const operation =
    typeof params === "object" &&
    params !== null &&
    "operation" in params &&
    typeof params.operation === "string"
      ? params.operation
      : undefined;
  requests.set(request.id, { method: String(request.method), operation });
  child.stdin.write(`${line}\n`);
}
child.stdin.end();
