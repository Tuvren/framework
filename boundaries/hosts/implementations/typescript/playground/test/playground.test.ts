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

import { describe, expect, test } from "bun:test";
import {
  loadPlaygroundConfig,
  runPlaygroundScenario,
} from "@tuvren/playground-host";

describe("playground host scenarios", () => {
  test("loads deterministic default configuration", () => {
    const config = loadPlaygroundConfig({}, []);

    expect(config).toEqual({
      backend: "memory",
      providerMode: "fixture",
      scenario: "streaming",
      sqlitePath: undefined,
    });
  });

  test("runs the streaming scenario through canonical, SSE, and AG-UI outputs", async () => {
    const report = await runPlaygroundScenario({
      backend: "memory",
      providerMode: "fixture",
      scenario: "streaming",
    });

    expect(report.status.phase).toBe("completed");
    expectScenarioChecksPassed(report.checks);
    expect(report.checks.completed).toBe(true);
    expect(report.events.canonicalTypes).toContain("turn.start");
    expect(report.events.sseEvents).toContain("turn.start");
    expect(report.events.aguiTypes.length).toBeGreaterThan(0);
  });

  test("runs approval pause and edited approval resume", async () => {
    const report = await runPlaygroundScenario({
      backend: "memory",
      providerMode: "fixture",
      scenario: "approval",
    });

    expectScenarioChecksPassed(report.checks);
    expect(report.checks.approvalRequested).toBe(true);
    expect(report.checks.approvalResolved).toBe(true);
    expect(report.checks.resumedCompleted).toBe(true);
    expect(report.events.canonicalTypes).toContain("approval.requested");
    expect(report.events.canonicalTypes).toContain("approval.resolved");
  });

  test("runs AI SDK mock provider mode without credentials", async () => {
    const report = await runPlaygroundScenario({
      backend: "memory",
      providerMode: "ai-sdk-mock",
      scenario: "metadata",
    });

    expect(report.status.phase).toBe("completed");
    expectScenarioChecksPassed(report.checks);
    expect(report.providerMode).toBe("ai-sdk-mock");
    expect(report.events.canonicalTypes).toContain("message.done");
  });

  test("runs steering through the host control path", async () => {
    const report = await runPlaygroundScenario({
      backend: "memory",
      providerMode: "fixture",
      scenario: "steering",
    });

    expect(report.status.phase).toBe("completed");
    expectScenarioChecksPassed(report.checks);
    expect(report.events.canonicalTypes).toContain("steering.incorporated");
  });
});

function expectScenarioChecksPassed(
  checks: Record<string, boolean | number | string>
): void {
  for (const [name, value] of Object.entries(checks)) {
    expect(`${name}:${String(value === false)}`).toBe(`${name}:false`);
  }
}
