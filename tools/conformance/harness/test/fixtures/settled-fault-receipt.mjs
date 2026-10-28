#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const [executable, ...args] = process.argv.slice(2);
if (executable === undefined) {
  throw new Error("missing adapter executable");
}
const child = spawn(executable, args, { stdio: ["pipe", "pipe", "inherit"] });
const handle = "settled-fault-operation";
const startId = "settled-fault-start";
const awaitId = "settled-fault-await";
const awaiting = [];
let outcome;
let token;
let phase;
const reply = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`);
const resolveAwaiters = () => {
  if (outcome === undefined) {
    return;
  }
  for (const id of awaiting.splice(0)) {
    reply({ jsonrpc: "2.0", id, ...outcome });
  }
};
createInterface({ input: process.stdin }).on("line", (line) => {
  const frame = JSON.parse(line);
  if (frame.method === "armFault") {
    token = "settled-fault-token";
    phase = frame.params.point;
    reply({ jsonrpc: "2.0", id: frame.id, result: { token } });
    return;
  }
  if (frame.method === "startOperation") {
    reply({
      jsonrpc: "2.0",
      id: frame.id,
      result: { operationHandle: handle },
    });
    reply({
      jsonrpc: "2.0",
      method: "faultReached",
      params: {
        token,
        phase,
        processEpoch: Number(process.env.TUVREN_CONFORMANCE_PROCESS_EPOCH),
      },
    });
    child.stdin.write(`${JSON.stringify({ ...frame, id: startId })}\n`);
    return;
  }
  if (
    frame.method === "awaitOperation" &&
    frame.params.operationHandle === handle
  ) {
    awaiting.push(frame.id);
    resolveAwaiters();
    return;
  }
  child.stdin.write(`${line}\n`);
});
createInterface({ input: child.stdout }).on("line", (line) => {
  const frame = JSON.parse(line);
  if (frame.id === startId) {
    if (frame.error !== undefined) {
      outcome = { error: frame.error };
      resolveAwaiters();
      return;
    }
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: awaitId, method: "awaitOperation", params: { operationHandle: frame.result.operationHandle } })}\n`
    );
    return;
  }
  if (frame.id === awaitId) {
    outcome =
      frame.error === undefined
        ? { result: frame.result }
        : { error: frame.error };
    resolveAwaiters();
    return;
  }
  process.stdout.write(`${line}\n`);
});
child.on("exit", (code) => process.exit(code ?? 1));
