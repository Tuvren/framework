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

/// Tuvren kernel runtime authority for the Dart port.
///
/// The authority for what this package must implement is
/// `spec/kernel/authority-packet.json`, the CDDL grammar in
/// `spec/kernel/cddl/kernel-records.cddl`, and the kernel conformance plans
/// under `spec/conformance/kernel/plans/`; this tree is a binding
/// projection, never an authority source.
///
/// This library re-exports the protocol layer under `src/`: the
/// [maxSafeInteger]/[minSafeInteger] bounds and closed [Record] sum type
/// (`src/record.dart`), the [KernelException] error surface (`src/errors.dart`),
/// canonical CBOR codec (`src/cbor.dart`), content-addressing hashes
/// (`src/identity.dart`), CDDL record validation (`src/validate.dart`), and
/// verdict composition (`src/verdict.dart`). Every one of those files
/// mirrors its `go/kernel/*.go` counterpart byte-for-byte where the two
/// languages' semantics allow it.
///
/// It also re-exports the M2/M3/M4 runtime layer: the [Clock] family
/// (`src/clock.dart`), the storage vocabulary and [Backend] seam
/// (`src/backend.dart`), the in-memory [Backend] implementation
/// (`src/memory_backend.dart`), the capability-gated reclamation sweep
/// (`src/reclamation.dart`), the fault-injection decorator
/// (`src/fault_injecting_backend.dart`), and the runtime kernel host
/// itself, including run-liveness leases (`src/kernel_runtime.dart`, whose
/// `part` `src/lease.dart` is not exported separately since Dart `part`
/// files share their library's export surface automatically).
library;

export 'src/backend.dart';
export 'src/cbor.dart';
export 'src/clock.dart';
export 'src/errors.dart';
export 'src/fault_injecting_backend.dart';
export 'src/identity.dart';
export 'src/kernel_runtime.dart';
export 'src/memory_backend.dart';
export 'src/reclamation.dart';
export 'src/record.dart';
export 'src/validate.dart';
export 'src/verdict.dart';
