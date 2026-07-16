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

/// The M2/M3/M4 runtime kernel host, mirroring `go/kernel/kernel_runtime.go`
/// (schema registry, turn trees, threads, branches, run lifecycle, thread
/// enumeration) and `go/kernel/recovery.go` (`reconcileRun`,
/// `commitSiblingCheckpoint`). [Kernel] is pure logic over a [Backend]: it
/// enforces schema/tree/thread/branch/run structural and lineage rules
/// from `docs/KrakenKernelSpecification.md` §§3-5 and §7, and throws the
/// `kernel_runtime_*` [KernelException]s when a caller violates them.
///
/// Run-liveness leases (`go/kernel/lease.go`) are declared as an extension
/// in `lease.dart`, a `part` of this library: Dart part files cannot
/// continue a class body across files the way Go's single `package kernel`
/// can continue `Kernel`'s method set across `kernel_runtime.go` and
/// `lease.go`, so `KernelLeaseOps` reopens [Kernel] as an extension
/// instead -- `part`/`part of` still puts both files in one library, so
/// the extension can read/write [Kernel]'s private `_leaseTokenOrdinal`
/// counter and call private helpers such as `_checkpointRun` exactly as if
/// they were declared in the same file.
library;

import 'dart:convert';

import 'backend.dart';
import 'cbor.dart';
import 'clock.dart';
import 'errors.dart';
import 'identity.dart';
import 'reclamation.dart';
import 'record.dart';
import 'validate.dart';

part 'lease.dart';

// --- error codes with no dedicated Err* constant in errors.dart, mirroring
// go/kernel/kernel_runtime.go's own inline string literals for these
// (Go does not name them either). Private: lease.dart shares this library.

const String _errSchemaAlreadyRegistered =
    'kernel_runtime_schema_already_registered';
const String _errSchemaNotFound = 'kernel_runtime_schema_not_found';
const String _errTreeNotFound = 'kernel_runtime_tree_not_found';
const String _errThreadNotFound = 'kernel_runtime_thread_not_found';
const String _errThreadAlreadyExists = 'kernel_runtime_thread_already_exists';
const String _errBranchAlreadyExists = 'kernel_runtime_branch_already_exists';
const String _errBranchNotFound = 'kernel_runtime_branch_not_found';
const String _errTurnNodeNotFound = 'kernel_runtime_turn_node_not_found';
const String _errRunNotFound = 'kernel_runtime_run_not_found';
const String _errRunAlreadyExists = 'kernel_runtime_run_already_exists';

/// Bounds the ancestor walk `setBranchHead` performs when classifying a
/// head movement (and the walks `reconcileRun` performs): adversarial or
/// accidentally cyclic `previousTurnNodeHash` chains must degrade into a
/// normal kernel error instead of an unbounded loop.
const int _maxLineageWalkDepth = 100000;

/// Carries `_checkpointRun`'s failure detail across the throw/catch
/// boundary: [hash] is `''` when the checkpoint's turn node never became
/// durable (so the caller must restage `consumed`), or the real minted
/// hash when the durable writes already succeeded and only the
/// branch-head move or after-commit hook failed (so the caller must NOT
/// restage -- `reconcileRun` owns recovering that state). Mirrors the
/// `(hash string, run Run, err error)` triple `go/kernel/kernel_runtime.go`'s
/// `checkpointRun` returns.
class _CheckpointFault implements Exception {
  _CheckpointFault(this.hash, this.cause);

  final String hash;
  final KernelException cause;

  @override
  String toString() => 'checkpoint fault (hash=$hash): $cause';
}

/// The M2/M3/M4 runtime kernel host: scope identity and a clock are
/// injected at construction, and every operation is executed against the
/// injected [backend]. [backend] is intentionally mutable (not `final`) so
/// a caller can install a [FaultInjectingBackend] for one call and restore
/// the original backend afterward, mirroring
/// `go/kernel/fault_injecting_backend.go`'s documented usage pattern.
class Kernel {
  Kernel(this.scopeId, Clock? clock, this.backend)
      : clock = clock ?? backend.clock;

  final String scopeId;
  final Clock clock;
  Backend backend;

  /// Makes every minted lease token unique within this [Kernel] regardless
  /// of clock granularity: kernel spec §5.2 requires a monotonically
  /// changing fencing token, and a purely clock-derived token would repeat
  /// when two acquisitions land on the same backend-clock millisecond (the
  /// norm under the deterministic [ManualClock] this port's scenarios pin
  /// time with). Read/written by `lease.dart`'s `KernelLeaseOps`.
  int _leaseTokenOrdinal = 0;

  // --- object store ---

  /// Stores raw bytes content-addressed by their SHA-256 hash and returns
  /// that hash.
  String putObject(String mediaType, List<int> data) =>
      backend.putObject(mediaType, data).hash;

  bool hasObject(String hash) => backend.hasObject(hash);

  // --- schema registry ---

  /// Validates and registers a turn-tree-schema. Duplicate path
  /// definitions within the schema are rejected by
  /// [validateTurnTreeSchema] ([errDuplicateSchemaPath]) before this ever
  /// reaches the backend.
  void registerSchema(TurnTreeSchema schema) {
    if (!backend.putSchema(schema)) {
      throw KernelException(
        _errSchemaAlreadyRegistered,
        'schema "${schema.schemaId}" is already registered',
      );
    }
  }

  TurnTreeSchema _getSchema(String schemaId) {
    final schema = backend.getSchema(schemaId);
    if (schema == null) {
      throw KernelException(
          _errSchemaNotFound, 'schema "$schemaId" is not registered');
    }
    return schema;
  }

  // --- turn trees ---

  /// Builds a turn tree from [schemaId] and [changes]. When [base] is
  /// `null`, [changes] must supply a value (possibly `PathValue.nullValue()`)
  /// for every path the schema declares; a missing path key is
  /// [errMissingRequiredTreePath]. When [base] is non-null, the base
  /// tree's schema must match [schemaId] ([errTreeSchemaMismatch]) and the
  /// result is the base manifest with [changes] applied on top -- a new
  /// map with only the changed path keys replaced, giving the two trees
  /// structural sharing at the value level.
  String createTurnTree(String schemaId, Map<String, PathValue> changes,
      {String? base}) {
    final schema = _getSchema(schemaId);
    _validateTurnTreeChangeSet(schema, changes);

    final Map<String, PathValue> manifest;
    if (base == null) {
      for (final path in schema.paths) {
        if (!changes.containsKey(path.path)) {
          throw KernelException(
            errMissingRequiredTreePath,
            'turn tree create for schema "$schemaId" is missing required path "${path.path}"',
          );
        }
      }
      manifest = Map.of(changes);
    } else {
      final baseTree = backend.getTurnTree(base);
      if (baseTree == null) {
        throw KernelException(
            _errTreeNotFound, 'base turn tree "$base" not found');
      }
      if (baseTree.schemaId != schemaId) {
        throw KernelException(
          errTreeSchemaMismatch,
          'base turn tree "$base" has schema "${baseTree.schemaId}", expected "$schemaId"',
        );
      }
      manifest = Map.of(baseTree.manifest)..addAll(changes);
    }

    final hash = hashRecord(turnTreeIdentityRecord(schemaId, manifest));
    backend.putTurnTree(
        TurnTree(hash: hash, schemaId: schemaId, manifest: manifest));
    return hash;
  }

  /// Validates a caller-supplied [changes] map against [schema] before
  /// [createTurnTree] applies it (on both the base and no-base paths):
  /// every path key in [changes] must be declared by [schema]
  /// ([errUnknownTreePath] otherwise), and each value's shape must match
  /// its path's declared collection kind -- an ordered array for an
  /// "ordered" path, a hash-string-or-null for a "single" path
  /// ([errInvalidPathValueKind] otherwise). Internal tree construction
  /// (`_incorporateStagedResults`) builds manifests directly from the
  /// schema and never calls this.
  void _validateTurnTreeChangeSet(
      TurnTreeSchema schema, Map<String, PathValue> changes) {
    final pathsByName = {for (final path in schema.paths) path.path: path};

    for (final entry in changes.entries) {
      final pathDefinition = pathsByName[entry.key];
      if (pathDefinition == null) {
        throw KernelException(
          errUnknownTreePath,
          'unknown path "${entry.key}" in schema "${schema.schemaId}"',
        );
      }

      switch (pathDefinition.collection) {
        case PathCollectionKind.ordered:
          if (entry.value.kind != PathValueKind.ordered) {
            throw KernelException(
              errInvalidPathValueKind,
              'changes.${entry.key} must be a HashString[] for an ordered path',
            );
          }
        case PathCollectionKind.single:
          if (entry.value.kind == PathValueKind.ordered) {
            throw KernelException(
              errInvalidPathValueKind,
              'changes.${entry.key} must be a HashString or null for a single path',
            );
          }
      }
    }
  }

  /// Returns the sorted list of manifest path names whose value differs
  /// between the two named trees. Both trees must share the same schema
  /// ([errTreeSchemaMismatchDiff] otherwise); a path present in only one
  /// tree's manifest is compared against `PathValue.nullValue()` for the
  /// other.
  List<String> diffTurnTrees(String hashA, String hashB) {
    final treeA = backend.getTurnTree(hashA);
    if (treeA == null) {
      throw KernelException(_errTreeNotFound, 'turn tree "$hashA" not found');
    }
    final treeB = backend.getTurnTree(hashB);
    if (treeB == null) {
      throw KernelException(_errTreeNotFound, 'turn tree "$hashB" not found');
    }
    if (treeA.schemaId != treeB.schemaId) {
      throw KernelException(
        errTreeSchemaMismatchDiff,
        'turn trees "$hashA" and "$hashB" have different schemas '
        '("${treeA.schemaId}" vs "${treeB.schemaId}")',
      );
    }

    final seen = <String>{...treeA.manifest.keys, ...treeB.manifest.keys};
    final changed = <String>[];
    for (final path in seen) {
      final left = treeA.manifest[path] ?? const PathValue.nullValue();
      final right = treeB.manifest[path] ?? const PathValue.nullValue();
      if (!_pathValuesEqual(left, right)) changed.add(path);
    }
    changed.sort();
    return changed;
  }

  bool _pathValuesEqual(PathValue a, PathValue b) {
    if (a.kind != b.kind) return false;
    switch (a.kind) {
      case PathValueKind.single:
        return a.single == b.single;
      case PathValueKind.ordered:
        final left = a.ordered!;
        final right = b.ordered!;
        if (left.length != right.length) return false;
        for (var i = 0; i < left.length; i++) {
          if (left[i] != right[i]) return false;
        }
        return true;
      case PathValueKind.nullValue:
        return true;
    }
  }

  // --- threads / branches ---

  /// Builds the "every path present" changes map a fresh thread's root
  /// turn tree needs: ordered-collection paths default to an empty
  /// ordered value, single-collection paths default to null.
  Map<String, PathValue> _defaultManifestChanges(TurnTreeSchema schema) {
    return {
      for (final path in schema.paths)
        path.path: path.collection == PathCollectionKind.ordered
            ? const PathValue.ordered([])
            : const PathValue.nullValue(),
    };
  }

  static const String _bootstrapThreadEventMediaType = 'application/cbor';

  /// Builds the canonical-record encoding of a thread's genesis bootstrap
  /// event: `{threadId, type: "kernel_runtime_thread_bootstrap"}`.
  RecordMap _threadBootstrapRecord(String threadId) => RecordMap({
        'threadId': RecordText(threadId),
        'type': const RecordText('kernel_runtime_thread_bootstrap'),
      });

  /// Creates a new thread on [schemaId]: a root turn tree (every schema
  /// path defaulted), a root turn node, and a main branch ([branchId])
  /// whose head is that root turn node.
  ///
  /// The root turn node's identity is not purely schema-derived:
  /// [createThread] mints a backend-owned bootstrap object encoding
  /// [threadId] (see [_threadBootstrapRecord]) and pins its hash as the
  /// root node's `eventHash` before hashing the node. Because a turn
  /// node's content-addressed hash covers `eventHash`, this guarantees
  /// every thread's genesis node hash is unique to that thread even when
  /// two threads share a schema and would otherwise both default to an
  /// identical empty manifest (kernel spec §3.3).
  ThreadCreateResult createThread(
      String threadId, String schemaId, String branchId) {
    final schema = _getSchema(schemaId);

    final rootTreeHash =
        createTurnTree(schemaId, _defaultManifestChanges(schema));

    final bootstrapBytes = encodeCanonical(_threadBootstrapRecord(threadId));
    final bootstrapEventHash =
        backend.putObject(_bootstrapThreadEventMediaType, bootstrapBytes).hash;

    final unhashedRoot = TurnNode(
      hash: '',
      schemaId: schemaId,
      turnTreeHash: rootTreeHash,
      eventHash: bootstrapEventHash,
    );
    final rootNodeHash = hashRecord(turnNodeIdentityRecord(unhashedRoot));

    // Defense in depth: with a thread-unique bootstrap eventHash this
    // should be structurally unreachable, but a corrupted or adversarial
    // backend state must still be rejected rather than silently letting a
    // second thread adopt another thread's genesis node as its own root.
    final existingThreadId = backend.getThreadByRootTurnNode(rootNodeHash);
    if (existingThreadId != null) {
      throw KernelException(
        errThreadRootNotUnique,
        'turn node "$rootNodeHash" is already the root of thread "$existingThreadId"',
      );
    }

    backend.putTurnNode(TurnNode(
      hash: rootNodeHash,
      schemaId: schemaId,
      turnTreeHash: rootTreeHash,
      eventHash: bootstrapEventHash,
    ));

    final now = clock.nowMs();
    if (!backend.putThread(Thread(
      threadId: threadId,
      schemaId: schemaId,
      rootTurnNodeHash: rootNodeHash,
      createdAtMs: now,
    ))) {
      throw KernelException(
          _errThreadAlreadyExists, 'thread "$threadId" already exists');
    }
    if (!backend.putBranch(Branch(
      branchId: branchId,
      threadId: threadId,
      headTurnNodeHash: rootNodeHash,
      createdAtMs: now,
      updatedAtMs: now,
    ))) {
      throw KernelException(
          _errBranchAlreadyExists, 'branch "$branchId" already exists');
    }

    return ThreadCreateResult(
      branchId: branchId,
      rootTurnNodeHash: rootNodeHash,
      rootTurnTreeHash: rootTreeHash,
      threadId: threadId,
    );
  }

  /// Reports whether the turn node at [hash] belongs to the thread whose
  /// (now provably unique, see [createThread]) root turn node hash is
  /// [threadRootHash]: it walks [hash]'s `previousTurnNodeHash` chain
  /// backward looking for [threadRootHash], capped at
  /// [_maxLineageWalkDepth].
  bool _turnNodeBelongsToThread(String hash, String threadRootHash) {
    var cursor = hash;
    for (var depth = 0; depth < _maxLineageWalkDepth; depth++) {
      if (cursor == threadRootHash) return true;
      final node = backend.getTurnNode(cursor);
      if (node == null || node.previousTurnNodeHash.isEmpty) return false;
      cursor = node.previousTurnNodeHash;
    }
    return false;
  }

  /// Forks a new branch on [threadId] whose head is [fromTurnNodeHash].
  /// [fromTurnNodeHash] must be a turn node that belongs to [threadId]
  /// ([errTurnNodeThreadMismatch] otherwise) -- this is the cross-thread
  /// consumption guard: a caller must not attach a turn node minted on one
  /// thread to a branch on another thread.
  void createBranch(String branchId, String threadId, String fromTurnNodeHash) {
    final thread = backend.getThread(threadId);
    if (thread == null) {
      throw KernelException(_errThreadNotFound, 'thread "$threadId" not found');
    }
    if (backend.getTurnNode(fromTurnNodeHash) == null) {
      throw KernelException(
          _errTurnNodeNotFound, 'turn node "$fromTurnNodeHash" not found');
    }
    if (!_turnNodeBelongsToThread(fromTurnNodeHash, thread.rootTurnNodeHash)) {
      throw KernelException(
        errTurnNodeThreadMismatch,
        'turn node "$fromTurnNodeHash" does not belong to thread "$threadId"',
      );
    }

    final now = clock.nowMs();
    if (!backend.putBranch(Branch(
      branchId: branchId,
      threadId: threadId,
      headTurnNodeHash: fromTurnNodeHash,
      createdAtMs: now,
      updatedAtMs: now,
    ))) {
      throw KernelException(
          _errBranchAlreadyExists, 'branch "$branchId" already exists');
    }
  }

  /// Returns `(branchId, headTurnNodeHash)` tuples for every branch on
  /// [threadId], sorted by branchId for a deterministic result.
  List<(String, String)> listBranchHeads(String threadId) {
    if (backend.getThread(threadId) == null) {
      throw KernelException(_errThreadNotFound, 'thread "$threadId" not found');
    }
    final branches = backend.listBranchesByThread(threadId)
      ..sort((a, b) => a.branchId.compareTo(b.branchId));
    return [
      for (final branch in branches) (branch.branchId, branch.headTurnNodeHash)
    ];
  }

  /// Reports whether [targetHash] appears in [fromHash]'s
  /// `previousTurnNodeHash` chain, not counting [fromHash] itself, capped
  /// at [_maxLineageWalkDepth].
  bool _isStrictAncestor(String fromHash, String targetHash) {
    var cursor = fromHash;
    for (var depth = 0; depth < _maxLineageWalkDepth; depth++) {
      final node = backend.getTurnNode(cursor);
      if (node == null || node.previousTurnNodeHash.isEmpty) return false;
      if (node.previousTurnNodeHash == targetHash) return true;
      cursor = node.previousTurnNodeHash;
    }
    return false;
  }

  /// Classifies how [newHead] relates to a branch's [currentHead] (kernel
  /// spec §4.2): forward (strict descendant), backward (strict ancestor --
  /// an archival rollback), or lateral (neither).
  _HeadMovement _classifyHeadMovement(String currentHead, String newHead) {
    if (_isStrictAncestor(newHead, currentHead)) return _HeadMovement.forward;
    if (_isStrictAncestor(currentHead, newHead)) return _HeadMovement.backward;
    return _HeadMovement.lateral;
  }

  /// Returns the branch's running-or-paused run, if any.
  Run? _activeRunOnBranch(String branchId) {
    for (final run in backend.listRunsByBranch(branchId)) {
      if (run.status == RunStatus.running || run.status == RunStatus.paused) {
        return run;
      }
    }
    return null;
  }

  /// Walks [currentHead]'s `previousTurnNodeHash` chain backward until it
  /// reaches [targetHash], returning the set of hashes strictly between
  /// them (inclusive of [currentHead], exclusive of [targetHash]) -- the
  /// segment a backward `setBranchHead` move abandons and archives.
  /// Throws [errBackwardLineageMismatch] if [targetHash] is never reached
  /// within [_maxLineageWalkDepth].
  Set<String> _collectAbandonedSegmentHashes(
      String currentHead, String targetHash) {
    final hashes = <String>{};
    var cursor = currentHead;
    for (var depth = 0; depth < _maxLineageWalkDepth; depth++) {
      if (cursor == targetHash) return hashes;
      hashes.add(cursor);
      final node = backend.getTurnNode(cursor);
      if (node == null || node.previousTurnNodeHash.isEmpty) {
        throw KernelException(
          errBackwardLineageMismatch,
          'target "$targetHash" is not an ancestor of current head "$currentHead"',
        );
      }
      cursor = node.previousTurnNodeHash;
    }
    throw KernelException(
      errBackwardLineageMismatch,
      'target "$targetHash" is not an ancestor of current head "$currentHead"',
    );
  }

  /// Probes `"{branchId}-archive-{ordinal}-{currentHead prefix}"` starting
  /// at [initialOrdinal] and incrementing past any collision.
  String _allocateArchiveBranchId(
      String branchId, String currentHead, int initialOrdinal) {
    final prefixLen = currentHead.length < 16 ? currentHead.length : 16;
    var ordinal = initialOrdinal;
    while (true) {
      final candidate =
          '$branchId-archive-$ordinal-${currentHead.substring(0, prefixLen)}';
      if (backend.getBranch(candidate) == null) return candidate;
      ordinal++;
    }
  }

  /// Reports whether [run]'s start node or any turn node it created falls
  /// within [segmentHashes].
  bool _runTouchesSegment(Run run, Set<String> segmentHashes) {
    if (segmentHashes.contains(run.startTurnNodeHash)) return true;
    for (final hash in run.createdTurnNodes) {
      if (segmentHashes.contains(hash)) return true;
    }
    return false;
  }

  /// Performs a backward `setBranchHead` move (kernel spec §4.2): an
  /// atomic archival rollback. It mints a fresh archive branch
  /// (`archivedFromBranchId == branchId`) whose head preserves the
  /// abandoned lineage's tip (branch's current head), fails every
  /// running-or-paused run on [branchId] that touches the abandoned
  /// segment (clearing its staged results), and only then moves
  /// [branchId]'s own head to [newHead].
  void _rollbackBranchHead(String branchId, Branch branch, String newHead) {
    final abandoned =
        _collectAbandonedSegmentHashes(branch.headTurnNodeHash, newHead);

    var archiveOrdinal = 1;
    for (final candidate in backend.listBranchesByThread(branch.threadId)) {
      if (candidate.archivedFromBranchId == branchId) archiveOrdinal++;
    }
    final archiveBranchId = _allocateArchiveBranchId(
        branchId, branch.headTurnNodeHash, archiveOrdinal);

    final now = clock.nowMs();
    if (!backend.putBranch(Branch(
      branchId: archiveBranchId,
      threadId: branch.threadId,
      headTurnNodeHash: branch.headTurnNodeHash,
      archivedFromBranchId: branchId,
      createdAtMs: now,
      updatedAtMs: now,
    ))) {
      throw KernelException(
        _errBranchAlreadyExists,
        'archive branch "$archiveBranchId" already exists',
      );
    }

    for (final run in backend.listRunsByBranch(branchId)) {
      if ((run.status == RunStatus.running || run.status == RunStatus.paused) &&
          _runTouchesSegment(run, abandoned)) {
        backend.drainStagedResults(run.runId);
        run.status = RunStatus.failed;
        backend.updateRun(run);
      }
    }

    backend.updateBranchHead(branchId, newHead, now);
  }

  /// Moves [branchId]'s head to [newHead]. [newHead] must belong to the
  /// branch's thread ([errTurnNodeThreadMismatch] otherwise). Moving to
  /// the branch's own current head is a no-op success. Otherwise the move
  /// is classified as forward, backward, or lateral (kernel spec §4.2):
  ///
  ///  - forward: [newHead] is a strict descendant of the current head.
  ///    Rejected with [errBranchHasActiveRun] if [branchId] has a running
  ///    or paused run, otherwise the branch head simply advances.
  ///  - backward: [newHead] is a strict ancestor of the current head.
  ///    Handled as an atomic archival rollback by [_rollbackBranchHead]:
  ///    unlike forward, this is allowed even with an active run, but any
  ///    run touching the abandoned segment is failed as part of the same
  ///    move.
  ///  - lateral: neither. Always rejected ([errLateralHeadMovement]).
  void setBranchHead(String branchId, String newHead) {
    final branch = backend.getBranch(branchId);
    if (branch == null) {
      throw KernelException(_errBranchNotFound, 'branch "$branchId" not found');
    }
    final thread = backend.getThread(branch.threadId);
    if (thread == null) {
      throw KernelException(
          _errThreadNotFound, 'thread "${branch.threadId}" not found');
    }
    if (backend.getTurnNode(newHead) == null) {
      throw KernelException(
          _errTurnNodeNotFound, 'turn node "$newHead" not found');
    }
    if (!_turnNodeBelongsToThread(newHead, thread.rootTurnNodeHash)) {
      throw KernelException(
        errTurnNodeThreadMismatch,
        'turn node "$newHead" does not belong to thread "${branch.threadId}"',
      );
    }

    if (newHead == branch.headTurnNodeHash) return;

    switch (_classifyHeadMovement(branch.headTurnNodeHash, newHead)) {
      case _HeadMovement.lateral:
        throw KernelException(
          errLateralHeadMovement,
          'turn node "$newHead" is not a descendant of branch "$branchId"\'s '
          'current head "${branch.headTurnNodeHash}"',
        );
      case _HeadMovement.backward:
        _rollbackBranchHead(branchId, branch, newHead);
      case _HeadMovement.forward:
        final active = _activeRunOnBranch(branchId);
        if (active != null) {
          throw KernelException(
            errBranchHasActiveRun,
            'branch "$branchId" cannot move head while run "${active.runId}" is active',
          );
        }
        backend.updateBranchHead(branchId, newHead, clock.nowMs());
    }
  }

  // --- run lifecycle ---

  /// Rejects a declared step sequence that repeats the same step id more
  /// than once ([errDuplicateStepId]).
  void _requireUniqueStepIds(List<StepDeclaration> steps) {
    final seen = <String>{};
    for (final step in steps) {
      if (!seen.add(step.id)) {
        throw KernelException(
          errDuplicateStepId,
          'duplicate step id "${step.id}" in run step sequence',
        );
      }
    }
  }

  /// Creates a run on [branchId]. [startTurnNodeHash] must match
  /// [branchId]'s current head ([errRunBranchHeadMismatch] otherwise) -- a
  /// run always starts from wherever its branch currently is, never from
  /// a stale or foreign turn node. [stepSequence]'s step ids must be
  /// unique ([errDuplicateStepId] otherwise). A branch may have at most
  /// one running-or-paused run at a time ([errBranchAlreadyActive]
  /// otherwise).
  void createRun(
    String runId,
    String turnId,
    String branchId,
    String schemaId,
    String startTurnNodeHash,
    List<StepDeclaration> stepSequence,
  ) {
    final branch = backend.getBranch(branchId);
    if (branch == null) {
      throw KernelException(_errBranchNotFound, 'branch "$branchId" not found');
    }
    if (branch.headTurnNodeHash != startTurnNodeHash) {
      throw KernelException(
        errRunBranchHeadMismatch,
        'run start turn node "$startTurnNodeHash" does not match branch "$branchId"\'s '
        'current head "${branch.headTurnNodeHash}"',
      );
    }
    _requireUniqueStepIds(stepSequence);

    final active = _activeRunOnBranch(branchId);
    if (active != null) {
      throw KernelException(
        errBranchAlreadyActive,
        'branch "$branchId" already has an active run ("${active.runId}")',
      );
    }

    final run = Run(
      runId: runId,
      turnId: turnId,
      branchId: branchId,
      schemaId: schemaId,
      startTurnNodeHash: startTurnNodeHash,
      status: RunStatus.running,
      currentStepIndex: 0,
      stepSequence: stepSequence,
      threadId: branch.threadId,
    );
    if (!backend.putRun(run)) {
      throw KernelException(
          _errRunAlreadyExists, 'run "$runId" already exists');
    }
  }

  void _requireExpectedStep(Run run, String stepId) {
    if (run.currentStepIndex >= run.stepSequence.length ||
        run.stepSequence[run.currentStepIndex].id != stepId) {
      throw KernelException(
        errUnexpectedStep,
        'run "${run.runId}" expected a different step than "$stepId" at index '
        '${run.currentStepIndex}',
      );
    }
  }

  /// Validates that [stepId] is the run's next declared step.
  void beginStep(String runId, String stepId) {
    final run = backend.getRun(runId);
    if (run == null) {
      throw KernelException(_errRunNotFound, 'run "$runId" not found');
    }
    _requireExpectedStep(run, stepId);
  }

  String _activeTurnNodeHash(Run run) => run.createdTurnNodes.isNotEmpty
      ? run.createdTurnNodes.last
      : run.startTurnNodeHash;

  /// Derives a new turn tree from [baseTreeHash] by applying [consumed]
  /// onto it per [schema]'s incorporation rules (kernel spec §5.5): an
  /// ordered target path appends the staged result's object hash, a
  /// single target path replaces the value outright. Returns
  /// [baseTreeHash] unchanged when [consumed] is empty.
  String _incorporateStagedResults(
    TurnTreeSchema schema,
    String baseTreeHash,
    List<StagedResult> consumed,
  ) {
    if (consumed.isEmpty) return baseTreeHash;

    final baseTree = backend.getTurnTree(baseTreeHash);
    if (baseTree == null) {
      throw KernelException(
          _errTreeNotFound, 'turn tree "$baseTreeHash" not found');
    }

    final rulesByObjectType = {
      for (final rule in schema.incorporationRules) rule.objectType: rule,
    };
    final pathsByName = {for (final path in schema.paths) path.path: path};

    final changes = <String, PathValue>{};
    for (final result in consumed) {
      final rule = rulesByObjectType[result.objectType];
      if (rule == null) {
        throw KernelException(
          errUnmatchedIncorporationRule,
          'no incorporation rule for objectType "${result.objectType}" in schema '
          '"${schema.schemaId}"',
        );
      }

      if (pathsByName[rule.targetPath]?.collection ==
          PathCollectionKind.ordered) {
        final current =
            changes[rule.targetPath] ?? baseTree.manifest[rule.targetPath];
        final ordered = <String>[];
        if (current != null && current.kind == PathValueKind.ordered) {
          ordered.addAll(current.ordered!);
        }
        ordered.add(result.objectHash);
        changes[rule.targetPath] = PathValue.ordered(ordered);
      } else {
        changes[rule.targetPath] = PathValue.single(result.objectHash);
      }
    }

    return createTurnTree(schema.schemaId, changes, base: baseTreeHash);
  }

  /// Mints a new turn node chained onto [run]'s active turn node, advances
  /// [run]'s branch head to it, and appends it to [run]'s
  /// `createdTurnNodes` (returned, not yet persisted via `updateRun`).
  /// When [treeHash] is `''`, the new node's turn tree is derived from the
  /// active node's tree by incorporating [consumed] per the run's schema;
  /// otherwise [treeHash] is used as-is. [kind] records which
  /// checkpoint-minting entry point this call belongs to so
  /// [reconcileRun] can fold a torn commit's pending node back in as the
  /// right kind of transition.
  ///
  /// Throws [_CheckpointFault] on every failure path: `fault.hash` is
  /// `''` when the checkpoint's turn node never became durable (the
  /// caller must restage [consumed]), or the real minted hash when the
  /// durable writes already succeeded and only the branch-head move or
  /// after-commit hook failed (the caller must NOT restage --
  /// [reconcileRun] owns recovering that state from the durable
  /// `pendingCheckpointHash` marker written below).
  ///
  /// Refuses with [errRunPendingCheckpoint] before doing anything else
  /// when [run] already has a durably-recorded `pendingCheckpointHash`: a
  /// prior checkpoint attempt on this run is torn, and minting a second
  /// checkpoint on top of it -- rather than requiring [reconcileRun] first
  /// -- would silently overwrite the pending marker and orphan the first
  /// checkpoint's durable node.
  (String, Run) _checkpointRun(
    Run run,
    String eventHash,
    String treeHash,
    List<StagedResult> consumed,
    PendingCheckpointKind kind,
  ) {
    if (run.pendingCheckpointHash.isNotEmpty) {
      throw _CheckpointFault(
        '',
        KernelException(
          errRunPendingCheckpoint,
          'run "${run.runId}" has an unreconciled pending checkpoint '
          '"${run.pendingCheckpointHash}" (kind "${run.pendingCheckpointKind?.name}"); '
          'call reconcileRun before attempting a new checkpoint',
        ),
      );
    }

    final String hash;
    final TurnNode newNode;
    try {
      final schema = _getSchema(run.schemaId);

      final activeHash = _activeTurnNodeHash(run);
      final activeNode = backend.getTurnNode(activeHash);
      if (activeNode == null) {
        throw KernelException(
          _errTurnNodeNotFound,
          'run "${run.runId}"\'s active turn node "$activeHash" not found',
        );
      }

      final newTreeHash = treeHash.isEmpty
          ? _incorporateStagedResults(schema, activeNode.turnTreeHash, consumed)
          : treeHash;

      final unhashed = TurnNode(
        hash: '',
        schemaId: run.schemaId,
        turnTreeHash: newTreeHash,
        previousTurnNodeHash: activeNode.hash,
        eventHash: eventHash,
        consumedStagedResults: consumed,
      );
      hash = hashRecord(turnNodeIdentityRecord(unhashed));
      newNode = TurnNode(
        hash: hash,
        schemaId: run.schemaId,
        turnTreeHash: newTreeHash,
        previousTurnNodeHash: activeNode.hash,
        eventHash: eventHash,
        consumedStagedResults: consumed,
      );

      // The checkpoint commit sequence's first durable write. A
      // FaultInjectingBackend's "before-commit" fault point fires here:
      // the write never happens, run.createdTurnNodes is never extended,
      // and the branch head never moves.
      backend.putTurnNode(newNode);
    } on KernelException catch (e) {
      throw _CheckpointFault('', e);
    }

    // Durably record the pending checkpoint's node hash on the run
    // itself, now that the node is durable but before either the
    // branch-head move below or the after-commit-before-ack hook is
    // attempted. reconcileRun reconciles from exactly this field.
    final pendingMarker = run.clone()
      ..pendingCheckpointHash = hash
      ..pendingCheckpointKind = kind;
    backend.updateRun(pendingMarker);

    final updatedRun = run.clone();
    updatedRun.createdTurnNodes = [...updatedRun.createdTurnNodes, hash];

    // The checkpoint commit sequence's second durable write. A
    // FaultInjectingBackend's "mid-commit" fault point fires here without
    // performing the move at all: the turn node written just above is
    // already durable, but the branch head is left exactly where it was,
    // modeling a genuine torn checkpoint.
    try {
      backend.updateBranchHead(run.branchId, hash, clock.nowMs());
    } on KernelException catch (e) {
      throw _CheckpointFault(hash, e);
    }

    // afterCommitBeforeAck, if the backend exposes it, fires after both
    // durable writes above have fully succeeded but before this call
    // returns success to its caller -- the "after-commit-before-ack"
    // fault point.
    if (backend case AfterCommitBeforeAckHook hook) {
      try {
        hook.afterCommitBeforeAck();
      } on KernelException catch (e) {
        throw _CheckpointFault(hash, e);
      }
    }

    updatedRun.pendingCheckpointHash = '';
    updatedRun.pendingCheckpointKind = null;

    return (hash, updatedRun);
  }

  /// Validates that [stepId] is the run's next declared step, checks
  /// [eventHash] (if non-empty) exists in the object store
  /// ([errMissingEventObject] otherwise), and checkpoints: it mints a new
  /// turn node whose `consumedStagedResults` is everything staged since
  /// the previous checkpoint, evolves the turn tree by incorporating
  /// those staged results per the run's schema, advances the run's step
  /// index, and returns the new turn node's hash. When [treeHash] is
  /// non-empty, it is used as the checkpoint's turn tree instead of one
  /// derived from staged results -- it must already exist and share the
  /// run's schemaId ([errMissingTree] / [errTreeSchemaMismatch]
  /// otherwise).
  String completeStep(
      String runId, String stepId, String eventHash, String treeHash) {
    final run = backend.getRun(runId);
    if (run == null) {
      throw KernelException(_errRunNotFound, 'run "$runId" not found');
    }
    _requireExpectedStep(run, stepId);
    if (eventHash.isNotEmpty && !backend.hasObject(eventHash)) {
      throw KernelException(
        errMissingEventObject,
        'event object "$eventHash" is not present in the object store',
      );
    }
    if (treeHash.isNotEmpty) {
      final tree = backend.getTurnTree(treeHash);
      if (tree == null) {
        throw KernelException(
            errMissingTree, 'tree hash "$treeHash" does not exist');
      }
      if (tree.schemaId != run.schemaId) {
        throw KernelException(
          errTreeSchemaMismatch,
          'tree hash "$treeHash" uses schema "${tree.schemaId}" but run uses schema '
          '"${run.schemaId}"',
        );
      }
    }

    final consumed = backend.drainStagedResults(runId);
    try {
      final (hash, updatedRun) = _checkpointRun(
          run, eventHash, treeHash, consumed, PendingCheckpointKind.step);
      updatedRun.currentStepIndex++;
      backend.updateRun(updatedRun);
      return hash;
    } on _CheckpointFault catch (fault) {
      if (fault.hash.isEmpty) {
        for (final result in consumed) {
          backend.stageResult(runId, result);
        }
      }
      throw fault.cause;
    }
  }

  /// Validates [eventHash] (if non-empty) exists in the object store
  /// ([errMissingEventObject] otherwise), reactively checkpoints any
  /// staged results (or a non-empty [eventHash]) left un-anchored since
  /// the run's last step boundary (kernel spec §5.6) exactly like
  /// [completeStep]'s checkpoint, and marks the run completed. A run with
  /// nothing staged and no eventHash completes without minting an extra
  /// turn node.
  void completeRun(String runId, String eventHash) {
    final run = backend.getRun(runId);
    if (run == null) {
      throw KernelException(_errRunNotFound, 'run "$runId" not found');
    }
    if (run.status != RunStatus.running && run.status != RunStatus.paused) {
      throw KernelException(
        errRunNotActive,
        'run "$runId" cannot be completed (status: ${run.status.name})',
      );
    }
    if (run.status == RunStatus.paused) {
      throw KernelException(
        errInvalidPausedRunCompletion,
        'paused run "$runId" can only be completed as failed',
      );
    }
    if (eventHash.isNotEmpty && !backend.hasObject(eventHash)) {
      throw KernelException(
        errMissingEventObject,
        'event object "$eventHash" is not present in the object store',
      );
    }
    if (run.pendingCheckpointHash.isNotEmpty) {
      throw KernelException(
        errRunPendingCheckpoint,
        'run "${run.runId}" has an unreconciled pending checkpoint '
        '"${run.pendingCheckpointHash}" (kind "${run.pendingCheckpointKind?.name}"); '
        'call reconcileRun before attempting a new checkpoint',
      );
    }

    var current = run;
    final staged = backend.drainStagedResults(runId);
    if (staged.isNotEmpty || eventHash.isNotEmpty) {
      try {
        final (_, updatedRun) = _checkpointRun(
            current, eventHash, '', staged, PendingCheckpointKind.complete);
        current = updatedRun;
      } on _CheckpointFault catch (fault) {
        if (fault.hash.isEmpty) {
          for (final result in staged) {
            backend.stageResult(runId, result);
          }
        }
        throw fault.cause;
      }
    }

    current.status = RunStatus.completed;
    current.currentStepIndex = current.stepSequence.length;
    current.hasLease = false;
    current.leaseOwnerId = '';
    current.leaseToken = '';
    current.leaseExpiresAtMs = 0;
    backend.updateRun(current);
  }

  /// Adds [result] to [runId]'s uncommitted staging pool.
  void stageResult(String runId, StagedResult result) {
    if (backend.getRun(runId) == null) {
      throw KernelException(_errRunNotFound, 'run "$runId" not found');
    }
    backend.stageResult(runId, result);
  }

  /// Reports [runId]'s recovery-state: the run's active turn node hash,
  /// the id of its last completed step (if any), its declared step
  /// sequence, the staged results consumed at its last checkpoint, and
  /// whatever remains staged but uncommitted since that checkpoint.
  RecoveryState recoveryState(String runId) {
    final run = backend.getRun(runId);
    if (run == null) {
      throw KernelException(_errRunNotFound, 'run "$runId" not found');
    }

    final activeHash = _activeTurnNodeHash(run);
    final activeNode = backend.getTurnNode(activeHash);
    if (activeNode == null) {
      throw KernelException(
        _errTurnNodeNotFound,
        'run "$runId"\'s active turn node "$activeHash" not found',
      );
    }

    String? lastCompletedStepId;
    if (run.currentStepIndex > 0) {
      lastCompletedStepId = run.stepSequence[run.currentStepIndex - 1].id;
    }

    return RecoveryState(
      lastTurnNodeHash: activeHash,
      lastCompletedStepId: lastCompletedStepId,
      stepSequence: run.stepSequence,
      consumedStagedResults: activeNode.consumedStagedResults,
      uncommittedStagedResults: _peekStagedResults(runId),
    );
  }

  /// Reads a run's uncommitted staging pool without draining it
  /// ([recoveryState] is a read-only query).
  List<StagedResult> _peekStagedResults(String runId) {
    final drained = backend.drainStagedResults(runId);
    for (final result in drained) {
      backend.stageResult(runId, result);
    }
    return drained;
  }

  // --- thread enumeration (capability kernel-protocol.thread.enumeration) ---

  /// Enumerates threads in deterministic (createdAtMs ASC, threadId ASC)
  /// order. `limit <= 0` means "no limit." When the result is truncated
  /// by `limit`, the returned cursor is non-empty and resuming with it
  /// (as the [cursor] argument to a later [listThreads] call) continues
  /// strictly after the last returned thread.
  (List<Thread>, String) listThreads(int limit, String cursor) {
    final all = backend.listThreads()
      ..sort((a, b) {
        if (a.createdAtMs != b.createdAtMs) {
          return a.createdAtMs.compareTo(b.createdAtMs);
        }
        return a.threadId.compareTo(b.threadId);
      });

    var start = 0;
    if (cursor.isNotEmpty) {
      final decoded = _decodeThreadListCursor(cursor);
      start = _threadListUpperBound(all, decoded);
    }

    final remaining = all.sublist(start);
    if (limit <= 0 || limit >= remaining.length) {
      return (remaining, '');
    }

    final page = remaining.sublist(0, limit);
    final last = page.last;
    final next = _encodeThreadListCursor(
        _ThreadListCursor(last.createdAtMs, last.threadId));
    return (page, next);
  }

  /// The first index in the (createdAtMs ASC, threadId ASC)-sorted [all]
  /// strictly after [decoded], mirroring `sort.Search` over the same
  /// predicate `go/kernel/kernel_runtime.go`'s `ListThreads` uses.
  int _threadListUpperBound(List<Thread> all, _ThreadListCursor decoded) {
    var lo = 0;
    var hi = all.length;
    while (lo < hi) {
      final mid = (lo + hi) ~/ 2;
      final thread = all[mid];
      final after = thread.createdAtMs != decoded.lastCreatedAtMs
          ? thread.createdAtMs > decoded.lastCreatedAtMs
          : thread.threadId.compareTo(decoded.lastThreadId) > 0;
      if (after) {
        hi = mid;
      } else {
        lo = mid + 1;
      }
    }
    return lo;
  }

  // --- recovery (go/kernel/recovery.go) ---

  /// Repairs [runId]'s in-memory run record forward when a checkpoint's
  /// durable writes (`putTurnNode`, `updateBranchHead`) already succeeded
  /// but the caller that attempted the checkpoint never got to persist
  /// the run record's own advance -- the observable aftermath of a
  /// [FaultPoint.midCommit] or [FaultPoint.afterCommitBeforeAck] fault.
  /// It reconciles from the run's own durably-recorded
  /// `pendingCheckpointHash` rather than rediscovering a pending node by
  /// structure. A no-op when the run has no pending checkpoint and the
  /// branch head already matches the run's active turn node.
  void reconcileRun(String runId) {
    final run = backend.getRun(runId);
    if (run == null) {
      throw KernelException(_errRunNotFound, 'run "$runId" not found');
    }
    var branch = backend.getBranch(run.branchId);
    if (branch == null) {
      throw KernelException(
          _errBranchNotFound, 'branch "${run.branchId}" not found');
    }

    final activeHash = _activeTurnNodeHash(run);

    if (run.pendingCheckpointHash.isNotEmpty) {
      final pendingHash = run.pendingCheckpointHash;
      final pendingNode = backend.getTurnNode(pendingHash);
      if (pendingNode == null) {
        throw KernelException(
          _errTurnNodeNotFound,
          'run "$runId"\'s pending checkpoint turn node "$pendingHash" not found',
        );
      }

      if (branch.headTurnNodeHash != pendingHash) {
        // Genuine torn checkpoint (FaultPoint.midCommit): the pending
        // node is durable, but the head move never happened. Move it
        // now, CAS'd from exactly the head the pending node was minted
        // against -- never a blind unconditional write.
        final swapped = backend.compareAndSwapBranchHead(
          run.branchId,
          pendingNode.previousTurnNodeHash,
          pendingHash,
          clock.nowMs(),
        );
        if (swapped) {
          branch.headTurnNodeHash = pendingHash;
        } else {
          final refreshed = backend.getBranch(run.branchId);
          if (refreshed == null) {
            throw KernelException(
                _errBranchNotFound, 'branch "${run.branchId}" not found');
          }
          branch = refreshed;
        }
      }

      // Either the head move above just succeeded, or
      // FaultPoint.afterCommitBeforeAck already advanced it before this
      // call ever ran -- in both cases the head is now genuinely at the
      // pending node, and the run's own bookkeeping can fold it in.
      if (branch.headTurnNodeHash == pendingHash) {
        run.createdTurnNodes = [...run.createdTurnNodes, pendingHash];
        switch (run.pendingCheckpointKind) {
          case PendingCheckpointKind.complete:
            run.status = RunStatus.completed;
            run.currentStepIndex = run.stepSequence.length;
            run.hasLease = false;
            run.leaseOwnerId = '';
            run.leaseToken = '';
            run.leaseExpiresAtMs = 0;
          case PendingCheckpointKind.preempt:
            run.status = RunStatus.failed;
            run.preemptionReason = 'stale_running_recovery';
            run.hasLease = false;
            run.leaseOwnerId = '';
            run.leaseToken = '';
            run.leaseExpiresAtMs = 0;
          case PendingCheckpointKind.step:
          case null:
            // PendingCheckpointKind.step (or, defensively, an unset
            // kind): today's ordinary step-advance behavior.
            run.currentStepIndex++;
            if (run.currentStepIndex > run.stepSequence.length) {
              run.currentStepIndex = run.stepSequence.length;
            }
        }
        run.pendingCheckpointHash = '';
        run.pendingCheckpointKind = null;
        backend.updateRun(run);
        return;
      }

      // The branch head is neither the run's active node nor its pending
      // node: the head legitimately advanced elsewhere while this
      // checkpoint was torn (e.g. a commitSiblingCheckpoint winner raced
      // it). The durable pending node stays off-lineage (content-
      // addressed, write-once; reclamation collects it). Retire the
      // stale marker and stop.
      run.pendingCheckpointHash = '';
      run.pendingCheckpointKind = null;
      backend.updateRun(run);
      return;
    }

    if (branch.headTurnNodeHash == activeHash) return;

    // Invariant: the head-to-active backward walk below only ever
    // reconstructs *this* run's own missed checkpoint nodes when run is
    // still "running" -- the single-active-run-per-branch invariant
    // guarantees that whenever a run is "running" it is the only run on
    // its branch that could have checkpointed since its active turn
    // node. A "completed" or "failed" run's active turn node is a fixed
    // point in that branch's history instead: leave it untouched.
    if (run.status != RunStatus.running) return;

    final chain = <String>[];
    var cursor = branch.headTurnNodeHash;
    for (var depth = 0; depth < _maxLineageWalkDepth; depth++) {
      if (cursor == activeHash) break;
      final node = backend.getTurnNode(cursor);
      if (node == null) {
        throw KernelException(
          _errTurnNodeNotFound,
          'turn node "$cursor" not found while reconciling run "$runId"',
        );
      }
      chain.add(cursor);
      if (node.previousTurnNodeHash.isEmpty) {
        throw KernelException(
          errBackwardLineageMismatch,
          'run "$runId"\'s active turn node "$activeHash" is not an ancestor of branch '
          '"${run.branchId}"\'s head "${branch.headTurnNodeHash}"',
        );
      }
      cursor = node.previousTurnNodeHash;
    }

    // chain was collected head-to-active; reverse it to active-to-head
    // (commit order) before appending.
    final reversedChain = chain.reversed.toList();
    run.createdTurnNodes = [...run.createdTurnNodes, ...reversedChain];
    run.currentStepIndex += reversedChain.length;
    if (run.currentStepIndex > run.stepSequence.length) {
      run.currentStepIndex = run.stepSequence.length;
    }
    backend.updateRun(run);
  }

  /// Appends [node] (whose `previousTurnNodeHash` is set to
  /// [expectedHead] by this call) onto [branchId] as a checkpoint, but
  /// only if [branchId]'s current head still equals [expectedHead] at
  /// commit time -- the kernel's single-writer-per-checkpoint
  /// compare-and-swap. When a second writer's [commitSiblingCheckpoint]
  /// call loses this race, it is rejected with
  /// [errCheckpointLateralConflict] rather than silently overwriting or
  /// stacking behind the winner.
  String commitSiblingCheckpoint(
      String branchId, String expectedHead, TurnNode node) {
    final branch = backend.getBranch(branchId);
    if (branch == null) {
      throw KernelException(_errBranchNotFound, 'branch "$branchId" not found');
    }
    if (branch.headTurnNodeHash != expectedHead) {
      throw KernelException(
        errCheckpointLateralConflict,
        'branch "$branchId"\'s head is "${branch.headTurnNodeHash}", not the expected '
        'base "$expectedHead": a concurrent checkpoint already committed',
      );
    }

    final unhashed = TurnNode(
      hash: '',
      schemaId: node.schemaId,
      turnTreeHash: node.turnTreeHash,
      previousTurnNodeHash: expectedHead,
      eventHash: node.eventHash,
      consumedStagedResults: node.consumedStagedResults,
    );
    final hash = hashRecord(turnNodeIdentityRecord(unhashed));
    final stamped = TurnNode(
      hash: hash,
      schemaId: node.schemaId,
      turnTreeHash: node.turnTreeHash,
      previousTurnNodeHash: expectedHead,
      eventHash: node.eventHash,
      consumedStagedResults: node.consumedStagedResults,
    );

    backend.putTurnNode(stamped);

    // Move the head atomically: compareAndSwapBranchHead only succeeds if
    // branchId's head still equals expectedHead at the moment of the
    // write, closing the read/write race window a get-then-update pair
    // would otherwise leave open.
    final swapped = backend.compareAndSwapBranchHead(
        branchId, expectedHead, hash, clock.nowMs());
    if (!swapped) {
      throw KernelException(
        errCheckpointLateralConflict,
        'branch "$branchId"\'s head is no longer "$expectedHead": a concurrent '
        'checkpoint already committed',
      );
    }
    return hash;
  }

  // --- reclamation (capability kernel.reclamation) ---

  /// Runs the backend's mark-and-sweep reclamation sweep, using [clock]
  /// for the "now" reference the leaseless-run admin-expiry check needs.
  /// Throws [errCapabilityUnsupported] if the backend does not implement
  /// [Reclaimer].
  ReclamationSummary reclaim() {
    if (backend case Reclaimer reclaimer) {
      return reclaimer.reclaim(clock.nowMs());
    }
    throw const KernelException(
      errCapabilityUnsupported,
      'backend does not support maintenance.reclamation',
    );
  }
}

/// How `newHead` relates to a branch's current head when
/// `Kernel.setBranchHead` classifies a head movement (kernel spec §4.2).
/// `Kernel.setBranchHead` handles the "same node" case itself before ever
/// calling `Kernel._classifyHeadMovement`, so only three kinds remain
/// here.
enum _HeadMovement { forward, backward, lateral }

/// The opaque cursor payload `Kernel.listThreads` encodes as an unpadded
/// base64url JSON string, resuming strictly after
/// `(lastCreatedAtMs, lastThreadId)` in the (createdAtMs ASC, threadId
/// ASC) enumeration order.
class _ThreadListCursor {
  const _ThreadListCursor(this.lastCreatedAtMs, this.lastThreadId);

  final int lastCreatedAtMs;
  final String lastThreadId;
}

String _encodeThreadListCursor(_ThreadListCursor cursor) {
  final jsonBytes = utf8.encode(jsonEncode({
    'lastCreatedAtMs': cursor.lastCreatedAtMs,
    'lastThreadId': cursor.lastThreadId,
  }));
  return base64Url.encode(jsonBytes).replaceAll('=', '');
}

_ThreadListCursor _decodeThreadListCursor(String cursor) {
  try {
    var padded = cursor;
    final remainder = padded.length % 4;
    if (remainder != 0) {
      padded += '=' * (4 - remainder);
    }
    final bytes = base64Url.decode(padded);
    final decoded = jsonDecode(utf8.decode(bytes));
    if (decoded is! Map) {
      throw const FormatException('cursor payload is not a JSON object');
    }
    final lastCreatedAtMs = decoded['lastCreatedAtMs'];
    final lastThreadId = decoded['lastThreadId'];
    if (lastCreatedAtMs is! int || lastThreadId is! String) {
      throw const FormatException('cursor payload has unexpected field types');
    }
    return _ThreadListCursor(lastCreatedAtMs, lastThreadId);
  } catch (e) {
    if (e is KernelException) rethrow;
    throw KernelException(
        errInvalidDurableReadCursor, 'malformed thread list cursor: $e');
  }
}
