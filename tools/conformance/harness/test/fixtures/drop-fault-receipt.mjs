#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const [mode, executable, ...args] = process.argv.slice(2);
if (executable === undefined) {
  throw new Error("missing adapter executable");
}
const child = spawn(executable, args, { stdio: ["pipe", "pipe", "inherit"] });
process.stdin.pipe(child.stdin);
createInterface({ input: child.stdout }).on("line", (line) => {
  const frame = JSON.parse(line);
  if (mode === "early" && typeof frame.result?.token === "string") {
    process.stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "faultReached", params: { token: frame.result.token, phase: "before-commit", processEpoch: Number(process.env.TUVREN_CONFORMANCE_PROCESS_EPOCH) } })}\n`
    );
  }
  if (frame.method !== "faultReached") {
    process.stdout.write(`${line}\n`);
  }
});
child.on("exit", (code) => process.exit(code ?? 1));
