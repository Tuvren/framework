import { expect, test } from "bun:test";

import { which } from "bun";

import { ProcessSupervisor } from "../process-supervisor.ts";

const handshake = `
  const request = JSON.parse(line);
  const result = request.method === "initialize" ? {
    adapterId: "supervisor-probe", capabilities: [], packetId: request.params.packetId,
    planVersion: request.params.planVersion
  } : null;
  const response = JSON.stringify({ id: request.id, jsonrpc: "2.0", result }) + "\\n";
`;

test("a graceful restart fails when shutdown requires a signal", async () => {
  const node = which("node");
  if (node === null) {
    throw new Error("node executable is required");
  }
  const supervisor = await ProcessSupervisor.start({
    executable: node,
    args: [
      "--input-type=module",
      "--eval",
      `import { createInterface } from "node:readline"; setInterval(() => {}, 1000); for await (const line of createInterface({ input: process.stdin })) { ${handshake} process.stdout.write(response); }`,
    ],
    cwd: process.cwd(),
    packetId: "probe",
    planVersion: "0.1.0",
  });
  try {
    await expect(supervisor.restart()).rejects.toThrow("graceful restart");
    expect(supervisor.history).toHaveLength(1);
    expect(supervisor.history[0]?.exit?.signal).toBe("SIGTERM");
  } finally {
    await supervisor.close();
  }
}, 15_000);

test("a kill cannot claim an already exited process was killed", async () => {
  const supervisor = await ProcessSupervisor.start({
    executable: process.execPath,
    args: [
      "--eval",
      `for await (const line of console) { ${handshake} process.stdout.write(response, () => process.exit(0)); }`,
    ],
    cwd: process.cwd(),
    packetId: "probe",
    planVersion: "0.1.0",
  });
  try {
    expect(await supervisor.client.terminationStatus()).toEqual({
      code: 0,
      signal: null,
    });
    await expect(supervisor.kill()).rejects.toThrow("SIGKILL");
    expect(supervisor.history[0]?.exit).toEqual({ code: 0, signal: null });
  } finally {
    await supervisor.close();
  }
}, 15_000);
