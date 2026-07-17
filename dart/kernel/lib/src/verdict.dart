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

/// Verdict composition, mirroring `go/kernel/verdict.go`.
library;

import 'record.dart';

/// Verdict kinds, per `docs/KrakenKernelSpecification.md` §6.1 and the CDDL
/// `verdict` union in `spec/kernel/cddl/kernel-records.cddl`.
const String verdictKindProceed = 'proceed';
const String verdictKindAbort = 'abort';
const String verdictKindModify = 'modify';
const String verdictKindPause = 'pause';
const String verdictKindRetry = 'retry';

/// A flat union over the five kernel verdict variants. Only the fields
/// relevant to [kind] are meaningful; this mirrors the CDDL's five disjoint
/// object shapes without needing a Dart-level sum type for a surface this
/// small. Mirrors `go/kernel/verdict.go`'s `Verdict` struct.
class Verdict {
  const Verdict({
    required this.kind,
    this.disposition,
    this.reason,
    this.transform,
    this.resumptionSchema,
    this.adjustment,
  });

  final String kind;

  /// Abort.
  final String? disposition;

  /// Abort's failure reason, or Pause's reason for pausing.
  final String? reason;

  /// Modify. The CDDL's `modify-verdict` requires this field, but
  /// [composeVerdicts] tolerates a null transform on a [verdictKindModify]
  /// verdict, composing it as [RecordNull], mirroring `go/kernel/verdict.go`
  /// where `Transform` is a plain `Record` interface value that can be nil.
  final Record? transform;

  /// Pause.
  final Record? resumptionSchema;

  /// Retry.
  final Record? adjustment;
}

/// Implements the kernel spec's §6.2 composition rule:
///
///     Abort > Pause > Modify > Retry > Proceed
///
/// First-objection-wins: the highest-priority verdict kind present in
/// [verdicts] wins, and the first verdict of that kind (in input order) is
/// returned -- except Modify, where §6.1 states "the kernel composes
/// multiple transforms in registration order": when more than one Modify
/// verdict is present (and no Abort or Pause outranks it), every Modify
/// transform is collected in input order into a single composed Modify
/// verdict whose transform is that ordered array.
///
/// A [Verdict] whose [Verdict.kind] is not one of the five known kinds is a
/// composition error, not a silently-ignored input: the cross-language
/// policy is that record ingestion rejects unknown shapes rather than
/// degrading unnoticed, and a verdict of an unrecognized kind is exactly
/// that kind of malformed input -- this throws a [FormatException], mirroring
/// `go/kernel/verdict.go`'s `ComposeVerdicts`, which returns a plain
/// (untyped, code-less) error for this case rather than a coded
/// [KernelException].
Verdict composeVerdicts(List<Verdict> verdicts) {
  Verdict? abort;
  Verdict? pause;
  Verdict? retry;
  final modifyTransforms = <Record>[];

  for (final verdict in verdicts) {
    switch (verdict.kind) {
      case verdictKindAbort:
        abort ??= verdict;
      case verdictKindPause:
        pause ??= verdict;
      case verdictKindModify:
        // A transform-less modify verdict composes as RecordNull(), the
        // closest Dart analogue of Go's nil Record slot (go/kernel/verdict.go:84).
        modifyTransforms.add(verdict.transform ?? const RecordNull());
      case verdictKindRetry:
        retry ??= verdict;
      case verdictKindProceed:
        // Proceed contributes nothing to composition.
        break;
      default:
        throw FormatException(
          'kernel verdict compose: unknown verdict kind "${verdict.kind}"',
        );
    }
  }

  Verdict? modify;
  if (modifyTransforms.length == 1) {
    modify = Verdict(kind: verdictKindModify, transform: modifyTransforms[0]);
  } else if (modifyTransforms.length > 1) {
    modify = Verdict(
      kind: verdictKindModify,
      transform: RecordArray(modifyTransforms),
    );
  }

  for (final candidate in [abort, pause, modify, retry]) {
    if (candidate != null) return candidate;
  }

  return const Verdict(kind: verdictKindProceed);
}
