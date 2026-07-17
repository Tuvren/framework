// Copyright 2026 Oscar Yáñez Cisterna (@SkrOYC)
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

/// The M3 run-liveness capability (`kernel.run-liveness`): run execution
/// leases as described by `docs/KrakenKernelSpecification.md` §5.2 Run
/// Execution Leases (ADR-050), mirroring `go/kernel/lease.go`. The
/// backend-authoritative clock requirement means every timestamp here
/// comes from `Kernel.clock` (the same clock the backend was constructed
/// with), never from wall-clock time directly -- this is what lets a
/// deterministic test clock ([ManualClock]) drive exact expiry arithmetic.
///
/// A `part of` `kernel_runtime.dart` (see that file's library doc comment
/// for why this is an `extension` rather than a continuation of
/// [Kernel]'s class body).
part of 'kernel_runtime.dart';

/// Run-liveness lease operations, declared as an extension on [Kernel] so
/// this file can share `kernel_runtime.dart`'s private
/// `_leaseTokenOrdinal` counter and `_checkpointRun` helper.
extension KernelLeaseOps on Kernel {
  /// Grants [runId]'s execution lease to [ownerId] for [ttlMs]
  /// milliseconds from the current backend-authoritative clock reading.
  /// [runId] must exist and be status "running" ([errRunNotActive]
  /// otherwise) -- a completed, failed, or paused run must never end up
  /// leased, since that would bypass [renewLease]'s entire guard ladder
  /// for a run nothing will ever resume. Any prior lease state on a
  /// running run is overwritten. Returns `(token, expiresAtMs)`.
  (String, int) acquireLease(String runId, String ownerId, int ttlMs) {
    final run = backend.getRun(runId);
    if (run == null) {
      throw KernelException(_errRunNotFound, 'run "$runId" not found');
    }
    if (run.status != RunStatus.running) {
      throw KernelException(
        errRunNotActive,
        'run "$runId"\'s lease cannot be acquired (status: ${run.status.name})',
      );
    }

    final now = clock.nowMs();
    _leaseTokenOrdinal++;
    final token = 'lease_${runId}_$_leaseTokenOrdinal';
    final expiresAtMs = now + ttlMs;

    run.hasLease = true;
    run.leaseOwnerId = ownerId;
    run.leaseToken = token;
    run.leaseExpiresAtMs = expiresAtMs;
    backend.updateRun(run);

    return (token, expiresAtMs);
  }

  /// Extends [runId]'s execution lease by [ttlMs] milliseconds from the
  /// current backend-authoritative clock reading, provided the run is
  /// still "running", its lease has not already expired, and [ownerId]
  /// and [token] both match the lease currently on record. Guard ladder,
  /// in order: lease presence ([errRunLeaseNotHeld]), run status
  /// ([errRunNotActive]), lease expiry ([errRunLeaseExpired]), owner
  /// ([errRunLeaseOwnerMismatch]), then token ([errRunLeaseTokenMismatch]).
  /// This port does not implement renewal token rotation: the
  /// caller-supplied token stays valid for the next renewal. Returns the
  /// lease's new absolute expiry (epoch ms).
  int renewLease(String runId, String ownerId, String token, int ttlMs) {
    final run = backend.getRun(runId);
    if (run == null) {
      throw KernelException(_errRunNotFound, 'run "$runId" not found');
    }
    if (!run.hasLease) {
      throw KernelException(
        errRunLeaseNotHeld,
        'run "$runId" does not currently hold a lease',
      );
    }
    if (run.status != RunStatus.running) {
      throw KernelException(
        errRunNotActive,
        'run "$runId"\'s lease cannot be renewed (status: ${run.status.name})',
      );
    }

    final now = clock.nowMs();
    if (run.leaseExpiresAtMs <= now) {
      throw KernelException(
        errRunLeaseExpired,
        'run "$runId"\'s lease expired at ${run.leaseExpiresAtMs} (now $now)',
      );
    }
    if (run.leaseOwnerId != ownerId) {
      throw KernelException(
        errRunLeaseOwnerMismatch,
        'run "$runId"\'s lease is owned by "${run.leaseOwnerId}", not "$ownerId"',
      );
    }
    if (run.leaseToken != token) {
      throw KernelException(
        errRunLeaseTokenMismatch,
        'run "$runId"\'s lease token does not match',
      );
    }

    final renewedExpiresAtMs = now + ttlMs;
    run.leaseExpiresAtMs = renewedExpiresAtMs;
    backend.updateRun(run);

    return renewedExpiresAtMs;
  }

  /// Marks [runId] paused. Paused runs are excluded from
  /// [listExpiredRuns] and from stale preemption regardless of their
  /// lease state (kernel spec §5.2: only a "running" run can go stale).
  /// Only a "running" run can be paused ([errRunNotActive] otherwise).
  void pauseRun(String runId) {
    final run = backend.getRun(runId);
    if (run == null) {
      throw KernelException(_errRunNotFound, 'run "$runId" not found');
    }
    if (run.status != RunStatus.running) {
      throw KernelException(
        errRunNotActive,
        'run "$runId" cannot be paused (status: ${run.status.name})',
      );
    }
    run.status = RunStatus.paused;
    backend.updateRun(run);
  }

  /// Returns the sorted run ids of every run whose status is "running",
  /// that holds a lease, and whose lease `expiresAtMs` is at or before
  /// [nowMs]. A "paused" run is never listed here even if its lease (if
  /// it still has one on record) has expired.
  List<String> listExpiredRuns(int nowMs) {
    final expired = <String>[];
    for (final run in backend.listRuns()) {
      if (run.status != RunStatus.running) continue;
      if (!run.hasLease) continue;
      if (run.leaseExpiresAtMs > nowMs) continue;
      expired.add(run.runId);
    }
    expired.sort();
    return expired;
  }

  /// Fails [runId] as a stale-recovery preemption (kernel spec §5.2
  /// Preemption step 4): [runId] must be status "running" with a lease
  /// that has expired at or before [nowMs] ([errRunNotPreemptable]
  /// otherwise).
  ///
  /// On success: any staged-but-uncommitted results are reactively
  /// checkpointed onto the run's active lineage exactly as a normal
  /// terminal completion would -- a fresh preemption event object is
  /// minted and pinned as the checkpoint's `eventHash`, the staged
  /// results are incorporated into a new turn tree per the run's schema,
  /// a new turn node consuming them is chained onto the run's active turn
  /// node, and the run's branch head advances to it. Only once that
  /// checkpoint has durably committed does status become "failed",
  /// `preemptionReason` become `"stale_running_recovery"`, and the lease
  /// clear entirely.
  void preemptStaleRun(String runId, int nowMs) {
    final run = backend.getRun(runId);
    if (run == null) {
      throw KernelException(_errRunNotFound, 'run "$runId" not found');
    }
    if (run.status != RunStatus.running ||
        !run.hasLease ||
        run.leaseExpiresAtMs > nowMs) {
      throw KernelException(
        errRunNotPreemptable,
        'run "$runId" is not a stale running run as of $nowMs',
      );
    }

    final staged = backend.drainStagedResults(runId);

    final eventBytes = encodeCanonical(_preemptionEventRecord(runId));
    final eventHash =
        backend.putObject(_preemptionEventMediaType, eventBytes).hash;

    var current = run;
    try {
      // _checkpointRun is Kernel's private instance method; calling it
      // with an implicit receiver here resolves to `this` (the Kernel
      // this extension is invoked on) because `lease.dart` is a `part of`
      // `kernel_runtime.dart` -- extension method bodies can reach the
      // extended type's private members exactly as a class method could,
      // as long as both live in the same library.
      final (_, updatedRun) = _checkpointRun(
        current,
        eventHash,
        '',
        staged,
        PendingCheckpointKind.preempt,
      );
      current = updatedRun;
    } on _CheckpointFault catch (fault) {
      if (fault.hash.isEmpty) {
        for (final result in staged) {
          backend.stageResult(runId, result);
        }
      }
      throw fault.cause;
    }

    current.status = RunStatus.failed;
    current.preemptionReason = 'stale_running_recovery';
    current.hasLease = false;
    current.leaseOwnerId = '';
    current.leaseToken = '';
    current.leaseExpiresAtMs = 0;
    backend.updateRun(current);
  }
}

const String _preemptionEventMediaType = 'application/cbor';

/// Builds the canonical-record encoding of a stale-run preemption's
/// reactive-checkpoint event: `{runId, type}`.
RecordMap _preemptionEventRecord(String runId) => RecordMap({
  'runId': RecordText(runId),
  'type': const RecordText('kernel_runtime_run_preempted'),
});
