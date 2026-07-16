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

/// The M3 `kernel.run-liveness` and `kernel.restart-recovery` operations,
/// mirroring `go/kernel-conformance-adapter/operations_liveness.go`. Every
/// handler builds its own fresh in-memory [Kernel] per dispatch call (and,
/// where noted, a fresh [Kernel] per fault point within one dispatch call),
/// matching every other operation in this adapter's per-check isolation.
library;

import 'dart:convert';

import 'package:tuvren_kernel/tuvren_kernel.dart';

import '../adapter.dart' show projection;
import 'operations_runtime.dart' show canonicalTurnTreeSchema;
import 'support.dart';

/// Builds a fresh [Kernel] over a fresh [InMemoryBackend] driven by a
/// [ManualClock] pinned at [startMs], so a run-liveness or restart-recovery
/// scenario can advance the backend-authoritative clock to exact instants
/// (kernel spec §5.2 ADR-050) instead of relying on wall-clock or
/// auto-increment timing.
(Kernel, ManualClock) newManualClockRuntimeKernel(int startMs) {
  final clock = ManualClock(startMs);
  final backend = InMemoryBackend(clock);
  return (Kernel('kernel-conformance-adapter', clock, backend), clock);
}

const String onlyStepId = 'only_step';

List<StepDeclaration> singleStepSequence() => const [
  StepDeclaration(id: onlyStepId, deterministic: true, sideEffects: false),
];

// --- kernel.run-liveness.lease-renewal ---

Object? runLeaseRenewal(Object? input) {
  final (k, clock) = newManualClockRuntimeKernel(10);
  k.registerSchema(canonicalTurnTreeSchema());
  final created = k.createThread(
    'thread_lease_renewal',
    'schema_main',
    'branch_lease_renewal',
  );
  k.createRun(
    'run_lease_renewal',
    'turn_lease_renewal',
    'branch_lease_renewal',
    'schema_main',
    created.rootTurnNodeHash,
    singleStepSequence(),
  );

  // Acquire at t=10, ttl=20 -> initial expiry 30.
  final (token, _) = k.acquireLease('run_lease_renewal', 'owner_a', 20);

  // Renew at t=20, ttl=20 -> renewed expiry 40.
  clock.setMs(20);
  final renewedExpiresAtMs = k.renewLease(
    'run_lease_renewal',
    'owner_a',
    token,
    20,
  );

  final ownerMismatchCode = captureCode(() {
    k.renewLease('run_lease_renewal', 'owner_b', token, 20);
  });

  final staleTokenCode = captureCode(() {
    k.renewLease('run_lease_renewal', 'owner_a', 'not-the-real-token', 20);
  });

  return projection({
    'renewal': {
      'renewedLeaseExpiresAtMs': renewedExpiresAtMs,
      'ownerMismatchCode': ownerMismatchCode,
      'staleTokenCode': staleTokenCode,
    },
  });
}

// --- kernel.run-liveness.expired-listing ---

Object? runExpiredListing(Object? input) {
  final (k, clock) = newManualClockRuntimeKernel(0);
  k.registerSchema(canonicalTurnTreeSchema());

  final createdExpired = k.createThread(
    'thread_run_expired',
    'schema_main',
    'branch_run_expired',
  );
  k.createRun(
    'run_expired',
    'turn_run_expired',
    'branch_run_expired',
    'schema_main',
    createdExpired.rootTurnNodeHash,
    singleStepSequence(),
  );
  k.acquireLease('run_expired', 'owner_a', 5);

  final createdPaused = k.createThread(
    'thread_run_paused',
    'schema_main',
    'branch_run_paused',
  );
  k.createRun(
    'run_paused',
    'turn_run_paused',
    'branch_run_paused',
    'schema_main',
    createdPaused.rootTurnNodeHash,
    singleStepSequence(),
  );
  k.acquireLease('run_paused', 'owner_b', 5);
  k.pauseRun('run_paused');

  clock.setMs(100); // both ttl=5 leases acquired at t=0 are long expired

  final expiredRunIds = k.listExpiredRuns(clock.nowMs());

  final pausedRun = k.backend.getRun('run_paused');
  if (pausedRun == null) {
    throw StateError('run_paused not found after listing');
  }
  final pausedRunListed = expiredRunIds.contains('run_paused');

  return projection({
    'listing': {
      'expiredRunIds': expiredRunIds,
      'pausedRunStatus': pausedRun.status.name,
      'pausedRunListed': pausedRunListed,
    },
  });
}

// --- kernel.run-liveness.stale-preemption ---

Object? runStalePreemption(Object? input) {
  final (k, clock) = newManualClockRuntimeKernel(0);
  k.registerSchema(canonicalTurnTreeSchema());
  final created = k.createThread(
    'thread_run_stale',
    'schema_main',
    'branch_run_stale',
  );
  k.createRun(
    'run_stale',
    'turn_run_stale',
    'branch_run_stale',
    'schema_main',
    created.rootTurnNodeHash,
    singleStepSequence(),
  );
  k.acquireLease('run_stale', 'owner_a', 5);

  // Store the staged blob for real so the reactive checkpoint's tree
  // references an object that actually exists.
  final stagedObject = k.backend.putObject(
    'message',
    utf8.encode('staged-before-preemption'),
  );
  k.stageResult(
    'run_stale',
    StagedResult(
      taskId: 'assistant_message',
      objectHash: stagedObject.hash,
      objectType: 'message',
      status: StagedResultStatus.completed,
      timestamp: 0,
    ),
  );

  clock.setMs(100);
  k.preemptStaleRun('run_stale', clock.nowMs());

  final run = k.backend.getRun('run_stale');
  if (run == null) {
    throw StateError('run_stale not found after preemption');
  }
  final branch = k.backend.getBranch('branch_run_stale');
  if (branch == null) {
    throw StateError('branch_run_stale not found after preemption');
  }
  final state = k.recoveryState('run_stale');

  final preservedStagedResultTaskIds = [
    for (final result in state.consumedStagedResults) result.taskId,
  ];

  return projection({
    'preemption': {
      'branchHeadTurnNodeHash': branch.headTurnNodeHash,
      'runStatus': run.status.name,
      'preemptionReason': run.preemptionReason,
      'recoveryLastTurnNodeHash': state.lastTurnNodeHash,
      'recoveryHeadMatchesBranchHead':
          state.lastTurnNodeHash == branch.headTurnNodeHash,
      'uncommittedStagedResults': state.uncommittedStagedResults.length,
      'leaseCleared': !run.hasLease,
      'preservedStagedResultTaskIds': preservedStagedResultTaskIds,
    },
  });
}

// --- crash-recovery fault-point scenario shared by both restart-recovery
// operations below ---

/// One fully-built two-step run, checkpointed once (`message_1` committed)
/// with a second message (`message_2`) staged but not yet checkpointed --
/// the common baseline every fault-point observation below faults a second,
/// independent copy of.
class _CrashRecoveryFixture {
  _CrashRecoveryFixture({
    required this.k,
    required this.runId,
    required this.branchId,
    required this.message2Hash,
    required this.baseHead,
  });

  final Kernel k;
  final String runId;
  final String branchId;
  final String message2Hash;

  /// Branch head immediately after `message_1`'s checkpoint.
  final String baseHead;
}

_CrashRecoveryFixture _buildCrashRecoveryFixture() {
  final (k, _) = newManualClockRuntimeKernel(0);
  k.registerSchema(canonicalTurnTreeSchema());
  final created = k.createThread(
    'thread_crash_recovery',
    'schema_main',
    'branch_crash_recovery',
  );
  const steps = [
    StepDeclaration(id: 'step_1', deterministic: true, sideEffects: false),
    StepDeclaration(id: 'step_2', deterministic: true, sideEffects: false),
  ];
  k.createRun(
    'run_crash_recovery',
    'turn_crash_recovery',
    'branch_crash_recovery',
    'schema_main',
    created.rootTurnNodeHash,
    steps,
  );

  final message1Hash = k.putObject(
    'application/json',
    utf8.encode('message-1'),
  );
  k.stageResult(
    'run_crash_recovery',
    StagedResult(
      taskId: 'task_1',
      objectHash: message1Hash,
      objectType: 'message',
      status: StagedResultStatus.completed,
      timestamp: 0,
    ),
  );
  k.completeStep('run_crash_recovery', 'step_1', '', '');

  final branch = k.backend.getBranch('branch_crash_recovery');
  if (branch == null) {
    throw StateError('branch_crash_recovery not found after checkpoint');
  }

  final message2Hash = k.putObject(
    'application/json',
    utf8.encode('message-2'),
  );
  k.stageResult(
    'run_crash_recovery',
    StagedResult(
      taskId: 'task_2',
      objectHash: message2Hash,
      objectType: 'message',
      status: StagedResultStatus.completed,
      timestamp: 0,
    ),
  );

  return _CrashRecoveryFixture(
    k: k,
    runId: 'run_crash_recovery',
    branchId: 'branch_crash_recovery',
    message2Hash: message2Hash,
    baseHead: branch.headTurnNodeHash,
  );
}

/// Walks [head]'s `previousTurnNodeHash` chain backward, bounded, confirming
/// every hash along the way resolves to a stored turn node (a broken or
/// dangling link would mean the checkpoint commit left a half-written
/// chain).
bool _lineageIsConsistent(Kernel k, String head) {
  var cursor = head;
  for (var depth = 0; depth < 10000; depth++) {
    final node = k.backend.getTurnNode(cursor);
    if (node == null) return false;
    if (node.previousTurnNodeHash.isEmpty) return true;
    cursor = node.previousTurnNodeHash;
  }
  return false;
}

int _messageCountAt(Kernel k, String head) {
  final node = k.backend.getTurnNode(head);
  if (node == null) return 0;
  final tree = k.backend.getTurnTree(node.turnTreeHash);
  if (tree == null) return 0;
  return (tree.manifest['messages']?.ordered ?? const <String>[]).length;
}

bool _messageIsCommittedAt(Kernel k, String head, String messageHash) {
  final node = k.backend.getTurnNode(head);
  if (node == null) return false;
  final tree = k.backend.getTurnTree(node.turnTreeHash);
  if (tree == null) return false;
  final ordered = tree.manifest['messages']?.ordered ?? const <String>[];
  return ordered.contains(messageHash);
}

/// Runs one fresh [_CrashRecoveryFixture]'s second checkpoint (`step_2`,
/// committing `message_2`) through a [FaultInjectingBackend] configured for
/// [point], and reports the atomicity contract's five observable outcomes
/// (`docs/KrakenKernelSpecification.md` §5): whether the branch head lands
/// where recovery expects, whether the turn node chain is unbroken, whether
/// the staged message ended up durably committed, whether recovery state is
/// self-consistent after reconciliation, and how many messages are visible
/// in the committed tree.
Map<String, Object?> _observeFaultPoint(FaultPoint point) {
  final fixture = _buildCrashRecoveryFixture();
  final k = fixture.k;

  final baseBackend = k.backend;
  k.backend = FaultInjectingBackend(
    baseBackend,
    FaultPlan(point: point, policy: FaultPolicy.once),
  );
  Object? stepError;
  try {
    k.completeStep(fixture.runId, 'step_2', '', '');
  } catch (e) {
    stepError = e;
  }
  k.backend = baseBackend;

  // expectedHead is captured independently of whatever the backend reports
  // afterward, so the comparison below is a genuine check
  // (headMatchesExpectedCheckpoint can actually be false if recovery
  // misbehaves) rather than comparing a value against itself.
  final String expectedHead;
  if (point == FaultPoint.beforeCommit) {
    // Nothing durable changed: the branch head must still be exactly where
    // message_1's checkpoint left it -- fixture.baseHead, captured when the
    // fixture was built, before this fault-point attempt ever ran.
    expectedHead = fixture.baseHead;
  } else {
    // mid-commit leaves a durable turn node whose branch head move never
    // happened (a genuine torn checkpoint); after-commit-before-ack fully
    // commits including the head move despite reporting failure. Either
    // way, the durable turn node the torn checkpoint wrote is the true
    // expected outcome (kernel spec §5.5: "TurnNode exists -> checkpoint
    // succeeded"). Read the run's own durably-recorded
    // pendingCheckpointHash as expectedHead *before* reconciling -- that is
    // the pending sibling node hash the torn checkpoint durably wrote,
    // independent of whatever reconcileRun does next.
    final run = k.backend.getRun(fixture.runId);
    if (run == null) {
      throw StateError(
        'run "${fixture.runId}" not found after fault-point "$point" attempt',
      );
    }
    if (run.pendingCheckpointHash.isEmpty) {
      throw StateError(
        'run "${fixture.runId}" has no durably-recorded pending checkpoint '
        'after fault-point "$point" attempt',
      );
    }
    expectedHead = run.pendingCheckpointHash;

    k.reconcileRun(fixture.runId);
  }

  // actualHead is re-read from the backend after the fault attempt (and,
  // for mid-commit/after-commit-before-ack, after reconciliation) -- the
  // genuinely-recovered state, not a value derived from expectedHead
  // itself.
  final branch = k.backend.getBranch(fixture.branchId);
  if (branch == null) {
    throw StateError(
      'branch "${fixture.branchId}" not found after fault-point "$point" attempt',
    );
  }
  final actualHead = branch.headTurnNodeHash;

  var recoveryStateConsistent = false;
  try {
    final state = k.recoveryState(fixture.runId);
    recoveryStateConsistent = state.lastTurnNodeHash == actualHead;
  } catch (_) {
    recoveryStateConsistent = false;
  }

  return {
    'injectedErrorCode': codeOf(stepError),
    'headMatchesExpectedCheckpoint': actualHead == expectedHead,
    'lineageConsistent': _lineageIsConsistent(k, actualHead),
    'pendingMessageCommitted': _messageIsCommittedAt(
      k,
      actualHead,
      fixture.message2Hash,
    ),
    'recoveryStateConsistent': recoveryStateConsistent,
    'visibleCommittedMessageCount': _messageCountAt(k, actualHead),
  };
}

// --- kernel.restart-recovery.crash-recovery-in-process ---

Object? runCrashRecoveryInProcess(Object? input) {
  final beforeCommit = _observeFaultPoint(FaultPoint.beforeCommit);
  final midCommit = _observeFaultPoint(FaultPoint.midCommit);
  final afterCommitBeforeAck = _observeFaultPoint(
    FaultPoint.afterCommitBeforeAck,
  );

  return projection({
    'crashRecovery': {
      'beforeCommit': beforeCommit,
      'midCommit': midCommit,
      'afterCommitBeforeAck': afterCommitBeforeAck,
    },
  });
}

// --- kernel.restart-recovery.concurrent-writer ---

Object? runConcurrentWriter(Object? input) {
  final concurrency = _observeConcurrentWriterCAS();
  final faultPlan = _observeConcurrentWriterFaultPlan();

  return projection({
    'crashRecoveryConcurrency': concurrency,
    'faultPlanConcurrentWriter': faultPlan,
  });
}

/// Races two independent writers' checkpoints from the same base turn node
/// using [Kernel.commitSiblingCheckpoint]'s compare-and-swap: the first
/// commit wins outright, the second is rejected with the typed
/// lateral-conflict error, and a retry rebased onto the winner's head
/// succeeds.
Map<String, Object?> _observeConcurrentWriterCAS() {
  final (k, _) = newManualClockRuntimeKernel(0);
  k.registerSchema(canonicalTurnTreeSchema());
  final created = k.createThread(
    'thread_concurrent_writer',
    'schema_main',
    'branch_concurrent_writer',
  );
  final base = created.rootTurnNodeHash;

  final eventA = k.putObject('application/json', utf8.encode('writer-a'));
  final nodeA = TurnNode(
    hash: '',
    schemaId: 'schema_main',
    turnTreeHash: created.rootTurnTreeHash,
    eventHash: eventA,
  );
  final winnerHash = k.commitSiblingCheckpoint(
    'branch_concurrent_writer',
    base,
    nodeA,
  );

  final eventB = k.putObject('application/json', utf8.encode('writer-b'));
  final nodeB = TurnNode(
    hash: '',
    schemaId: 'schema_main',
    turnTreeHash: created.rootTurnTreeHash,
    eventHash: eventB,
  );
  Object? lossError;
  try {
    k.commitSiblingCheckpoint('branch_concurrent_writer', base, nodeB);
  } catch (e) {
    lossError = e;
  }
  final losingErrorCode = codeOf(lossError);

  // Read the final state produced by the race itself -- winner committed,
  // loser rejected -- before the loser's rebased retry does anything
  // further to the branch head.
  final branchAfterRace = k.backend.getBranch('branch_concurrent_writer');
  if (branchAfterRace == null) {
    throw StateError('branch_concurrent_writer not found after CAS scenario');
  }
  final winnerNode = k.backend.getTurnNode(winnerHash);
  if (winnerNode == null) {
    throw StateError(
      'winner turn node "$winnerHash" not found after CAS scenario',
    );
  }
  final finalHeadMatchesWinner = branchAfterRace.headTurnNodeHash == winnerHash;
  final finalHeadIsCommittedSibling = winnerNode.previousTurnNodeHash == base;

  // The loser retries rebased onto the winner's head, and succeeds. This
  // exercises the rebase path but must not be read back into the
  // race-outcome fields above.
  final nodeBRetry = TurnNode(
    hash: '',
    schemaId: 'schema_main',
    turnTreeHash: created.rootTurnTreeHash,
    eventHash: eventB,
  );
  Object? retryError;
  try {
    k.commitSiblingCheckpoint(
      'branch_concurrent_writer',
      winnerHash,
      nodeBRetry,
    );
  } catch (e) {
    retryError = e;
  }
  final retryAfterLossErrorCode = codeOf(retryError);

  return {
    'singleWriterRejected': lossError != null,
    'finalHeadIsCommittedSibling': finalHeadIsCommittedSibling,
    'finalHeadMatchesWinner': finalHeadMatchesWinner,
    'losingErrorCode': losingErrorCode,
    'retryAfterLossErrorCode': retryAfterLossErrorCode,
    'typedLateralConflictObserved':
        losingErrorCode == errCheckpointLateralConflict,
  };
}

/// Runs a single writer's checkpoint through a "mid-commit"
/// [FaultInjectingBackend]: the writer's durable turn node write lands, but
/// the branch head is deliberately left un-advanced (a genuine torn
/// checkpoint), even though the writer itself observes
/// `kernel_persistence_fault_injected`. Recovery ([Kernel.reconcileRun])
/// then rolls that pending node forward: per kernel spec §5.5 ("TurnNode
/// exists -> checkpoint succeeded"), the durable write is the true outcome,
/// so this operation reconciles before reading back state -- the branch
/// head does end up advanced to a sibling of the pre-attempt head, just via
/// an explicit recovery step rather than silently within the faulted call
/// itself.
Map<String, Object?> _observeConcurrentWriterFaultPlan() {
  final fixture = _buildCrashRecoveryFixture();
  final k = fixture.k;
  final baseHeadBeforeAttempt = fixture.baseHead;

  final baseBackend = k.backend;
  k.backend = FaultInjectingBackend(
    baseBackend,
    const FaultPlan(point: FaultPoint.midCommit, policy: FaultPolicy.once),
  );
  Object? stepError;
  try {
    k.completeStep(fixture.runId, 'step_2', '', '');
  } catch (e) {
    stepError = e;
  }
  k.backend = baseBackend;

  k.reconcileRun(fixture.runId);

  final branch = k.backend.getBranch(fixture.branchId);
  if (branch == null) {
    throw StateError(
      'branch_crash_recovery not found after fault-plan concurrent-writer attempt',
    );
  }
  final writerAdvancedHead = branch.headTurnNodeHash != baseHeadBeforeAttempt;

  var writerProducedSiblingHead = false;
  final node = k.backend.getTurnNode(branch.headTurnNodeHash);
  if (node != null) {
    writerProducedSiblingHead =
        node.previousTurnNodeHash == baseHeadBeforeAttempt;
  }

  return {
    'injectedErrorCode': codeOf(stepError),
    'writerAdvancedHead': writerAdvancedHead,
    'writerProducedSiblingHead': writerProducedSiblingHead,
  };
}
