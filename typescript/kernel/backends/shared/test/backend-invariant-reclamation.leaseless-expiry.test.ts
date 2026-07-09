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
  type BackendInvariantReclamationDeps,
  type BackendState,
  isExpiredLeaselessRunningRun,
  LEASELESS_RUN_EXPIRY_MS,
  reclaimBackendState,
} from "@tuvren/backend-shared";
import type {
  StoredObject,
  StoredRun,
  StoredTurn,
  StoredTurnNode,
} from "@tuvren/kernel-protocol";

// KRT-BK002: the shared reclamation core's leaseless-run expiry rule. A
// leaseless running run (no executionOwnerId/fencingToken/leaseExpiresAtMs)
// whose updatedAtMs has gone quiet for at least LEASELESS_RUN_EXPIRY_MS is
// excluded from pinning `computeGraceHorizonMs`'s min(createdAtMs) — so a
// crashed leaseless run's owner no longer blocks reclamation of state created
// after it forever. The run's own reachable lineage stays fully protected
// regardless (seedActiveRunRoots keys only on isActiveRun(status), never on
// expiry), which is what makes this exclusion safe.

const NO_OP_DEPS: BackendInvariantReclamationDeps = {
  decodeHashStringArray: () => [],
  decodeRunCreatedTurnNodeHashes: () => [],
  decodeTurnNodeConsumedStagedResultObjectHashes: () => [],
  resolveStoredTurnTreePathValue: () => null,
};

function makeEmptyState(): BackendState {
  return {
    branches: new Map(),
    objects: new Map(),
    observeAnnotations: new Map(),
    orderedPathChunks: new Map(),
    runs: new Map(),
    schemas: new Map(),
    stagedResults: new Map(),
    threads: new Map(),
    turnNodes: new Map(),
    turns: new Map(),
    turnTreePaths: new Map(),
    turnTrees: new Map(),
  };
}

function makeRun(overrides: Partial<StoredRun> & { runId: string }): StoredRun {
  return {
    branchId: "branch_1",
    createdAtMs: 0,
    createdTurnNodesCbor: new Uint8Array(),
    currentStepIndex: 0,
    schemaId: "schema_1",
    startTurnNodeHash: "hash_start",
    status: "running",
    stepSequenceCbor: new Uint8Array(),
    turnId: "turn_1",
    updatedAtMs: 0,
    ...overrides,
  };
}

function makeObject(
  overrides: Partial<StoredObject> & { hash: string }
): StoredObject {
  return {
    byteLength: 1,
    bytes: new Uint8Array([1]),
    createdAtMs: 0,
    mediaType: "application/octet-stream",
    ...overrides,
  };
}

function makeTurnNode(
  overrides: Partial<StoredTurnNode> & { hash: string }
): StoredTurnNode {
  return {
    consumedStagedResultsCbor: new Uint8Array(),
    createdAtMs: 0,
    eventHash: null,
    previousTurnNodeHash: null,
    schemaId: "schema_1",
    turnTreeHash: "tree_1",
    ...overrides,
  };
}

function makeTurn(
  overrides: Partial<StoredTurn> & { turnId: string }
): StoredTurn {
  return {
    branchId: "branch_1",
    createdAtMs: 0,
    headTurnNodeHash: "hash_start",
    parentTurnId: null,
    startTurnNodeHash: "hash_start",
    threadId: "thread_1",
    updatedAtMs: 0,
    ...overrides,
  };
}

describe("@tuvren/backend-shared isExpiredLeaselessRunningRun", () => {
  test("running + all lease fields undefined + quiet past the horizon => expired", () => {
    const run = makeRun({ runId: "run_1", updatedAtMs: 0 });
    expect(isExpiredLeaselessRunningRun(run, LEASELESS_RUN_EXPIRY_MS)).toBe(
      true
    );
  });

  test("running + all lease fields undefined + still within the horizon => not expired", () => {
    const run = makeRun({ runId: "run_1", updatedAtMs: 0 });
    expect(isExpiredLeaselessRunningRun(run, LEASELESS_RUN_EXPIRY_MS - 1)).toBe(
      false
    );
  });

  test("running + any one lease field defined => never leaseless-expired, even with old updatedAtMs", () => {
    const withOwner = makeRun({
      executionOwnerId: "owner_1",
      runId: "run_1",
      updatedAtMs: 0,
    });
    const withFencingToken = makeRun({
      fencingToken: "fence_1",
      runId: "run_2",
      updatedAtMs: 0,
    });
    const withLeaseExpiry = makeRun({
      leaseExpiresAtMs: 5,
      runId: "run_3",
      updatedAtMs: 0,
    });

    expect(
      isExpiredLeaselessRunningRun(withOwner, LEASELESS_RUN_EXPIRY_MS * 10)
    ).toBe(false);
    expect(
      isExpiredLeaselessRunningRun(
        withFencingToken,
        LEASELESS_RUN_EXPIRY_MS * 10
      )
    ).toBe(false);
    expect(
      isExpiredLeaselessRunningRun(
        withLeaseExpiry,
        LEASELESS_RUN_EXPIRY_MS * 10
      )
    ).toBe(false);
  });

  test('status "paused" with old updatedAtMs and no lease fields never auto-expires', () => {
    const run = makeRun({
      runId: "run_1",
      status: "paused",
      updatedAtMs: 0,
    });
    expect(
      isExpiredLeaselessRunningRun(run, LEASELESS_RUN_EXPIRY_MS * 10)
    ).toBe(false);
  });

  test('other terminal statuses ("completed"/"failed") never auto-expire via this predicate', () => {
    const completed = makeRun({
      runId: "run_1",
      status: "completed",
      updatedAtMs: 0,
    });
    const failed = makeRun({
      runId: "run_2",
      status: "failed",
      updatedAtMs: 0,
    });
    expect(
      isExpiredLeaselessRunningRun(completed, LEASELESS_RUN_EXPIRY_MS * 10)
    ).toBe(false);
    expect(
      isExpiredLeaselessRunningRun(failed, LEASELESS_RUN_EXPIRY_MS * 10)
    ).toBe(false);
  });

  test("respects a custom leaselessRunExpiryMs override", () => {
    const run = makeRun({ runId: "run_1", updatedAtMs: 0 });
    expect(isExpiredLeaselessRunningRun(run, 500, 1000)).toBe(false);
    expect(isExpiredLeaselessRunningRun(run, 1000, 1000)).toBe(true);
  });
});

describe("@tuvren/backend-shared reclaimBackendState leaseless-run horizon exclusion", () => {
  test("an expired leaseless run is excluded from pinning the grace horizon, releasing a later unreachable object", () => {
    const state = makeEmptyState();
    state.runs.set(
      "run_leaseless",
      makeRun({ createdAtMs: 0, runId: "run_leaseless", updatedAtMs: 0 })
    );
    state.objects.set(
      "obj_orphan",
      makeObject({ createdAtMs: 10, hash: "obj_orphan" })
    );

    const nowMs = LEASELESS_RUN_EXPIRY_MS + 1;
    reclaimBackendState(state, NO_OP_DEPS, nowMs);

    expect(state.objects.has("obj_orphan")).toBe(false);
  });

  test("a not-yet-expired leaseless run still pins the grace horizon, retaining the same-shaped later object", () => {
    const state = makeEmptyState();
    state.runs.set(
      "run_leaseless",
      makeRun({ createdAtMs: 0, runId: "run_leaseless", updatedAtMs: 0 })
    );
    state.objects.set(
      "obj_orphan",
      makeObject({ createdAtMs: 10, hash: "obj_orphan" })
    );

    const nowMs = 1000;
    reclaimBackendState(state, NO_OP_DEPS, nowMs);

    expect(state.objects.has("obj_orphan")).toBe(true);
  });

  test("one expired leaseless run does not affect an unrelated, still-active run created after it", () => {
    const state = makeEmptyState();
    state.runs.set(
      "run_expired_leaseless",
      makeRun({
        createdAtMs: 0,
        runId: "run_expired_leaseless",
        updatedAtMs: 0,
      })
    );
    state.runs.set(
      "run_other_active",
      makeRun({
        createdAtMs: 5000,
        runId: "run_other_active",
        startTurnNodeHash: "hash_start_other",
        turnId: "turn_2",
        updatedAtMs: 5000,
      })
    );
    // Between the expired run's createdAtMs (0) and the other active run's
    // createdAtMs (5000): only releasable once the horizon correctly pins to
    // 5000 rather than collapsing to 0 (the pre-fix behavior, since an
    // unexcluded expired leaseless run at createdAtMs=0 would pin everything
    // with createdAtMs >= 0, i.e. everything).
    state.objects.set(
      "obj_between",
      makeObject({ createdAtMs: 1000, hash: "obj_between" })
    );
    // After the other active run's createdAtMs (5000): must remain retained,
    // proving that run's own protection is unaffected by the first run's
    // expiry.
    state.objects.set(
      "obj_after_other",
      makeObject({ createdAtMs: 6000, hash: "obj_after_other" })
    );

    const nowMs = LEASELESS_RUN_EXPIRY_MS + 1;
    reclaimBackendState(state, NO_OP_DEPS, nowMs);

    expect(state.objects.has("obj_between")).toBe(false);
    expect(state.objects.has("obj_after_other")).toBe(true);
  });

  test("an expired leaseless run's own reachable lineage (start turn node) stays retained even with no other active run", () => {
    const state = makeEmptyState();
    state.runs.set(
      "run_leaseless",
      makeRun({
        createdAtMs: 0,
        runId: "run_leaseless",
        startTurnNodeHash: "hash_start_leaseless",
        updatedAtMs: 0,
      })
    );
    state.turnNodes.set(
      "hash_start_leaseless",
      makeTurnNode({ createdAtMs: 0, hash: "hash_start_leaseless" })
    );
    // The run's turn must itself be retained (its headTurnNodeHash resolves
    // into the keep closure) for sweepRuns to retain the run record — this
    // mirrors a real turn/run pairing rather than testing sweepRuns in
    // isolation.
    state.turns.set(
      "turn_1",
      makeTurn({
        headTurnNodeHash: "hash_start_leaseless",
        startTurnNodeHash: "hash_start_leaseless",
        turnId: "turn_1",
      })
    );

    // No other active run, so excluding this run from pinning collapses the
    // grace horizon to +Infinity — everything unreachable and finite-aged is
    // releasable. The run's own start turn node must still survive via
    // seedActiveRunRoots's independent isActiveRun(status) check.
    const nowMs = LEASELESS_RUN_EXPIRY_MS + 1;
    const summary = reclaimBackendState(state, NO_OP_DEPS, nowMs);

    expect(state.turnNodes.has("hash_start_leaseless")).toBe(true);
    expect(state.runs.has("run_leaseless")).toBe(true);
    expect(summary.releasedRunCount).toBe(0);
  });

  test("a long-lived but still-checkpointing leaseless run (old createdAtMs, recent updatedAtMs) keeps its full grace cushion", () => {
    // Comfortably past the 24h default expiry horizon from t=0, so a run
    // whose updatedAtMs is still 0 at this nowMs genuinely qualifies as
    // expired — only a recent updatedAtMs (nowMs - 1000, below) escapes it.
    const nowMs = LEASELESS_RUN_EXPIRY_MS + 1000;

    const activeState = makeEmptyState();
    activeState.runs.set(
      "run_still_active",
      makeRun({
        createdAtMs: 0,
        runId: "run_still_active",
        updatedAtMs: nowMs - 1000, // recent activity, well under the expiry horizon
      })
    );
    activeState.objects.set(
      "obj_shortly_after_start",
      makeObject({ createdAtMs: 50, hash: "obj_shortly_after_start" })
    );

    reclaimBackendState(activeState, NO_OP_DEPS, nowMs);

    // The run is old (createdAtMs=0) but still active (recent updatedAtMs),
    // so it is NOT excluded: the horizon pins to createdAtMs=0 and the object
    // created shortly after (createdAtMs=50) is retained.
    expect(activeState.objects.has("obj_shortly_after_start")).toBe(true);

    // Contrast: identical shape, but updatedAtMs is ALSO old/expired. Now the
    // run IS excluded, the horizon collapses to +Infinity, and the same
    // object (unreachable, finite-aged) is released.
    const expiredState = makeEmptyState();
    expiredState.runs.set(
      "run_gone_quiet",
      makeRun({
        createdAtMs: 0,
        runId: "run_gone_quiet",
        updatedAtMs: 0,
      })
    );
    expiredState.objects.set(
      "obj_shortly_after_start",
      makeObject({ createdAtMs: 50, hash: "obj_shortly_after_start" })
    );

    reclaimBackendState(expiredState, NO_OP_DEPS, nowMs);

    expect(expiredState.objects.has("obj_shortly_after_start")).toBe(false);
  });
});
