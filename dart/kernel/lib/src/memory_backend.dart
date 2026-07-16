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

/// The M2 in-memory [Backend] implementation, mirroring
/// `go/kernel/memory_backend.go` and `go/kernel/json.go`'s
/// `MemoryScopeStore`: a handle bound to one scope's partition of storage,
/// with no persistence and no cross-process sharing. Unlike the Go port,
/// this implementation needs no mutex -- Dart's single-threaded event loop
/// gives every method here the same effective atomicity Go's `sync.Mutex`
/// buys explicitly.
library;

import 'backend.dart';
import 'clock.dart';
import 'identity.dart';
import 'reclamation.dart';
import 'validate.dart';

/// One scope's independent partition of durable storage. Moving this into
/// its own type is what lets [MemoryScopeStore] hold many partitions (one
/// per scope) behind one shared substrate, so two backend handles bound to
/// different scopes but the same store are structurally unable to observe
/// each other's content (kernel spec §2.3 / M4 kernel.scope-isolation),
/// while two handles bound to the *same* scope and store share that
/// scope's committed state.
class _ScopeState {
  final Map<String, StoredObject> objects = {};
  final Map<String, TurnTreeSchema> schemas = {};
  final Map<String, TurnTree> trees = {};
  final Map<String, TurnNode> nodes = {};
  final Map<String, Thread> threads = {};
  final Map<String, Branch> branches = {};
  final Map<String, Run> runs = {};

  /// Thread-root turn node hash -> owning threadId, so [InMemoryBackend.putThread]
  /// can populate it and `Kernel.createThread` can consult
  /// [InMemoryBackend.getThreadByRootTurnNode] before publishing a thread
  /// whose genesis node hash was already claimed.
  final Map<String, String> rootOwners = {};

  /// A turn node's `previousTurnNodeHash` -> the hashes of every node
  /// stored with that previous hash, so `listChildTurnNodes` can find a
  /// durable node forward from its parent even when no branch head
  /// references it yet.
  final Map<String, List<String>> childrenByPrevious = {};

  final Map<String, List<StagedResult>> stagedByRun = {};
}

/// A shared in-memory substrate keyed by scope: each scope owns an
/// independent [_ScopeState], created lazily on first use. Constructing
/// several [InMemoryBackend] handles against one shared [MemoryScopeStore]
/// with different scope strings gives each handle a structurally isolated
/// partition.
class MemoryScopeStore {
  final Map<String, _ScopeState> _states = {};

  _ScopeState _state(String scope) =>
      _states.putIfAbsent(scope, () => _ScopeState());
}

/// The scope an [InMemoryBackend] constructed via the unscoped constructor
/// binds to: single-scope callers never see or reason about scope
/// identity at all.
const String defaultScope = 'tuvren.scope.default';

/// The M2 in-memory [Backend] implementation: a handle bound to one
/// scope's partition of a [MemoryScopeStore].
class InMemoryBackend implements Backend, Reclaimer {
  /// Constructs an empty in-memory backend, bound to its own private
  /// single-scope store, using [clock] for every timestamp it records.
  InMemoryBackend([Clock? clock])
    : clock = clock ?? const SystemClock(),
      _store = MemoryScopeStore(),
      _scope = defaultScope;

  /// Binds a backend handle to [scope] within [store], a
  /// [MemoryScopeStore] possibly shared with other handles bound to other
  /// scopes. Two handles constructed this way against the same store but
  /// different scope strings are isolated by construction (kernel spec
  /// §2.3): neither can observe the other's objects, trees, nodes,
  /// schemas, threads, branches, runs, or staged results. Two handles
  /// bound to the same store and the same scope share that scope's
  /// committed state.
  InMemoryBackend.scoped(Clock? clock, MemoryScopeStore store, String scope)
    : clock = clock ?? const SystemClock(),
      _store = store,
      _scope = scope;

  @override
  final Clock clock;

  final MemoryScopeStore _store;
  final String _scope;

  _ScopeState get _state => _store._state(_scope);

  @override
  StoredObject putObject(String mediaType, List<int> data) {
    final st = _state;
    final hash = hashBytesToHex(data);
    final existing = st.objects[hash];
    if (existing != null) return existing;
    final stored = StoredObject(
      hash: hash,
      mediaType: mediaType,
      bytes: data,
      createdAtMs: clock.nowMs(),
    );
    st.objects[hash] = stored;
    return stored;
  }

  @override
  StoredObject? getObject(String hash) => _state.objects[hash];

  @override
  bool hasObject(String hash) => _state.objects.containsKey(hash);

  @override
  bool putSchema(TurnTreeSchema schema) {
    final st = _state;
    if (st.schemas.containsKey(schema.schemaId)) return false;
    st.schemas[schema.schemaId] = schema;
    return true;
  }

  @override
  TurnTreeSchema? getSchema(String schemaId) => _state.schemas[schemaId];

  @override
  void putTurnTree(TurnTree tree) {
    final st = _state;
    tree.createdAtMs = clock.nowMs();
    st.trees[tree.hash] = tree;
  }

  @override
  TurnTree? getTurnTree(String hash) => _state.trees[hash]?.clone();

  @override
  void putTurnNode(TurnNode node) {
    final st = _state;
    final stored = TurnNode(
      hash: node.hash,
      schemaId: node.schemaId,
      turnTreeHash: node.turnTreeHash,
      previousTurnNodeHash: node.previousTurnNodeHash,
      eventHash: node.eventHash,
      consumedStagedResults: node.consumedStagedResults,
      createdAtMs: clock.nowMs(),
    );
    st.nodes[node.hash] = stored;
    (st.childrenByPrevious[node.previousTurnNodeHash] ??= []).add(node.hash);
  }

  @override
  List<TurnNode> listChildTurnNodes(String previousHash) {
    final st = _state;
    final hashes = st.childrenByPrevious[previousHash] ?? const [];
    return [
      for (final hash in hashes)
        if (st.nodes[hash] case final node?) node.clone(),
    ];
  }

  @override
  TurnNode? getTurnNode(String hash) => _state.nodes[hash]?.clone();

  @override
  bool putThread(Thread thread) {
    final st = _state;
    if (st.threads.containsKey(thread.threadId)) return false;
    st.threads[thread.threadId] = thread;
    st.rootOwners[thread.rootTurnNodeHash] = thread.threadId;
    return true;
  }

  @override
  Thread? getThread(String threadId) => _state.threads[threadId];

  @override
  String? getThreadByRootTurnNode(String rootTurnNodeHash) =>
      _state.rootOwners[rootTurnNodeHash];

  @override
  List<Thread> listThreads() => List.of(_state.threads.values);

  @override
  bool putBranch(Branch branch) {
    final st = _state;
    if (st.branches.containsKey(branch.branchId)) return false;
    // Store an independent copy, not the caller's own (mutable) instance:
    // mirrors Go's by-value struct semantics, where `st.branches[id] =
    // branch` already copies. Without this, a caller mutating the Branch
    // object it just constructed and passed in (or one this backend later
    // hands back via getBranch/listBranchesByThread) would alias directly
    // into stored state, bypassing updateBranchHead/compareAndSwapBranchHead
    // entirely.
    st.branches[branch.branchId] = branch.clone();
    return true;
  }

  @override
  Branch? getBranch(String branchId) => _state.branches[branchId]?.clone();

  @override
  List<Branch> listBranchesByThread(String threadId) => [
    for (final branch in _state.branches.values)
      if (branch.threadId == threadId) branch.clone(),
  ];

  @override
  bool updateBranchHead(
    String branchId,
    String headTurnNodeHash,
    int updatedAtMs,
  ) {
    final st = _state;
    final branch = st.branches[branchId];
    if (branch == null) return false;
    branch.headTurnNodeHash = headTurnNodeHash;
    branch.updatedAtMs = updatedAtMs;
    return true;
  }

  @override
  bool compareAndSwapBranchHead(
    String branchId,
    String expectedHead,
    String newHead,
    int updatedAtMs,
  ) {
    final st = _state;
    final branch = st.branches[branchId];
    if (branch == null) return false;
    if (branch.headTurnNodeHash != expectedHead) return false;
    branch.headTurnNodeHash = newHead;
    branch.updatedAtMs = updatedAtMs;
    return true;
  }

  @override
  bool putRun(Run run) {
    final st = _state;
    if (st.runs.containsKey(run.runId)) return false;
    final now = clock.nowMs();
    st.runs[run.runId] = _stampRun(run, createdAtMs: now, updatedAtMs: now);
    return true;
  }

  @override
  Run? getRun(String runId) => _state.runs[runId]?.clone();

  @override
  bool updateRun(Run run) {
    final st = _state;
    final existing = st.runs[run.runId];
    if (existing == null) return false;
    st.runs[run.runId] = _stampRun(
      run,
      createdAtMs: existing.createdAtMs,
      updatedAtMs: clock.nowMs(),
    );
    return true;
  }

  /// Builds a stored copy of [run] with [createdAtMs]/[updatedAtMs]
  /// authoritatively set by the backend, mirroring how
  /// `go/kernel/memory_backend.go`'s `PutRun`/`UpdateRun` stamp those two
  /// bookkeeping fields themselves rather than trusting the caller's copy.
  Run _stampRun(
    Run run, {
    required int createdAtMs,
    required int updatedAtMs,
  }) => Run(
    runId: run.runId,
    turnId: run.turnId,
    branchId: run.branchId,
    schemaId: run.schemaId,
    startTurnNodeHash: run.startTurnNodeHash,
    status: run.status,
    currentStepIndex: run.currentStepIndex,
    stepSequence: run.stepSequence,
    createdTurnNodes: run.createdTurnNodes,
    threadId: run.threadId,
    pendingCheckpointHash: run.pendingCheckpointHash,
    pendingCheckpointKind: run.pendingCheckpointKind,
    hasLease: run.hasLease,
    leaseOwnerId: run.leaseOwnerId,
    leaseToken: run.leaseToken,
    leaseExpiresAtMs: run.leaseExpiresAtMs,
    preemptionReason: run.preemptionReason,
    createdAtMs: createdAtMs,
    updatedAtMs: updatedAtMs,
  );

  @override
  List<Run> listRunsByBranch(String branchId) => [
    for (final run in _state.runs.values)
      if (run.branchId == branchId) run.clone(),
  ];

  @override
  List<Run> listRuns() => [for (final run in _state.runs.values) run.clone()];

  @override
  void stageResult(String runId, StagedResult result) {
    (_state.stagedByRun[runId] ??= []).add(result);
  }

  @override
  List<StagedResult> drainStagedResults(String runId) {
    final st = _state;
    final drained = st.stagedByRun.remove(runId);
    return drained ?? const [];
  }

  @override
  ReclamationSummary reclaim(int nowMs) {
    final st = _state;
    return reclaimScope(
      runs: st.runs,
      nodes: st.nodes,
      trees: st.trees,
      objects: st.objects,
      branches: st.branches,
      threads: st.threads,
      stagedByRun: st.stagedByRun,
      nowMs: nowMs,
    );
  }
}
