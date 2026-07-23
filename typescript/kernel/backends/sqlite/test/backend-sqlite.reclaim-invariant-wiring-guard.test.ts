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

import { equal, ok } from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, mock, test } from "node:test";
import type { assertReclamationSurvivorInvariants as AssertReclamationSurvivorInvariants } from "../src/lib/sqlite-reclamation-validation.js";

/**
 * Issue #108 M6 review debt: `sqlite-reclamation-validation.test.ts` proves
 * `assertReclamationSurvivorInvariants` rejects the right corruption shapes
 * in isolation, and `backend-sqlite.phase-observer.test.ts` proves
 * `reclaim()` reports a `"validate-reclaim-survivors"` phase around some
 * work -- but neither proves `reclaim()` actually calls the check function
 * itself, as opposed to, say, a future refactor that keeps the
 * phase-timed window but accidentally drops the call inside it (the phase
 * wrapper would keep passing even though the invariant it is supposed to
 * time never runs). This is the same class of gap KRT-BK009 closed for
 * `normalizeBackendError` on the `transact()` rollback path
 * (`backend-sqlite.rollback-normalization-guard.test.ts`): pin the call
 * count through a real call-site, not just an outcome that would look
 * identical whether the call happened or not.
 *
 * Why this is a call-count spy and not an end-to-end corruption-through-
 * `reclaim()` test: an M6-review pass considered engineering a fixture where
 * only `assertReclamationSurvivorInvariants` (not the deferred SQL foreign
 * keys, and not `loadValidatedState`'s own pre-sweep `validateCommittedState`
 * pass) would catch a defect, then driving it through the real `reclaim()`
 * end to end. That turns out not to be constructible without deliberately
 * breaking the sweep itself: `loadValidatedState` already fully validates
 * every FK-uncovered opaque-CBOR reference the targeted check re-verifies
 * (`consumedStagedResultsCbor`, `createdTurnNodesCbor`, turn-tree path
 * values -- see `sqlite-transaction-validation.ts` / `sqlite-state-
 * validation.ts`) *before* the sweep ever runs, so a pre-existing dangling
 * reference is already rejected there and never reaches the post-sweep
 * check. And the sweep's own reachability closure
 * (`backend-invariant-reclamation.ts`'s `closeTurnNodeReachability` /
 * `keepPathObjects`) seeds every one of those same references into its keep
 * set for any record it retains, so a *correct* sweep cannot itself produce
 * a fresh dangling reference for the post-sweep check to catch -- only a
 * defective sweep could, and intentionally breaking the sweep's own
 * reachability algorithm is out of this review debt's scope (its
 * correctness is exactly what the M6 report's enumerated-coverage table
 * argues, and faking a defect there would test a hypothetical bug in a
 * different module, not this wiring). This spy-based call-count guard is
 * the lighter, precedented alternative that proves the wiring directly
 * without fabricating an artificial sweep defect.
 *
 * This spy relies on `node:test`'s `mock.module`, which requires the
 * `--experimental-test-module-mocks` flag (already wired into this
 * package's `test` Nx target for the KRT-BK009 guard) and can only
 * intercept a module specifier that has not already been linked anywhere in
 * this process. Every workspace import in this file is therefore performed
 * with a *dynamic* `import()` inside the test body, after `mock.module` is
 * registered -- never as a static top-level import -- so nothing pre-links
 * `../src/lib/sqlite-reclamation-validation.js` (directly or via
 * `../src/index.js`) ahead of the mock. Do not add a static workspace
 * import to this file without re-verifying the spy still intercepts; it
 * will silently stop working otherwise.
 */
describe("createSqliteBackend reclaim() invariant-check wiring guard (issue #108 M6)", () => {
  test("invokes assertReclamationSurvivorInvariants exactly once per reclaim() call", async () => {
    const reclamationValidationUrl = new URL(
      "../src/lib/sqlite-reclamation-validation.js",
      import.meta.url
    ).href;

    const real = (await import(reclamationValidationUrl)) as {
      assertReclamationSurvivorInvariants: typeof AssertReclamationSurvivorInvariants;
    };

    let callCount = 0;
    const mockContext = mock.module(reclamationValidationUrl, {
      namedExports: {
        assertReclamationSurvivorInvariants: (
          state: Parameters<typeof AssertReclamationSurvivorInvariants>[0]
        ) => {
          callCount += 1;
          return real.assertReclamationSurvivorInvariants(state);
        },
      },
    });

    const tempDirectory = mkdtempSync(
      join(tmpdir(), "backend-sqlite-reclaim-wiring-guard-")
    );

    try {
      const { createSqliteBackend } = (await import(
        "../src/index.js"
      )) as typeof import("../src/index.js");

      const databasePath = join(tempDirectory, "kraken.db");
      const backend = createSqliteBackend({ databasePath });

      try {
        if (backend.reclaim === undefined) {
          throw new Error("expected sqlite backend to implement reclaim()");
        }

        const summary = await backend.reclaim();

        ok(summary !== undefined, "expected reclaim() to resolve a summary");
        equal(
          callCount,
          1,
          `expected assertReclamationSurvivorInvariants to be invoked exactly once by reclaim(), saw ${callCount} calls`
        );

        await backend.reclaim();
        equal(
          callCount,
          2,
          `expected a second reclaim() call to invoke the check again, saw ${callCount} total calls`
        );
      } finally {
        await backend.close();
      }
    } finally {
      mockContext.restore();
      rmSync(tempDirectory, { force: true, recursive: true });
    }
  });
});
