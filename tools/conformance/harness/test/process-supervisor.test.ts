import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

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
const ZOMBIE_PROCESS = /^\d+ \(.*\) Z /u;

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

test("each epoch has one validated handshake and its own executable digest", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "tuvren-supervisor-"));
  const executable = path.join(directory, "adapter.mjs");
  const source = `#!/usr/bin/env node\nimport { createInterface } from "node:readline"; for await (const line of createInterface({ input: process.stdin })) { ${handshake} process.stdout.write(response); }\n`;
  await writeFile(executable, source);
  await chmod(executable, 0o755);
  let validations = 0;
  const supervisor = await ProcessSupervisor.start({
    executable,
    args: [],
    cwd: process.cwd(),
    packetId: "probe",
    planVersion: "0.1.0",
    validateHandshake: (capabilities) => {
      expect(capabilities.adapterId).toBe("supervisor-probe");
      validations += 1;
    },
  });
  try {
    const digest = supervisor.current.executableDigest;
    await writeFile(executable, `${source}\n// replacement\n`);
    await supervisor.restart();
    expect(supervisor.current.executableDigest).not.toBe(digest);
    expect(validations).toBe(2);
    const initializations = supervisor
      .frames()
      .filter(
        (frame) =>
          frame.direction === "send" &&
          frame.frame.includes('"method":"initialize"')
      );
    expect(initializations).toHaveLength(2);
  } finally {
    await supervisor.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 20_000);

test("restart allows an adapter to finish a slow graceful shutdown", async () => {
  const node = which("node");
  if (node === null) {
    throw new Error("node executable is required");
  }
  const supervisor = await ProcessSupervisor.start({
    executable: node,
    args: [
      "--input-type=module",
      "--eval",
      `import { createInterface } from "node:readline"; setInterval(() => {}, 1000); for await (const line of createInterface({ input: process.stdin })) { ${handshake} process.stdout.write(response); if (request.method === "shutdown") { setTimeout(() => process.exit(0), 2600); } }`,
    ],
    cwd: process.cwd(),
    packetId: "probe",
    planVersion: "0.1.0",
  });
  try {
    await supervisor.restart();
    expect(supervisor.history[0]?.exit).toEqual({ code: 0, signal: null });
  } finally {
    await supervisor.close();
  }
}, 20_000);

test("an invalid handshake is rejected on the first epoch and after restart", async () => {
  const node = which("node");
  if (node === null) {
    throw new Error("node executable is required");
  }
  const options = {
    executable: node,
    args: [
      "--input-type=module",
      "--eval",
      `import { createInterface } from "node:readline"; for await (const line of createInterface({ input: process.stdin })) { ${handshake} process.stdout.write(response); }`,
    ],
    cwd: process.cwd(),
    packetId: "probe",
    planVersion: "0.1.0",
  };
  await expect(
    ProcessSupervisor.start({
      ...options,
      validateHandshake: () => {
        throw new Error("bad handshake");
      },
    })
  ).rejects.toThrow("bad handshake");
  let epoch = 0;
  const supervisor = await ProcessSupervisor.start({
    ...options,
    validateHandshake: () => {
      epoch += 1;
      if (epoch === 2) {
        throw new Error("bad handshake");
      }
    },
  });
  try {
    await expect(supervisor.restart()).rejects.toThrow("bad handshake");
    expect(supervisor.history).toHaveLength(2);
    expect(supervisor.history[1]?.exit).toBeDefined();
  } finally {
    await supervisor.close();
  }
});

test("kill terminates the supervised process group and its children", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "tuvren-supervisor-child-")
  );
  const pidFile = path.join(directory, "child.pid");
  const supervisor = await ProcessSupervisor.start({
    executable: process.execPath,
    args: [
      "--eval",
      `const child = Bun.spawn([process.execPath, "--eval", "setInterval(() => {}, 1000)"], { stdio: ["ignore", "ignore", "ignore"] }); await Bun.write(${JSON.stringify(pidFile)}, String(child.pid)); for await (const line of console) { ${handshake} process.stdout.write(response); }`,
    ],
    cwd: process.cwd(),
    packetId: "probe",
    planVersion: "0.1.0",
  });
  try {
    const childPid = Number(await readFile(pidFile, "utf8"));
    expect(childPid).toBeGreaterThan(0);
    await supervisor.kill();
    const stat = await readFile(`/proc/${childPid}/stat`, "utf8").catch(
      () => ""
    );
    expect(stat === "" || ZOMBIE_PROCESS.test(stat)).toBe(true);
    expect(supervisor.current.exit?.signal).toBe("SIGKILL");
  } finally {
    await supervisor.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);

test.each(["close", "restart"] as const)(
  "%s terminates children after a clean leader exit",
  async (action) => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "tuvren-graceful-child-")
    );
    const pidFile = path.join(directory, "child.pid");
    const node = which("node");
    if (node === null) {
      throw new Error("node executable is required");
    }
    const supervisor = await ProcessSupervisor.start({
      executable: node,
      args: [
        "--input-type=module",
        "--eval",
        `import { spawn } from "node:child_process"; import { writeFileSync } from "node:fs"; import { createInterface } from "node:readline"; const child = spawn(process.execPath, ["--eval", "setInterval(() => {}, 1000)"], { stdio: "ignore" }); child.unref(); writeFileSync(${JSON.stringify(pidFile)}, String(child.pid)); for await (const line of createInterface({ input: process.stdin })) { ${handshake} process.stdout.write(response); if (request.method === "shutdown") process.exit(0); }`,
      ],
      cwd: process.cwd(),
      packetId: "probe",
      planVersion: "0.1.0",
    });
    const childPid = Number(await readFile(pidFile, "utf8"));
    try {
      await supervisor[action]();
      const stat = await readFile(`/proc/${childPid}/stat`, "utf8").catch(
        () => ""
      );
      expect(stat === "" || ZOMBIE_PROCESS.test(stat)).toBe(true);
      expect(supervisor.history[0]?.exit).toEqual({ code: 0, signal: null });
    } finally {
      try {
        process.kill(childPid, "SIGKILL");
      } catch {
        /* Already gone. */
      }
      await supervisor.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
  15_000
);

test("close escalates to SIGKILL when an adapter ignores SIGTERM", async () => {
  const node = which("node");
  if (node === null) {
    throw new Error("node executable is required");
  }
  const supervisor = await ProcessSupervisor.start({
    executable: node,
    args: [
      "--input-type=module",
      "--eval",
      `import { createInterface } from "node:readline"; process.on("SIGTERM", () => {}); setInterval(() => {}, 1000); for await (const line of createInterface({ input: process.stdin })) { ${handshake} process.stdout.write(response); }`,
    ],
    cwd: process.cwd(),
    packetId: "probe",
    planVersion: "0.1.0",
  });
  await supervisor.close();
  expect(supervisor.current.exit?.signal).toBe("SIGKILL");
}, 15_000);

test("kill reports a descendant that escaped the adapter process group", async () => {
  const node = which("node");
  if (node === null) {
    throw new Error("node executable is required");
  }
  const directory = await mkdtemp(path.join(tmpdir(), "tuvren-escaped-child-"));
  const pidFile = path.join(directory, "child.pid");
  let childPid = 0;
  const supervisor = await ProcessSupervisor.start({
    executable: node,
    args: [
      "--input-type=module",
      "--eval",
      `import { spawn } from "node:child_process"; import { writeFileSync } from "node:fs"; import { createInterface } from "node:readline"; const child = spawn(process.execPath, ["--eval", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" }); writeFileSync(${JSON.stringify(pidFile)}, String(child.pid)); for await (const line of createInterface({ input: process.stdin })) { ${handshake} process.stdout.write(response); }`,
    ],
    cwd: process.cwd(),
    packetId: "probe",
    planVersion: "0.1.0",
  });
  try {
    childPid = Number(await readFile(pidFile, "utf8"));
    expect(childPid).toBeGreaterThan(0);
    await expect(supervisor.kill()).rejects.toThrow(
      "descendants survived SIGKILL"
    );
  } finally {
    if (childPid > 0) {
      try {
        process.kill(childPid, "SIGKILL");
      } catch {
        /* Already gone. */
      }
    }
    await supervisor.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);

test.each(["close", "restart"] as const)(
  "%s rejects a descendant that escaped the adapter process group",
  async (action) => {
    const node = which("node");
    if (node === null) {
      throw new Error("node executable is required");
    }
    const directory = await mkdtemp(
      path.join(tmpdir(), "tuvren-escaped-graceful-")
    );
    const pidFile = path.join(directory, "child.pid");
    const supervisor = await ProcessSupervisor.start({
      executable: node,
      args: [
        "--input-type=module",
        "--eval",
        `import { spawn } from "node:child_process"; import { writeFileSync } from "node:fs"; import { createInterface } from "node:readline"; const child = spawn(process.execPath, ["--eval", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" }); child.unref(); writeFileSync(${JSON.stringify(pidFile)}, String(child.pid)); for await (const line of createInterface({ input: process.stdin })) { ${handshake} process.stdout.write(response); if (request.method === "shutdown") process.exit(0); }`,
      ],
      cwd: process.cwd(),
      packetId: "probe",
      planVersion: "0.1.0",
    });
    const childPid = Number(await readFile(pidFile, "utf8"));
    try {
      await expect(supervisor[action]()).rejects.toThrow(
        "descendants survived SIGKILL"
      );
      expect(supervisor.history).toHaveLength(1);
    } finally {
      try {
        process.kill(childPid, "SIGKILL");
      } catch {
        /* Already gone. */
      }
      await supervisor.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
  15_000
);

test("missing and non-executable adapters produce clear environment errors", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "tuvren-supervisor-mode-")
  );
  const executable = path.join(directory, "adapter");
  try {
    const options = {
      executable,
      args: [],
      cwd: process.cwd(),
      packetId: "probe",
      planVersion: "0.1.0",
    };
    await expect(ProcessSupervisor.start(options)).rejects.toThrow(
      "adapter executable"
    );
    await writeFile(executable, "not executable");
    await chmod(executable, 0o644);
    await expect(ProcessSupervisor.start(options)).rejects.toThrow(
      "adapter executable"
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
