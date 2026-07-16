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

/// The runtime kernel's storage-shaped vocabulary and storage seam,
/// mirroring `go/kernel/runtime.go` (the shared vocabulary: [Clock] lives
/// in `clock.dart`, storage structs and identity-record builders live here)
/// and `go/kernel/backend.go` (the [Backend] interface itself).
///
/// [Backend] is pure content-addressed and keyed storage, with no
/// structural, lineage, or execution semantics of its own. `Kernel`
/// (`kernel_runtime.dart`) is the only caller; it is the layer that
/// enforces schema/tree/thread/branch/run semantics and raises the
/// `kernel_runtime_*` errors. A [Backend] is constructed already bound to
/// one scope; nothing in this interface takes a scope parameter.
library;

import 'clock.dart';
import 'record.dart';
import 'validate.dart';

/// Mirrors the CDDL `run-status` enum. The enum's own [name] is the wire
/// value in every place this port needs one (identity records have no
/// run-status field; only diagnostic/adapter surfaces would ever need the
/// string form, and `.name` already gives the exact lowercase spelling).
enum RunStatus { running, paused, completed, failed }

/// Identifies which checkpoint-minting entry point a run's
/// `pendingCheckpointHash` marker belongs to, so `ReconcileRun`
/// (`kernel_runtime.dart`) knows what "folding the pending node in" must
/// finish as once a torn checkpoint is repaired. `null` on [Run] means "no
/// pending checkpoint" (Go's `""`  sentinel becomes Dart's absent value).
enum PendingCheckpointKind {
  /// The pending checkpoint is an ordinary `completeStep` advance.
  step,

  /// The pending checkpoint is `completeRun`'s reactive checkpoint.
  complete,

  /// The pending checkpoint is `preemptStaleRun`'s reactive checkpoint.
  preempt,
}

/// The in-memory content-addressed object store's stored shape
/// (`spec/kernel/cddl/kernel-records.cddl`'s stored-object, minus the
/// scope/backend-specific columns this port doesn't need yet).
final class StoredObject {
  StoredObject({
    required this.hash,
    required this.mediaType,
    required List<int> bytes,
    required this.createdAtMs,
  }) : bytes = List.unmodifiable(bytes);

  final String hash;
  final String mediaType;
  final List<int> bytes;
  final int createdAtMs;
}

/// The runtime kernel's in-memory turn tree: a schema-bound manifest
/// addressed by its own identity hash.
final class TurnTree {
  TurnTree({
    required this.hash,
    required this.schemaId,
    required Map<String, PathValue> manifest,
    this.createdAtMs = 0,
  }) : manifest = Map.of(manifest);

  final String hash;
  final String schemaId;
  final Map<String, PathValue> manifest;

  /// Backend bookkeeping only (not part of the CDDL turn-tree identity
  /// shape, and excluded from [turnTreeIdentityRecord]): reclamation's
  /// grace window (kernel spec §9.4) needs it to decide whether a turn
  /// tree is new enough to be held regardless of reachability.
  int createdAtMs;

  /// A copy whose [manifest] is independent storage: mutating the clone's
  /// map never affects this instance's, mirroring `go/kernel/memory_backend.go`'s
  /// `cloneTurnTree`.
  TurnTree clone() => TurnTree(
        hash: hash,
        schemaId: schemaId,
        manifest: manifest,
        createdAtMs: createdAtMs,
      );
}

/// The runtime kernel's in-memory turn node. Because a turn node's hash is
/// purely content-addressed (`kernel-records.cddl`'s turn-node carries no
/// threadId field), a genesis (root) turn node must carry something
/// thread-unique in its own identity fields -- see `Kernel.createThread`'s
/// bootstrap-event construction in `kernel_runtime.dart`.
final class TurnNode {
  TurnNode({
    required this.hash,
    required this.schemaId,
    required this.turnTreeHash,
    this.previousTurnNodeHash = '',
    this.eventHash = '',
    List<StagedResult> consumedStagedResults = const [],
    this.createdAtMs = 0,
  }) : consumedStagedResults = List.of(consumedStagedResults);

  final String hash;
  final String schemaId;
  final String turnTreeHash;

  /// `''` means null (root node).
  final String previousTurnNodeHash;

  /// `''` means null.
  final String eventHash;
  final List<StagedResult> consumedStagedResults;

  /// Backend bookkeeping only (not part of the CDDL turn-node identity
  /// shape, and excluded from [turnNodeIdentityRecord]): reclamation's
  /// grace window (kernel spec §9.4) needs it to decide whether a turn
  /// node is new enough to be held regardless of reachability.
  int createdAtMs;

  /// A copy whose [consumedStagedResults] is independent storage, mirroring
  /// `go/kernel/memory_backend.go`'s `cloneTurnNode`.
  TurnNode clone() => TurnNode(
        hash: hash,
        schemaId: schemaId,
        turnTreeHash: turnTreeHash,
        previousTurnNodeHash: previousTurnNodeHash,
        eventHash: eventHash,
        consumedStagedResults: consumedStagedResults,
        createdAtMs: createdAtMs,
      );
}

/// The runtime kernel's in-memory thread record.
final class Thread {
  const Thread({
    required this.threadId,
    required this.schemaId,
    required this.rootTurnNodeHash,
    required this.createdAtMs,
  });

  final String threadId;
  final String schemaId;
  final String rootTurnNodeHash;
  final int createdAtMs;
}

/// The runtime kernel's in-memory branch record.
final class Branch {
  Branch({
    required this.branchId,
    required this.threadId,
    required this.headTurnNodeHash,
    required this.createdAtMs,
    required this.updatedAtMs,
    this.archivedFromBranchId = '',
  });

  final String branchId;
  final String threadId;
  String headTurnNodeHash;
  final int createdAtMs;
  int updatedAtMs;

  /// Non-empty when this branch is an archive branch a backward
  /// `setBranchHead` rollback minted to preserve an abandoned head lineage
  /// (kernel spec §4.2). `''` means this is an ordinary, non-archive
  /// branch.
  final String archivedFromBranchId;

  Branch clone() => Branch(
        branchId: branchId,
        threadId: threadId,
        headTurnNodeHash: headTurnNodeHash,
        createdAtMs: createdAtMs,
        updatedAtMs: updatedAtMs,
        archivedFromBranchId: archivedFromBranchId,
      );
}

/// The runtime kernel's in-memory run record. [threadId] is bookkeeping
/// (resolved from the run's branch at creation time), not a CDDL
/// run-record field.
final class Run {
  Run({
    required this.runId,
    required this.turnId,
    required this.branchId,
    required this.schemaId,
    required this.startTurnNodeHash,
    required this.status,
    this.currentStepIndex = 0,
    List<StepDeclaration> stepSequence = const [],
    List<String> createdTurnNodes = const [],
    this.threadId = '',
    this.pendingCheckpointHash = '',
    this.pendingCheckpointKind,
    this.hasLease = false,
    this.leaseOwnerId = '',
    this.leaseToken = '',
    this.leaseExpiresAtMs = 0,
    this.preemptionReason = '',
    this.createdAtMs = 0,
    this.updatedAtMs = 0,
  })  : stepSequence = List.of(stepSequence),
        createdTurnNodes = List.of(createdTurnNodes);

  final String runId;
  final String turnId;
  final String branchId;
  final String schemaId;
  final String startTurnNodeHash;
  RunStatus status;
  int currentStepIndex;
  final List<StepDeclaration> stepSequence;
  List<String> createdTurnNodes;
  String threadId;

  /// The durable turn node hash a checkpoint commit in progress is about
  /// to (or already did) move the branch head to. `''` means no pending
  /// checkpoint. See `Kernel.checkpointRun`'s doc comment in
  /// `kernel_runtime.dart` for the full torn-checkpoint discipline this
  /// field exists to support.
  String pendingCheckpointHash;

  /// `null` whenever [pendingCheckpointHash] is `''` -- the two fields are
  /// always set and cleared together.
  PendingCheckpointKind? pendingCheckpointKind;

  // --- run execution lease (kernel spec §5.2, ADR-050) ---

  bool hasLease;
  String leaseOwnerId;
  String leaseToken;
  int leaseExpiresAtMs;

  /// Set when a stale-preemption call fails this run
  /// (`kernel.run-liveness.stale-preemption`); `''` otherwise.
  String preemptionReason;

  /// Backend bookkeeping: reclamation's grace horizon (kernel spec §9.4)
  /// is the oldest active (running or paused) run's [createdAtMs], and a
  /// leaseless running run stops pinning that horizon once
  /// `nowMs - updatedAtMs` crosses the 24h admin-expiry window
  /// (ADR-050/ADR-051).
  final int createdAtMs;
  int updatedAtMs;

  /// A copy whose [stepSequence] and [createdTurnNodes] are independent
  /// storage, mirroring `go/kernel/memory_backend.go`'s `cloneRun`.
  Run clone() => Run(
        runId: runId,
        turnId: turnId,
        branchId: branchId,
        schemaId: schemaId,
        startTurnNodeHash: startTurnNodeHash,
        status: status,
        currentStepIndex: currentStepIndex,
        stepSequence: stepSequence,
        createdTurnNodes: createdTurnNodes,
        threadId: threadId,
        pendingCheckpointHash: pendingCheckpointHash,
        pendingCheckpointKind: pendingCheckpointKind,
        hasLease: hasLease,
        leaseOwnerId: leaseOwnerId,
        leaseToken: leaseToken,
        leaseExpiresAtMs: leaseExpiresAtMs,
        preemptionReason: preemptionReason,
        createdAtMs: createdAtMs,
        updatedAtMs: updatedAtMs,
      );
}

/// Mirrors the CDDL `thread-create-result` record.
final class ThreadCreateResult {
  const ThreadCreateResult({
    required this.branchId,
    required this.rootTurnNodeHash,
    required this.rootTurnTreeHash,
    required this.threadId,
  });

  final String branchId;
  final String rootTurnNodeHash;
  final String rootTurnTreeHash;
  final String threadId;
}

/// Mirrors the CDDL `recovery-state` record.
final class RecoveryState {
  const RecoveryState({
    required this.lastTurnNodeHash,
    this.lastCompletedStepId,
    required this.stepSequence,
    required this.consumedStagedResults,
    required this.uncommittedStagedResults,
  });

  final String lastTurnNodeHash;

  /// `null` iff the run has not completed a step yet.
  final String? lastCompletedStepId;
  final List<StepDeclaration> stepSequence;
  final List<StagedResult> consumedStagedResults;
  final List<StagedResult> uncommittedStagedResults;
}

// --- record conversions used for content-addressed identity hashing ---

Record _pathValueToRecord(PathValue value) {
  switch (value.kind) {
    case PathValueKind.single:
      return RecordText(value.single!);
    case PathValueKind.ordered:
      return RecordArray([for (final hash in value.ordered!) RecordText(hash)]);
    case PathValueKind.nullValue:
      return const RecordNull();
  }
}

RecordMap _manifestToRecord(Map<String, PathValue> manifest) {
  return RecordMap({
    for (final entry in manifest.entries)
      entry.key: _pathValueToRecord(entry.value),
  });
}

/// Builds the record hashed to produce a turn tree's content-addressed
/// hash: SHA-256 of the canonical CBOR encoding of `{manifest, schemaId}`
/// (kernel spec §2.3 / §3.2 identity rule). `createdAtMs` is intentionally
/// excluded. Mirrors `go/kernel/runtime.go`'s `turnTreeIdentityRecord`.
RecordMap turnTreeIdentityRecord(
    String schemaId, Map<String, PathValue> manifest) {
  return RecordMap({
    'manifest': _manifestToRecord(manifest),
    'schemaId': RecordText(schemaId),
  });
}

/// Projects a [StagedResult] onto the fields the CDDL staged-result union
/// declares: `interruptPayload` is present iff the status is
/// "interrupted". Mirrors `go/kernel/runtime.go`'s `stagedResultToRecord`.
RecordMap stagedResultToRecord(StagedResult result) {
  final out = <String, Record>{
    'taskId': RecordText(result.taskId),
    'objectHash': RecordText(result.objectHash),
    'objectType': RecordText(result.objectType),
    'timestamp': RecordInt(result.timestamp),
    'status': RecordText(result.status.name),
  };
  if (result.status == StagedResultStatus.interrupted) {
    out['interruptPayload'] = result.interruptPayload ?? const RecordNull();
  }
  return RecordMap(out);
}

Record nullableHashRecord(String hash) =>
    hash.isEmpty ? const RecordNull() : RecordText(hash);

/// Builds the record hashed to produce a turn node's content-addressed
/// hash: SHA-256 of the canonical CBOR encoding of
/// `{consumedStagedResults, eventHash, previousTurnNodeHash, schemaId,
/// turnTreeHash}` (kernel spec §2.3 / §3.3 identity rule). The `threadId`
/// bookkeeping field carried elsewhere is intentionally excluded: it is
/// not part of the CDDL turn-node identity shape. Mirrors
/// `go/kernel/runtime.go`'s `turnNodeIdentityRecord`.
RecordMap turnNodeIdentityRecord(TurnNode node) {
  final consumed = <Record>[
    for (final result in node.consumedStagedResults)
      stagedResultToRecord(result),
  ];
  return RecordMap({
    'consumedStagedResults': RecordArray(consumed),
    'eventHash': nullableHashRecord(node.eventHash),
    'previousTurnNodeHash': nullableHashRecord(node.previousTurnNodeHash),
    'schemaId': RecordText(node.schemaId),
    'turnTreeHash': RecordText(node.turnTreeHash),
  });
}

/// The optional seam a [Backend] can implement to have `Kernel.checkpointRun`
/// call it after both checkpoint-commit durable writes (`putTurnNode`,
/// `updateBranchHead`) have succeeded but before `checkpointRun` reports
/// success to its own caller. [InMemoryBackend] does not implement it;
/// [FaultInjectingBackend] does. Mirrors `go/kernel/kernel_runtime.go`'s
/// unexported `afterCommitBeforeAckHook` interface -- exposed here (rather
/// than kept package-private, as Go's is) because Dart has no
/// package-private visibility narrower than "this library file and its
/// `part`s," and this hook must cross the `backend.dart` /
/// `fault_injecting_backend.dart` / `kernel_runtime.dart` file boundary.
abstract class AfterCommitBeforeAckHook {
  /// Throws a [KernelException] to interrupt the checkpoint's caller at
  /// this seam; returns normally otherwise.
  void afterCommitBeforeAck();
}

/// Kernel's storage seam: pure content-addressed and keyed storage, with
/// no structural, lineage, or execution semantics of its own. Mirrors
/// `go/kernel/backend.go`'s `Backend` interface.
abstract class Backend {
  // --- object store ---

  StoredObject putObject(String mediaType, List<int> data);
  StoredObject? getObject(String hash);
  bool hasObject(String hash);

  // --- schema registry ---

  /// Returns `false` if `schema.schemaId` is already registered.
  bool putSchema(TurnTreeSchema schema);
  TurnTreeSchema? getSchema(String schemaId);

  // --- turn trees ---

  /// Stores [tree], keyed by its own content-addressed hash.
  void putTurnTree(TurnTree tree);

  /// Returns a defensive copy: mutating the returned value's manifest (or
  /// any ordered [PathValue] within it) never affects the stored state.
  TurnTree? getTurnTree(String hash);

  // --- turn nodes ---

  /// Stores [node], keyed by its own content-addressed hash. Throws a
  /// [KernelException] if the durable write could not be performed -- a
  /// thrown exception means the write did not happen: nothing about
  /// [node] is visible to a later [getTurnNode] call (this is the
  /// "before-commit" fault point a [FaultInjectingBackend] targets).
  void putTurnNode(TurnNode node);

  /// Returns a defensive copy: mutating the returned value (including its
  /// `consumedStagedResults` list) never affects the stored state.
  TurnNode? getTurnNode(String hash);

  /// Returns every stored turn node whose `previousTurnNodeHash` equals
  /// [previousHash], unsorted. A raw inspection seam for tests that want
  /// to observe a durable-but-unreferenced turn node directly; recovery
  /// (`ReconcileRun`) does not use it.
  List<TurnNode> listChildTurnNodes(String previousHash);

  // --- threads ---

  /// Stores [thread], keyed by its `threadId`; `false` if `threadId`
  /// already exists. Also records `thread.rootTurnNodeHash` as owned by
  /// `thread.threadId` in the root-ownership index [getThreadByRootTurnNode]
  /// reads.
  bool putThread(Thread thread);
  Thread? getThread(String threadId);

  /// Returns the threadId that owns [rootTurnNodeHash] as its thread
  /// root, if any thread has claimed it via [putThread].
  String? getThreadByRootTurnNode(String rootTurnNodeHash);

  /// Unsorted; the runtime kernel imposes deterministic order and paging.
  List<Thread> listThreads();

  // --- branches ---

  /// Returns `false` if `branch.branchId` already exists.
  bool putBranch(Branch branch);
  Branch? getBranch(String branchId);
  List<Branch> listBranchesByThread(String threadId);

  /// Moves [branchId]'s head to [headTurnNodeHash]. Returns whether
  /// [branchId] exists (`false` otherwise, with no exception thrown).
  /// Throws a [KernelException] for a durable-write failure on an
  /// existing branch -- the point a [FaultInjectingBackend]'s
  /// "mid-commit" fault point targets. Implementations that inject a
  /// "mid-commit" fault still perform the write (the head does move)
  /// before throwing, modeling a crash that lands after the durable write
  /// completes but before the caller is acknowledged success.
  bool updateBranchHead(
      String branchId, String headTurnNodeHash, int updatedAtMs);

  /// Atomically moves [branchId]'s head to [newHead], but only if its
  /// current head still equals [expectedHead] at the moment of the
  /// write. Returns whether the swap actually happened (`false` if
  /// [branchId] does not exist, or if its head no longer equals
  /// [expectedHead] -- a lost race, not a thrown exception). Throws a
  /// [KernelException] for a durable-write failure distinct from a lost
  /// race.
  bool compareAndSwapBranchHead(
    String branchId,
    String expectedHead,
    String newHead,
    int updatedAtMs,
  );

  // --- runs ---

  /// Returns `false` if `run.runId` already exists.
  bool putRun(Run run);
  Run? getRun(String runId);
  bool updateRun(Run run);
  List<Run> listRunsByBranch(String branchId);

  /// Unsorted; the runtime kernel imposes deterministic order where it
  /// matters (run-liveness expiry listing).
  List<Run> listRuns();

  // --- staged results ---

  /// Appends [result] to [runId]'s uncommitted staging pool.
  void stageResult(String runId, StagedResult result);

  /// Atomically returns and empties [runId]'s uncommitted staging pool.
  List<StagedResult> drainStagedResults(String runId);

  Clock get clock;
}
