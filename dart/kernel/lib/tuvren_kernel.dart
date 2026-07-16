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
library;

/// Maximum JavaScript-safe integer accepted by kernel records
/// (`js-safe-int` in `spec/kernel/cddl/kernel-records.cddl`).
const int maxSafeInteger = 9007199254740991;

/// Minimum JavaScript-safe integer accepted by kernel records
/// (`js-safe-int` in `spec/kernel/cddl/kernel-records.cddl`).
const int minSafeInteger = -9007199254740991;
