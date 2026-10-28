import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type { AdapterCapabilities } from "../adapter-protocol/index.js";
import { JsonRpcAdapterClient } from "./adapter-client.js";
import type {
  AdapterExit,
  AdapterFrame,
  AdapterTranscriptMark,
} from "./adapter-client.js";
import { CleanupError, withCleanup } from "./storage-resource.js";

export interface SupervisedProcess {
  executableDigest: string;
  pid: number;
  epoch: number;
  signal: string | null;
  exit?: AdapterExit;
}

interface SupervisorOptions {
  executable: string;
  args: readonly string[];
  cwd: string;
  packetId: string;
  planVersion: string;
  validateHandshake?: (capabilities: AdapterCapabilities) => void;
}

export class ProcessStartError extends Error {
  constructor(executable: string, cause: unknown) {
    super(
      `adapter executable cannot be started: ${executable}: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause }
    );
    this.name = "ProcessStartError";
  }
}

interface ProcessEntry {
  pid: number;
  parent: number;
  group: number;
}

const WHITESPACE = /\s+/u;

const processEntries = async (): Promise<ProcessEntry[]> => {
  const { stdout } = await promisify(execFile)("ps", [
    "-eo",
    "pid=,ppid=,pgid=,stat=",
  ]);
  return stdout
    .trim()
    .split("\n")
    .flatMap((line) => {
      const [pid, parent, group, state] = line.trim().split(WHITESPACE);
      if (
        pid === undefined ||
        parent === undefined ||
        group === undefined ||
        state === undefined ||
        state.startsWith("Z")
      ) {
        return [];
      }
      return [
        { pid: Number(pid), parent: Number(parent), group: Number(group) },
      ];
    });
};

export const descendantPids = async (pid: number): Promise<number[]> => {
  const entries = await processEntries();
  const descendants = new Set<number>();
  const parents = [pid];
  for (const parent of parents) {
    for (const entry of entries) {
      if (entry.parent === parent && !descendants.has(entry.pid)) {
        descendants.add(entry.pid);
        parents.push(entry.pid);
      }
    }
  }
  return [...descendants];
};

export class ProcessSupervisor {
  readonly history: SupervisedProcess[] = [];
  private active?: JsonRpcAdapterClient;
  private readonly options: SupervisorOptions;
  private readonly startedAt = performance.now();
  private readonly transcripts: {
    client: JsonRpcAdapterClient;
    mark: AdapterTranscriptMark;
  }[] = [];
  private constructor(options: SupervisorOptions) {
    this.options = options;
  }

  static async start(options: SupervisorOptions): Promise<ProcessSupervisor> {
    const executable = path.resolve(options.cwd, options.executable);
    const supervisor = new ProcessSupervisor({ ...options, executable });
    await supervisor.respawn();
    return supervisor;
  }

  async fork(): Promise<ProcessSupervisor> {
    return await ProcessSupervisor.start(this.options);
  }

  get client(): JsonRpcAdapterClient {
    if (this.active === undefined) {
      throw new Error("adapter process is not running");
    }
    return this.active;
  }

  get current(): SupervisedProcess {
    const current = this.history.at(-1);
    if (current === undefined) {
      throw new Error("adapter process was not started");
    }
    return current;
  }

  async kill(): Promise<void> {
    const client = this.client;
    const pid = this.current.pid;
    const descendants = await descendantPids(pid);
    try {
      await withCleanup(
        async () => {
          this.current.exit = await client.terminate("SIGKILL");
          this.current.signal = this.current.exit.signal;
          await client.shutdown();
        },
        async () => await this.ensureNoSurvivors(client, pid, descendants)
      );
    } finally {
      this.active = undefined;
    }
    if (this.current.exit?.signal !== "SIGKILL") {
      throw new Error("adapter did not exit from SIGKILL");
    }
  }

  private async ensureNoSurvivors(
    client: JsonRpcAdapterClient,
    pid: number,
    descendants: readonly number[]
  ): Promise<void> {
    client.signalProcessGroup("SIGKILL");
    const deadline = performance.now() + 2000;
    let survivors = (await processEntries()).filter(
      (entry) => entry.group === pid || descendants.includes(entry.pid)
    );
    while (survivors.length > 0 && performance.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      survivors = (await processEntries()).filter(
        (entry) => entry.group === pid || descendants.includes(entry.pid)
      );
    }
    if (survivors.length > 0) {
      throw new Error(
        `adapter descendants survived SIGKILL: ${survivors.map((entry) => entry.pid).join(", ")}`
      );
    }
  }

  async respawn(): Promise<void> {
    if (this.active !== undefined) {
      throw new Error("cannot respawn a running adapter");
    }
    let executableDigest: string;
    try {
      await access(this.options.executable, constants.X_OK);
      executableDigest = createHash("sha256")
        .update(await readFile(this.options.executable))
        .digest("hex");
    } catch (error: unknown) {
      throw new ProcessStartError(this.options.executable, error);
    }
    const client = new JsonRpcAdapterClient({
      command: [this.options.executable, ...this.options.args],
      cwd: this.options.cwd,
      processGroup: true,
      env: {
        ...process.env,
        TUVREN_CONFORMANCE_PROCESS_EPOCH: String(this.history.length + 1),
      },
    });
    const pid = client.processId();
    if (pid === undefined) {
      await client.shutdown();
      throw new ProcessStartError(
        this.options.executable,
        new Error("adapter process did not start")
      );
    }
    this.active = client;
    this.transcripts.push({
      client,
      mark: { ...client.markTranscript(), startedAt: this.startedAt },
    });
    this.history.push({
      executableDigest,
      pid,
      epoch: this.history.length + 1,
      signal: null,
    });
    try {
      const capabilities = await client.initialize(
        this.options.packetId,
        this.options.planVersion
      );
      this.options.validateHandshake?.(capabilities);
    } catch (error: unknown) {
      try {
        await this.close();
      } catch (cleanupError: unknown) {
        throw new CleanupError(false, error, cleanupError);
      }
      throw error;
    }
  }

  async restart(): Promise<void> {
    await this.close();
    if (this.current.exit?.code !== 0 || this.current.exit.signal !== null) {
      throw new Error("graceful restart requires a successful adapter exit");
    }
    await this.respawn();
  }

  frames(): AdapterFrame[] {
    return this.transcripts.flatMap(({ client, mark }) =>
      client.framesSince(mark)
    );
  }

  stderr(): string {
    return this.transcripts
      .map(({ client, mark }) => client.stderrSince(mark))
      .join("");
  }

  latestClient(): JsonRpcAdapterClient {
    const latest = this.transcripts.at(-1);
    if (latest === undefined) {
      throw new Error("adapter process was not started");
    }
    return latest.client;
  }

  async close(): Promise<void> {
    if (this.active === undefined) {
      return;
    }
    const client = this.active;
    const pid = this.current.pid;
    const descendants = await descendantPids(pid);
    try {
      await withCleanup(
        async () => {
          await client.shutdown();
          const exit = await client.terminationStatus();
          if (exit === undefined) {
            throw new Error("adapter process did not exit");
          }
          this.current.exit = exit;
          this.current.signal = exit.signal;
        },
        async () => await this.ensureNoSurvivors(client, pid, descendants)
      );
    } finally {
      this.active = undefined;
    }
  }
}
