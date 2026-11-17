import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const [mode, executable, ...args] = process.argv.slice(2);
if (
  (mode !== "fixed" && mode !== "shifted" && mode !== "reopened-shifted") ||
  executable === undefined
) {
  throw new Error("expected a clock mode and adapter command");
}

const adapter = spawn(executable, args, { stdio: ["pipe", "pipe", "inherit"] });
adapter.stdout.pipe(process.stdout);
const lines = createInterface({ input: process.stdin });
let reopened = false;
for await (const line of lines) {
  const frame: unknown = JSON.parse(line);
  if (
    typeof frame === "object" &&
    frame !== null &&
    "method" in frame &&
    frame.method === "openInstance"
  ) {
    reopened = true;
  }
  if (
    (mode !== "reopened-shifted" || reopened) &&
    typeof frame === "object" &&
    frame !== null &&
    "method" in frame &&
    frame.method === "dispatch" &&
    "params" in frame &&
    typeof frame.params === "object" &&
    frame.params !== null &&
    "operation" in frame.params &&
    frame.params.operation === "kernel.clock.set" &&
    "input" in frame.params &&
    typeof frame.params.input === "object" &&
    frame.params.input !== null &&
    "source" in frame.params.input &&
    frame.params.input.source === "server"
  ) {
    Object.assign(frame.params.input, {
      source: "injected",
      nowMs: mode === "fixed" ? 10_000 : Date.now() + 86_400_000,
    });
  }
  adapter.stdin.write(`${JSON.stringify(frame)}\n`);
}
adapter.stdin.end();
await new Promise<void>((resolve) => {
  if (adapter.exitCode === null) {
    adapter.once("exit", () => resolve());
  } else {
    resolve();
  }
});
