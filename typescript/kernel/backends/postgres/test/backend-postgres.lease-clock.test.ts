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

// KRT-BG002 — backend-authoritative lease clock (ADR-050, kernel spec §5.2).
// These tests prove that for the shared multi-worker PostgreSQL backend the run
// lease is stamped and judged against the backend's own clock, not the execution
// owner's wall clock. Skew is simulated deterministically by injecting one clock
// into the backend (the authoritative shared clock) and a different clock into
// the kernel (the worker's wall clock).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { RuntimeBackend, TurnTreeSchema } from "@tuvren/kernel-protocol";
import { createRuntimeKernel } from "@tuvren/kernel-runtime";
import { createPostgresBackend } from "../src/index.js";
import {
  assertDevenvPostgresReady,
  cleanupAllocatedSchemas,
  createPostgresTestBackendOptions,
} from "./postgres-test-helpers.js";

const TEST_SCHEMA = {
  incorporationRules: [{ objectType: "message", targetPath: "messages" }],
  paths: [
    { collection: "ordered", path: "messages" },
    { collection: "single", path: "context.manifest" },
  ],
  schemaId: "schema_postgres_lease_clock",
} satisfies TurnTreeSchema;

interface ClosablePostgresBackend extends RuntimeBackend {
  destroy(options?: { dropSchema?: boolean }): Promise<void>;
}

// Worker A's wall clock is deliberately far behind the backend clock so that any
// owner-time stamping or comparison would produce an obviously wrong absolute
// value (around 50) instead of the backend-time value (around 1050).
const WORKER_CLOCK_MS = 0;

interface LeaseClockFixture {
  backend: ClosablePostgresBackend;
  branchId: string;
  kernel: ReturnType<typeof createRuntimeKernel>;
  rootTurnNodeHash: string;
  schemaId: string;
  setBackendNow(value: number): void;
  turnId: string;
}

async function createLeaseClockFixture(
  initialBackendNowMs: number
): Promise<LeaseClockFixture> {
  let backendNowMs = initialBackendNowMs;
  const backend = createPostgresBackend(
    createPostgresTestBackendOptions({ now: () => backendNowMs })
  ) as ClosablePostgresBackend;
  // The worker (kernel) wall clock is fixed and far behind the backend clock.
  const kernel = createRuntimeKernel({ backend, now: () => WORKER_CLOCK_MS });
  const schemaId = await kernel.schema.register(TEST_SCHEMA);
  const thread = await kernel.thread.create(
    "thread_lease_clock",
    schemaId,
    "branch_lease_clock"
  );
  const turn = await kernel.turn.create(
    "turn_lease_clock",
    thread.threadId,
    thread.branchId,
    null,
    thread.rootTurnNodeHash
  );

  return {
    backend,
    branchId: thread.branchId,
    kernel,
    rootTurnNodeHash: thread.rootTurnNodeHash,
    schemaId,
    setBackendNow: (value: number) => {
      backendNowMs = value;
    },
    turnId: turn.turnId,
  };
}

function createLeasedRun(
  fixture: LeaseClockFixture,
  ownerSuppliedExpiryMs: number,
  runId = "run_lease_clock"
) {
  return fixture.kernel.runLiveness.createLeasedRun({
    branchId: fixture.branchId,
    executionOwnerId: "owner-alpha",
    leaseExpiresAtMs: ownerSuppliedExpiryMs,
    runId,
    schemaId: fixture.schemaId,
    startTurnNodeHash: fixture.rootTurnNodeHash,
    steps: [{ deterministic: false, id: "iterate", sideEffects: true }],
    turnId: fixture.turnId,
  });
}

beforeAll(async () => {
  await assertDevenvPostgresReady();
});

afterAll(async () => {
  await cleanupAllocatedSchemas();
});

describe("createPostgresBackend backend-authoritative lease clock", () => {
  test("advertises shared-lease-clock support", async () => {
    const backend = createPostgresBackend(
      createPostgresTestBackendOptions()
    ) as ClosablePostgresBackend;

    try {
      expect(backend.capabilities()["shared-lease-clock"]).toBe(true);
    } finally {
      await backend.destroy({ dropSchema: true });
    }
  });

  test("exposes the real PostgreSQL server clock when no clock is injected", async () => {
    // The skew tests below inject a deterministic backend clock. This test
    // covers the production path instead: with no injected clock the backend
    // must read the actual server time via clock_timestamp() once per
    // transaction. The DB server and the test runner share a host, so the
    // captured value must sit within the wall-clock window bracketing the
    // transaction (with a generous tolerance for any host skew).
    const backend = createPostgresBackend(
      createPostgresTestBackendOptions()
    ) as ClosablePostgresBackend;

    try {
      const beforeMs = Date.now();
      const backendNowMs = await backend.transact(async (tx) => tx.now?.());
      const afterMs = Date.now();

      expect(backendNowMs).toBeDefined();
      if (backendNowMs === undefined) {
        throw new Error("postgres backend did not expose a transaction clock");
      }
      expect(Number.isSafeInteger(backendNowMs)).toBe(true);

      const toleranceMs = 5000;
      expect(backendNowMs).toBeGreaterThanOrEqual(beforeMs - toleranceMs);
      expect(backendNowMs).toBeLessThanOrEqual(afterMs + toleranceMs);
    } finally {
      await backend.destroy({ dropSchema: true });
    }
  });

  test("stamps lease expiry in backend time, re-based from the owner duration", async () => {
    const fixture = await createLeaseClockFixture(1000);

    try {
      // Worker A (clock = 0) intends a 50ms lease; the kernel re-bases it onto
      // the backend clock: 1000 + (50 - 0) = 1050.
      const run = await createLeasedRun(fixture, 50);
      expect(run.leaseExpiresAtMs).toBe(1050);
    } finally {
      await fixture.backend.destroy({ dropSchema: true });
    }
  });

  test("listExpired judges expiry against the backend clock, ignoring the caller clock", async () => {
    const fixture = await createLeaseClockFixture(1000);

    try {
      const run = await createLeasedRun(fixture, 50); // backend expiry 1050

      // Backend clock still before expiry: a far-future caller clock must NOT
      // force the lease to be listed as expired.
      fixture.setBackendNow(1049);
      expect(await fixture.kernel.runLiveness.listExpired(10_000_000)).toEqual(
        []
      );

      // Backend clock past expiry: a caller clock that thinks no time has passed
      // must NOT prevent the lease from being listed as expired.
      fixture.setBackendNow(1051);
      const expired = await fixture.kernel.runLiveness.listExpired(0);
      expect(expired.map((candidate) => candidate.runId)).toEqual([run.runId]);
    } finally {
      await fixture.backend.destroy({ dropSchema: true });
    }
  });

  test("renewLease re-bases the next expiry and rejects renewal once expired in backend time", async () => {
    const fixture = await createLeaseClockFixture(1000);

    try {
      const run = await createLeasedRun(fixture, 50); // backend expiry 1050

      // Renew while still valid in backend time (1010 < 1050). Worker A again
      // supplies an owner-time absolute (60); the kernel re-bases onto backend
      // time: 1010 + (60 - 0) = 1070.
      fixture.setBackendNow(1010);
      const renewed = await fixture.kernel.runLiveness.renewLease(
        run.runId,
        "owner-alpha",
        run.fencingToken ?? "",
        60
      );
      expect(renewed.leaseExpiresAtMs).toBe(1070);

      // Backend clock advances past the renewed expiry. Even though Worker A's
      // wall clock still reads 0, renewal must fail because the backend clock is
      // authoritative.
      fixture.setBackendNow(1071);
      await expect(
        fixture.kernel.runLiveness.renewLease(
          run.runId,
          "owner-alpha",
          renewed.fencingToken,
          100
        )
      ).rejects.toThrow("lease has expired");
    } finally {
      await fixture.backend.destroy({ dropSchema: true });
    }
  });

  test("preemptExpired judges expiry against the backend clock, not the caller clock", async () => {
    const fixture = await createLeaseClockFixture(1000);

    try {
      const run = await createLeasedRun(fixture, 50); // backend expiry 1050

      // A preempting worker whose clock is far ahead (caller nowMs huge) must
      // not be able to preempt while the backend clock says the lease is valid.
      fixture.setBackendNow(1049);
      await expect(
        fixture.kernel.runLiveness.preemptExpired(
          run.runId,
          "owner-beta",
          9_999_999,
          "stale_running_recovery"
        )
      ).rejects.toThrow("lease has not expired");

      // Once the backend clock is past expiry the preemption succeeds even
      // though the caller clock reads 0.
      fixture.setBackendNow(1051);
      const recovery = await fixture.kernel.runLiveness.preemptExpired(
        run.runId,
        "owner-beta",
        0,
        "stale_running_recovery"
      );
      // Preemption checkpoints the stale-running event, so recovery advances the
      // branch head; the run is durably failed with the recorded reason.
      expect(recovery.lastTurnNodeHash).not.toBe(fixture.rootTurnNodeHash);

      const storedRun = await fixture.backend.transact((tx) =>
        tx.runs.get(run.runId)
      );
      expect(storedRun?.status).toBe("failed");
      expect(storedRun?.preemptionReason).toBe("stale_running_recovery");
    } finally {
      await fixture.backend.destroy({ dropSchema: true });
    }
  });
});
