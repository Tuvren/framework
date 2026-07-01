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

import type {
  StoredBranch,
  StoredRun,
  StoredStagedResult,
  StoredThread,
  StoredTurn,
  StoredTurnNode,
  StoredTurnTree,
} from "@tuvren/kernel-protocol";
import type Database from "better-sqlite3";
import { selectBranch } from "./sqlite-lookups.js";

interface TrackedRecord<T> {
  after: T | null;
  before: T | null;
}

export class TransactionWriteTracker {
  readonly branchIdsForActiveRunValidation = new Set<string>();
  readonly branchWrites = new Map<string, TrackedRecord<StoredBranch>>();
  readonly runIds = new Set<string>();
  readonly stagedResultRunIds = new Set<string>();
  readonly threadIds = new Set<string>();
  readonly turnIds = new Set<string>();
  readonly turnIdsForDependentValidation = new Set<string>();
  readonly turnNodeHashes = new Set<string>();
  readonly turnTreeHashes = new Set<string>();

  captureBranchBaseline(
    db: Database.Database,
    branchId: string
  ): StoredBranch | null {
    const existing = this.branchWrites.get(branchId);

    if (existing !== undefined) {
      return existing.before === null
        ? null
        : cloneStoredBranch(existing.before);
    }

    const before = selectBranch(db, branchId);
    this.branchWrites.set(branchId, {
      after: before === null ? null : cloneStoredBranch(before),
      before: before === null ? null : cloneStoredBranch(before),
    });

    return before === null ? null : cloneStoredBranch(before);
  }

  recordBranchSet(before: StoredBranch | null, after: StoredBranch): void {
    const existing = this.branchWrites.get(after.branchId);
    this.branchWrites.set(after.branchId, {
      after: cloneStoredBranch(after),
      before:
        existing?.before ??
        (before === null ? null : cloneStoredBranch(before)),
    });
    this.branchIdsForActiveRunValidation.add(after.branchId);

    if (after.archivedFromBranchId !== undefined) {
      this.branchIdsForActiveRunValidation.add(after.archivedFromBranchId);
    }
  }

  recordRunSet(before: StoredRun | null, after: StoredRun): void {
    this.runIds.add(after.runId);
    this.stagedResultRunIds.add(after.runId);
    this.branchIdsForActiveRunValidation.add(after.branchId);

    if (before !== null) {
      this.branchIdsForActiveRunValidation.add(before.branchId);
    }
  }

  recordStagedResultSet(record: StoredStagedResult): void {
    this.stagedResultRunIds.add(record.runId);
    this.runIds.add(record.runId);
  }

  recordStagedResultClear(runId: string): void {
    this.stagedResultRunIds.add(runId);
    this.runIds.add(runId);
  }

  recordThreadPut(record: StoredThread): void {
    this.threadIds.add(record.threadId);
  }

  recordTurnSet(before: StoredTurn | null, after: StoredTurn): void {
    this.turnIds.add(after.turnId);
    this.branchIdsForActiveRunValidation.add(after.branchId);

    if (before !== null && before.headTurnNodeHash !== after.headTurnNodeHash) {
      this.turnIdsForDependentValidation.add(after.turnId);
    }
  }

  recordTurnNodePut(record: StoredTurnNode): void {
    this.turnNodeHashes.add(record.hash);
  }

  recordTurnTreePathWrite(turnTreeHash: string): void {
    this.turnTreeHashes.add(turnTreeHash);
  }

  recordTurnTreePut(record: StoredTurnTree): void {
    this.turnTreeHashes.add(record.hash);
  }
}

function cloneStoredBranch(record: StoredBranch): StoredBranch {
  return { ...record };
}
