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

/// The M4 `kernel.scope-isolation` and `kernel.reclamation` operations,
/// mirroring `go/kernel-conformance-adapter/operations_maintenance.go`.
/// Every handler builds its own fresh in-memory [Kernel](s) per dispatch
/// call, matching every other operation in this adapter's per-check
/// isolation. These handlers only project raw observations (see
/// `projection`); the conformance plans
/// (`spec/conformance/kernel/plans/kernel-scope-isolation.json`,
/// `kernel-reclamation.json`) own every pass/fail assertion -- nothing here
/// grades, and nothing here maps a kernel/adapter failure into
/// `$.result.error`.
library;

import 'dart:convert';
import 'dart:math';

import 'package:cryptography/cryptography.dart';
import 'package:tuvren_kernel/tuvren_kernel.dart';

import '../adapter.dart' show projection;
import 'operations_liveness.dart'
    show newManualClockRuntimeKernel, singleStepSequence;
import 'operations_runtime.dart' show canonicalTurnTreeSchema;
import 'support.dart';

// --- kernel.scope-isolation.cross-scope-probe ---

/// Builds two [Kernel]s sharing one [MemoryScopeStore] but bound to two
/// distinct scopes, so a probe can prove a co-tenant scope observes none of
/// the constructing scope's content.
(Kernel, Kernel) _newScopedRuntimeKernelPair() {
  final clock = IncrementingClock();
  final store = MemoryScopeStore();
  final backendA =
      InMemoryBackend.scoped(clock, store, 'tuvren.scope.conformance-a');
  final backendB =
      InMemoryBackend.scoped(clock, store, 'tuvren.scope.conformance-b');
  return (
    Kernel('kernel-conformance-adapter-a', clock, backendA),
    Kernel('kernel-conformance-adapter-b', clock, backendB),
  );
}

bool _threadVisible(List<Thread> threads, String threadId) =>
    threads.any((thread) => thread.threadId == threadId);

/// Constructs two [Kernel]s over two scopes bound to one shared substrate,
/// seeds content and an enumerable thread under scope A, then reports -- as
/// raw observations -- what each scope can see via store-has, store-get,
/// and thread enumeration.
Object? runCrossScopeProbe(Object? input) {
  final (kernelA, kernelB) = _newScopedRuntimeKernelPair();
  kernelA.registerSchema(canonicalTurnTreeSchema());

  final objectHash = kernelA.putObject(
    'application/json',
    utf8.encode('scope-a cross-scope probe content'),
  );
  const threadId = 'scope_probe_thread';
  kernelA.createThread(threadId, 'schema_main', 'scope_probe_branch');

  final sameScopeStoreGetOk = kernelA.backend.getObject(objectHash) != null;
  final crossScopeStoreGetOk = kernelB.backend.getObject(objectHash) != null;

  final (sameScopeThreads, _) = kernelA.listThreads(0, '');
  final (crossScopeThreads, _) = kernelB.listThreads(0, '');

  return projection({
    'enumeration': {
      'sameScopeThreadVisible': _threadVisible(sameScopeThreads, threadId),
      'crossScopeThreadVisible': _threadVisible(crossScopeThreads, threadId),
    },
    'storeGet': {
      'sameScopeReturnsObject': sameScopeStoreGetOk,
      'crossScopeReturnsNull': !crossScopeStoreGetOk,
    },
    'storeHas': {
      'sameScopeObservesOwnContent': kernelA.hasObject(objectHash),
      'crossScopeObservesOtherContent': kernelB.hasObject(objectHash),
    },
  });
}

// --- kernel.reclamation.reclaim-probe ---

/// Constructs the decisive scenarios kernel spec §9.4's mark-and-sweep
/// reclamation must satisfy and reports what it released and retained. Each
/// scenario runs over its own fresh [Kernel] so one scenario's clock or
/// lineage never perturbs another's.
Object? runReclaimProbe(Object? input) {
  final reachability = _observeReclaimReachability();
  final grace = _observeReclaimGraceWindow();
  final leaselessExpired = _observeLeaselessRunPastAdminExpiry();
  final leaselessActive = _observeLeaselessRunWithinAdminExpiry();

  final reclaim = <String, Object?>{}
    ..addAll(reachability)
    ..addAll(grace)
    ..addAll(leaselessExpired)
    ..addAll(leaselessActive);

  return projection({'reclaim': reclaim});
}

/// Proves: (1) an object unreachable from any live root, with no active
/// lease in play, is released past grace; (2) an archive-rollback's
/// exclusive lineage (the abandoned forward segment) is released; (3) the
/// live branch head's own lineage stays retained; (4) a message shared
/// between the kept ancestor and the abandoned forward segment survives via
/// the live root even though its archive-exclusive sibling does not --
/// proving the keep closure is a set-union over live roots, not
/// exclusive-lineage release.
Map<String, Object?> _observeReclaimReachability() {
  final (k, _) = newManualClockRuntimeKernel(0);
  k.registerSchema(canonicalTurnTreeSchema());
  final created =
      k.createThread('thread_reclamation', 'schema_main', 'branch_reclamation');

  final sharedMessage = k.putObject(
      'application/json', utf8.encode('shared-across-live-and-archived'));
  final sharedTree = k.createTurnTree(
    'schema_main',
    {
      'messages': PathValue.ordered([sharedMessage])
    },
    base: created.rootTurnTreeHash,
  );
  final sharedNode = k.commitSiblingCheckpoint(
    'branch_reclamation',
    created.rootTurnNodeHash,
    TurnNode(hash: '', schemaId: 'schema_main', turnTreeHash: sharedTree),
  );

  final archivedOnlyMessage = k.putObject(
      'application/json', utf8.encode('archived-exclusive-payload'));
  final archivedTree = k.createTurnTree(
    'schema_main',
    {
      'messages': PathValue.ordered([sharedMessage, archivedOnlyMessage])
    },
    base: sharedTree,
  );
  final archivedNode = k.commitSiblingCheckpoint(
    'branch_reclamation',
    sharedNode,
    TurnNode(hash: '', schemaId: 'schema_main', turnTreeHash: archivedTree),
  );

  k.setBranchHead('branch_reclamation', sharedNode);

  final orphanObjectHash = k.putObject(
      'application/octet-stream', utf8.encode('unreachable-orphan'));

  k.reclaim();

  final sharedNodeRetained = k.backend.getTurnNode(sharedNode) != null;
  final archivedNodeReleased = k.backend.getTurnNode(archivedNode) == null;

  return {
    'unreachablePastGraceReleased': !k.hasObject(orphanObjectHash),
    'archivedBranchReleased':
        !k.hasObject(archivedOnlyMessage) && archivedNodeReleased,
    'reachableFromLiveRootRetained':
        k.hasObject(sharedMessage) && sharedNodeRetained,
    'sharedObjectRetainedViaLiveRoot': k.hasObject(sharedMessage) &&
        !k.hasObject(archivedOnlyMessage) &&
        archivedNodeReleased,
  };
}

/// Proves the grace horizon is the oldest active execution lease: an orphan
/// created before the horizon is released, one created after it is retained
/// even though both are equally unreachable.
Map<String, Object?> _observeReclaimGraceWindow() {
  final (k, clock) = newManualClockRuntimeKernel(0);
  k.registerSchema(canonicalTurnTreeSchema());

  clock.setMs(10);
  final orphanBeforeLease = k.putObject('application/octet-stream', const [1]);

  clock.setMs(20);
  final created = k.createThread('thread_grace', 'schema_main', 'branch_grace');
  k.createRun(
    'run_grace',
    'turn_grace',
    'branch_grace',
    'schema_main',
    created.rootTurnNodeHash,
    singleStepSequence(),
  );

  clock.setMs(30);
  final orphanAfterLease = k.putObject('application/octet-stream', const [2]);

  clock.setMs(40);
  k.reclaim();

  return {
    'graceWindowHeldUnderActiveLease':
        !k.hasObject(orphanBeforeLease) && k.hasObject(orphanAfterLease),
  };
}

/// Proves a leaseless (no execution lease ever acquired) running run whose
/// creator has effectively crashed stops pinning the grace horizon once it
/// has gone quiet past the 24h admin-expiry window (ADR-050/ADR-051), so a
/// later orphan becomes reclaimable.
Map<String, Object?> _observeLeaselessRunPastAdminExpiry() {
  final (k, clock) = newManualClockRuntimeKernel(0);
  k.registerSchema(canonicalTurnTreeSchema());
  final created = k.createThread(
      'thread_leaseless_expired', 'schema_main', 'branch_leaseless_expired');
  k.createRun(
    'run_leaseless_expired',
    'turn_leaseless_expired',
    'branch_leaseless_expired',
    'schema_main',
    created.rootTurnNodeHash,
    singleStepSequence(),
  );

  clock.setMs(10);
  final orphan = k.putObject(
      'application/octet-stream', utf8.encode('leaseless-expiry-orphan'));

  clock.setMs(leaselessRunExpiryMs + 5000);
  k.reclaim();

  return {
    'leaselessRunPastAdminExpiryDoesNotPinReclamation': !k.hasObject(orphan),
  };
}

/// The mirror-image control: the same leaseless running run shape, but
/// reclaimed well within the 24h horizon, still pins reclamation so the
/// later orphan stays retained.
Map<String, Object?> _observeLeaselessRunWithinAdminExpiry() {
  final (k, clock) = newManualClockRuntimeKernel(0);
  k.registerSchema(canonicalTurnTreeSchema());
  final created = k.createThread(
      'thread_leaseless_active', 'schema_main', 'branch_leaseless_active');
  k.createRun(
    'run_leaseless_active',
    'turn_leaseless_active',
    'branch_leaseless_active',
    'schema_main',
    created.rootTurnNodeHash,
    singleStepSequence(),
  );

  clock.setMs(10);
  final orphan = k.putObject(
      'application/octet-stream', utf8.encode('leaseless-active-orphan'));

  clock.setMs(1000);
  k.reclaim();

  return {
    'leaselessRunWithinAdminExpiryStillPinsReclamation': k.hasObject(orphan),
  };
}

// --- kernel.reclamation.erasure-probe ---

final AesGcm _aesGcm = AesGcm.with256bits();

/// AES-256-GCM-encrypts [plaintext] under [key], returning `nonce ||
/// ciphertext || tag` as a single opaque envelope. This is the adapter
/// playing the host/edge role kernel spec §9.4's erasure rationale
/// describes: the kernel itself never sees a key or plaintext, only the
/// opaque envelope bytes this function returns.
Future<List<int>> _aesGcmEnvelope(List<int> key, List<int> plaintext) async {
  final secretBox = await _aesGcm.encrypt(plaintext, secretKey: SecretKey(key));
  return [...secretBox.nonce, ...secretBox.cipherText, ...secretBox.mac.bytes];
}

/// Decrypts an [_aesGcmEnvelope]-produced envelope under [key], throwing if
/// [key] is wrong/absent (the crypto-shredding "erased" outcome) or the
/// envelope is malformed/short.
Future<List<int>> _aesGcmOpen(List<int> key, List<int> envelope) async {
  final nonceLength = _aesGcm.nonceLength;
  final macLength = _aesGcm.macAlgorithm.macLength;
  if (envelope.length < nonceLength + macLength) {
    throw const FormatException(
        'erasure probe: envelope shorter than nonce+mac');
  }
  final nonce = envelope.sublist(0, nonceLength);
  final cipherText = envelope.sublist(nonceLength, envelope.length - macLength);
  final mac = Mac(envelope.sublist(envelope.length - macLength));
  final secretBox = SecretBox(cipherText, nonce: nonce, mac: mac);
  return _aesGcm.decrypt(secretBox, secretKey: SecretKey(key));
}

/// Plays the §4.17/§9.4 host role: it owns a payload codec and the key,
/// encrypts at the edge, and hands the kernel only the opaque ciphertext
/// envelope as a message object incorporated into the branch head's turn
/// tree. "Erasure" is the host destroying the key (dropping it from its own
/// keyring -- the kernel never held it, so nothing kernel-side changes).
/// The probe reports -- as raw observations -- that the payload is
/// recoverable before and unrecoverable after key destruction, while the
/// referencing kernel lineage stays byte/hash-identical.
Future<Object?> runErasureProbe(Object? input) async {
  final (k, _) = newManualClockRuntimeKernel(0);
  k.registerSchema(canonicalTurnTreeSchema());

  final random = Random.secure();
  final key = List<int>.generate(32, (_) => random.nextInt(256));

  // keyring simulates the host's own key store: erasure is dropping the
  // entry, not anything the kernel is ever aware of.
  final keyring = <String, List<int>>{
    'tuvren.scope.conformance-erasure': List.of(key),
  };
  const keyRef = 'tuvren.scope.conformance-erasure';

  final plaintext = utf8.encode('sensitive-untrusted-edge-payload');
  final envelope = await _aesGcmEnvelope(keyring[keyRef]!, plaintext);

  final created =
      k.createThread('thread_erasure', 'schema_main', 'branch_erasure');
  final envelopeHash = k.putObject('application/octet-stream', envelope);
  final tree = k.createTurnTree(
    'schema_main',
    {
      'messages': PathValue.ordered([envelopeHash])
    },
    base: created.rootTurnTreeHash,
  );
  final nodeHash = k.commitSiblingCheckpoint(
    'branch_erasure',
    created.rootTurnNodeHash,
    TurnNode(hash: '', schemaId: 'schema_main', turnTreeHash: tree),
  );

  final branchBefore = k.backend.getBranch('branch_erasure');
  if (branchBefore == null) {
    throw StateError('branch_erasure not found before erasure');
  }
  final nodeBefore = k.backend.getTurnNode(nodeHash);
  if (nodeBefore == null) {
    throw StateError('turn node "$nodeHash" not found before erasure');
  }

  final storedBefore = k.backend.getObject(envelopeHash);
  bool recoverableBeforeErasure;
  try {
    final decryptedBefore =
        await _aesGcmOpen(keyring[keyRef]!, storedBefore!.bytes);
    recoverableBeforeErasure = bytesEqual(decryptedBefore, plaintext);
  } catch (_) {
    recoverableBeforeErasure = false;
  }

  // -- Crypto-shredding erasure: the host destroys the key. --
  keyring.remove(keyRef);
  // Shred the key material itself, not just the keyring entry referencing
  // it: keyring[keyRef] and key were built from independent copies above,
  // but zero key here too so no live copy of the real key bytes survives
  // anywhere this probe holds a reference to it.
  for (var i = 0; i < key.length; i++) {
    key[i] = 0;
  }

  final storedAfter = k.backend.getObject(envelopeHash);
  // Attempt a genuine AES-GCM open against the stored ciphertext bytes
  // using whatever key material remains (the now-zeroed key list, still the
  // correct AES-256 length). This reaches real GCM tag verification and
  // fails there -- a wrong-key authentication failure against actual
  // ciphertext -- rather than short-circuiting early on an absent/wrong-
  // length key.
  var unrecoverableAfterErasure = false;
  try {
    await _aesGcmOpen(key, storedAfter!.bytes);
  } catch (_) {
    unrecoverableAfterErasure = true;
  }

  final branchAfter = k.backend.getBranch('branch_erasure');
  if (branchAfter == null) {
    throw StateError('branch_erasure not found after erasure');
  }
  final nodeAfter = k.backend.getTurnNode(nodeHash);
  if (nodeAfter == null) {
    throw StateError('turn node "$nodeHash" not found after erasure');
  }

  var manifestReferencesEnvelope = false;
  final treeAfter = k.backend.getTurnTree(nodeAfter.turnTreeHash);
  if (treeAfter != null) {
    final ordered = treeAfter.manifest['messages']?.ordered ?? const <String>[];
    manifestReferencesEnvelope = ordered.contains(envelopeHash);
  }

  final lineageStructurallyIntactAfterErasure =
      branchAfter.headTurnNodeHash == branchBefore.headTurnNodeHash &&
          nodeAfter.turnTreeHash == nodeBefore.turnTreeHash &&
          manifestReferencesEnvelope &&
          bytesEqual(storedAfter!.bytes, envelope);

  return projection({
    'erasure': {
      'recoverableBeforeErasure': recoverableBeforeErasure,
      'unrecoverableAfterErasure': unrecoverableAfterErasure,
      'lineageStructurallyIntactAfterErasure':
          lineageStructurallyIntactAfterErasure,
    },
  });
}
