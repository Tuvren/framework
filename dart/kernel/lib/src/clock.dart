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

/// The kernel runtime's time seam, mirroring `go/kernel/runtime.go`'s
/// `Clock` family. Injected at [Backend]/`Kernel` construction so later
/// milestones (leases, reclamation, time-based recovery windows) can
/// substitute deterministic clocks in tests without the runtime kernel
/// depending on wall-clock time directly.
library;

/// Supplies the current time in epoch milliseconds.
abstract class Clock {
  int nowMs();
}

/// The production [Clock]: wall-clock time via `DateTime.now()`.
final class SystemClock implements Clock {
  const SystemClock();

  @override
  int nowMs() => DateTime.now().millisecondsSinceEpoch;
}

/// A test [Clock] that always returns the same instant.
final class FixedClock implements Clock {
  const FixedClock(this.ms);

  final int ms;

  @override
  int nowMs() => ms;
}

/// A test [Clock] that advances by one millisecond on every read, so
/// callers that need strictly-increasing timestamps (for example to
/// exercise createdAtMs-ordered enumeration without relying on wall-clock
/// granularity) get a deterministic, monotonically increasing sequence
/// starting just above [ms].
final class IncrementingClock implements Clock {
  IncrementingClock([this.ms = 0]);

  int ms;

  @override
  int nowMs() => ++ms;
}

/// A test [Clock] a caller advances explicitly via [setMs], letting a
/// scenario pin exact timestamps (for example a lease's acquire and renew
/// instants) instead of relying on wall-clock or auto-increment behavior.
final class ManualClock implements Clock {
  ManualClock(this._ms);

  int _ms;

  @override
  int nowMs() => _ms;

  /// Advances (or otherwise sets) the clock's current reading.
  void setMs(int ms) => _ms = ms;
}
