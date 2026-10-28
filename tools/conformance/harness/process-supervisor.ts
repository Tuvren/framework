import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import path from "node:path";

import { JsonRpcAdapterClient } from "./adapter-client.js";
import type {
  AdapterExit,
  AdapterFrame,
  AdapterTranscriptMark,
} from "./adapter-client.js";

export interface SupervisedProcess {
  executableDigest: string;
  pid: number;
  epoch: number;
  signal?: string;
  exit?: AdapterExit;
}

interface SupervisorOptions {
  executable: string;
  args: readonly string[];
  cwd: string;
  packetId: string;
  planVersion: string;
}

export class ProcessSupervisor {
  readonly history: SupervisedProcess[] = [];
  private active?: JsonRpcAdapterClient;
  private readonly options: SupervisorOptions;
  private readonly executableDigest: string;
  private readonly startedAt = performance.now();
  private readonly transcripts: {
    client: JsonRpcAdapterClient;
    mark: AdapterTranscriptMark;
  }[] = [];
  private constructor(options: SupervisorOptions, executableDigest: string) {
    this.options = options;
    this.executableDigest = executableDigest;
  }

  static async start(options: SupervisorOptions): Promise<ProcessSupervisor> {
    const executable = path.resolve(options.cwd, options.executable);
    await access(executable, constants.X_OK);
    const bytes = await readFile(executable);
    const digest = createHash("sha256").update(bytes).digest("hex");
    const supervisor = new ProcessSupervisor(
      { ...options, executable },
      digest
    );
    await supervisor.respawn();
    return supervisor;
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
    this.current.exit = await client.terminate("SIGKILL");
    await client.shutdown();
    this.active = undefined;
    if (this.current.exit.signal !== "SIGKILL") {
      throw new Error("adapter did not exit from SIGKILL");
    }
    this.current.signal = "SIGKILL";
  }

  async respawn(): Promise<void> {
    if (this.active !== undefined) {
      throw new Error("cannot respawn a running adapter");
    }
    const client = new JsonRpcAdapterClient({
      command: [this.options.executable, ...this.options.args],
      cwd: this.options.cwd,
      env: {
        ...process.env,
        TUVREN_CONFORMANCE_PROCESS_EPOCH: String(this.history.length + 1),
      },
    });
    const pid = client.processId();
    if (pid === undefined) {
      await client.shutdown();
      throw new Error("adapter process did not start");
    }
    this.active = client;
    this.transcripts.push({
      client,
      mark: { ...client.markTranscript(), startedAt: this.startedAt },
    });
    this.history.push({
      executableDigest: this.executableDigest,
      pid,
      epoch: this.history.length + 1,
    });
    try {
      await client.initialize(this.options.packetId, this.options.planVersion);
    } catch (error: unknown) {
      await this.close();
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
    await client.shutdown();
    const exit = await client.terminationStatus();
    if (exit === undefined) {
      throw new Error("adapter process did not exit");
    }
    this.current.exit = exit;
    if (exit.signal !== null) {
      this.current.signal = exit.signal;
    }
    this.active = undefined;
  }
}
