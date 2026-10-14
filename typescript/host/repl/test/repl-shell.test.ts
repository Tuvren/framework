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

import { expect, test } from "bun:test";

import {
  createReplShell,
  runReplCommand,
  runReplInput,
} from "@tuvren/repl-host";
import type { TuvrenStreamEvent } from "@tuvren/sdk";

test("shell parsing validates scenario and command arguments before active-work conflicts", async () => {
  const shell = createReplShell({
    backend: "memory",
    providerMode: "fixture",
    scenario: "streaming",
  });
  const blank = await runReplCommand(shell, " \t ");
  const missing = await runReplCommand(shell, ".turn start");
  const unsupported = await runReplCommand(shell, ".turn start reload");
  expect(blank).toEqual({});
  expect(missing.output).toContain('Expected ".turn start <scenario|text>"');
  expect(unsupported.output).toBe(
    'Scenario "reload" is not supported through .turn start. Use the scripted scenario runner instead.'
  );
  expect(shell.thread).toBeUndefined();

  await runReplCommand(shell, ".turn start approval");
  await runReplCommand(shell, ".turn await");
  const active = shell.activeTurn;
  if (active === undefined) {
    throw new Error("expected the paused approval turn");
  }
  const unsupportedWhileActive = await runReplCommand(
    shell,
    ".turn start orchestration"
  );
  const missingWhileActive = await runReplCommand(shell, ".turn start");
  const blocked = await runReplCommand(shell, ".turn start streaming");
  const unknown = await runReplCommand(shell, ".unknown");
  expect(unsupportedWhileActive.output).toBe(
    'Scenario "orchestration" is not supported through .turn start. Use .orch commands or the scripted scenario runner instead.'
  );
  expect(missingWhileActive.output).toBe(missing.output);
  expect(blocked.output).toContain("Active work already exists");
  expect(unknown.output).toBe(
    'Unknown command ".unknown". Use .help to inspect the command tree.'
  );
  expect(shell.activeTurn).toBe(active);
  expect(active.handle.status().phase).toBe("paused");
  await runReplCommand(shell, ".turn cancel");
  const cancelled = await active.handle.awaitResult();
  expect(cancelled.status).toBe("completed");
  expect(active.handle.status().phase).toBe("completed");
  const durable = await shell.host.readBranchMessages(active.thread.branchId);
  expect(JSON.stringify(durable)).toContain("rejected");
  expect(JSON.stringify(durable)).toContain('"isError":true');
});

test("invalid backend arguments preserve paused work until a valid backend reset cancels it", async () => {
  const shell = createReplShell({
    backend: "memory",
    providerMode: "fixture",
    scenario: "streaming",
  });
  await runReplCommand(shell, ".turn start approval");
  await runReplCommand(shell, ".turn await");
  const active = shell.activeTurn;
  if (active === undefined) {
    throw new Error("expected the paused approval turn");
  }
  const originalHost = shell.host;
  const originalConfig = shell.config;
  const originalThread = shell.thread;
  const originalProjection = shell.lastProjection;
  const invalid = await runReplCommand(shell, ".backend unknown");
  const missingSqlite = await runReplCommand(shell, ".backend sqlite");
  const missingPostgres = await runReplCommand(shell, ".backend postgres");
  expect(invalid.output).toBe(
    'Expected ".backend <memory|sqlite|postgres> [path|database] [schema|auto]".'
  );
  expect(missingSqlite.output).toBe(
    'SQLite mode requires a path or the literal value "auto".'
  );
  expect(missingPostgres.output).toBe(
    'PostgreSQL mode requires a database name and optionally a schema or the literal value "auto".'
  );
  expect(shell.activeTurn).toBe(active);
  expect(shell.host).toBe(originalHost);
  expect(shell.config).toBe(originalConfig);
  expect(shell.thread).toBe(originalThread);
  expect(shell.lastProjection).toBe(originalProjection);
  expect(active.handle.status().phase).toBe("paused");

  const reset = await runReplCommand(shell, ".backend memory");
  const cancelled = await active.handle.awaitResult();
  expect(reset.output).toBe(
    '{\n  "backend": "memory",\n  "postgresDatabase": null,\n  "postgresSchemaName": null,\n  "sqlitePath": null\n}'
  );
  expect(cancelled.status).toBe("completed");
  expect(active.handle.status().phase).toBe("completed");
  const durable = await originalHost.readBranchMessages(active.thread.branchId);
  expect(JSON.stringify(durable)).toContain("rejected");
  expect(JSON.stringify(durable)).toContain('"isError":true');
  expect(shell.host).not.toBe(originalHost);
  expect(shell.activeTurn).toBeUndefined();
  expect(shell.activeOrchestration).toBeUndefined();
  expect(shell.thread).toBeUndefined();
  expect(shell.lastCanonicalEvents).toBeUndefined();
  expect(shell.lastOrchestrationEvents).toBeUndefined();
  expect(shell.lastProjection).toBeUndefined();
});

test("approval continuation replaces the handle and preserves projection order and durable head", async () => {
  const shell = createReplShell({
    backend: "memory",
    providerMode: "fixture",
    scenario: "streaming",
  });
  await runReplCommand(shell, ".turn start approval");
  await runReplCommand(shell, ".turn await");
  const paused = shell.activeTurn;
  const before = shell.lastProjection;
  if (paused === undefined || before === undefined) {
    throw new Error("expected the paused approval projection");
  }
  const observed: TuvrenStreamEvent[] = [];
  const approved = await runReplCommand(shell, ".turn approve edit", {
    onCanonicalEvent: (event) => {
      observed.push(event);
    },
  });
  const resumed = shell.activeTurn;
  if (resumed === undefined) {
    throw new Error("expected the replacement approval handle");
  }
  expect(approved.output).toContain('"edit"');
  expect(resumed.handle).not.toBe(paused.handle);
  expect(resumed.thread).toBe(paused.thread);
  expect(paused.handle.status().phase).toBe("paused");
  const merged = await resumed.projectionPromise;
  expect(merged.canonical.slice(0, before.canonical.length)).toEqual(
    before.canonical
  );
  expect(merged.agui.slice(0, before.agui.length)).toEqual(before.agui);
  expect(merged.sse.slice(0, before.sse.length)).toEqual(before.sse);
  expect(observed).toEqual(merged.canonical.slice(before.canonical.length));
  const types = merged.canonical.map((event) => event.type);
  const requestedIndex = types.indexOf("approval.requested");
  const resolvedIndex = types.indexOf("approval.resolved");
  const resultIndex = types.lastIndexOf("tool.result");
  const endIndex = types.lastIndexOf("turn.end");
  expect(requestedIndex).toBeGreaterThanOrEqual(0);
  expect(resolvedIndex).toBeGreaterThan(requestedIndex);
  expect(resultIndex).toBeGreaterThan(resolvedIndex);
  expect(endIndex).toBeGreaterThan(resultIndex);

  await runReplCommand(shell, ".turn await");
  expect(shell.activeTurn).toBeUndefined();
  expect(shell.lastProjection).toBe(merged);
  expect(shell.lastCanonicalEvents).toBe(merged.canonical);
  expect(shell.thread?.headTurnNodeHash).not.toBe(
    paused.thread.headTurnNodeHash
  );
  const { thread } = shell;
  if (thread === undefined) {
    throw new Error("expected the completed thread");
  }
  const durable = await shell.host.readBranchMessages(thread.branchId);
  expect(JSON.stringify(durable)).toContain("Edited status update");
  expect(durable.length).toBeGreaterThan(0);
});

test("approval shortcut completes the continuation before the next freeform input", async () => {
  const shell = createReplShell({
    backend: "memory",
    providerMode: "fixture",
    scenario: "streaming",
  });
  await runReplInput(shell, ".turn start approval");
  await runReplInput(shell, ".turn await");
  const approved = await runReplInput(shell, "1");
  const approvedThread = shell.thread;
  expect(approved).toEqual({});
  expect(shell.activeTurn).toBeUndefined();
  const response = await runReplInput(shell, ".env file explanation");
  expect(response).toEqual({});
  expect(shell.thread?.threadId).toBe(approvedThread?.threadId);
  expect(shell.thread?.branchId).toBe(approvedThread?.branchId);
  expect(shell.thread?.headTurnNodeHash).not.toBe(
    approvedThread?.headTurnNodeHash
  );
  const { thread } = shell;
  if (thread === undefined) {
    throw new Error("expected the completed freeform thread");
  }
  const durable = await shell.host.readBranchMessages(thread.branchId);
  expect(JSON.stringify(durable)).toContain(".env file explanation");
});
