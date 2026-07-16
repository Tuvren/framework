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

import 'package:test/test.dart';
import 'package:tuvren_kernel/tuvren_kernel.dart';

void main() {
  test('multiple modifies compose in registration order', () {
    final first = RecordMap({
      'extension': const RecordText('first'),
      'mutation': const RecordText('append-prefix'),
    });
    final second = RecordMap({
      'extension': const RecordText('second'),
      'mutation': const RecordText('append-suffix'),
    });

    final composed = composeVerdicts([
      Verdict(kind: verdictKindModify, transform: first),
      const Verdict(kind: verdictKindProceed),
      Verdict(kind: verdictKindModify, transform: second),
    ]);

    expect(composed.kind, verdictKindModify);
    final transform = composed.transform;
    expect(transform, isA<RecordArray>());
    final elements = (transform as RecordArray).value;
    expect(elements, hasLength(2));
    expect(elements[0], equals(first));
    expect(elements[1], equals(second));
  });

  test('abort outranks everything', () {
    const abort = Verdict(
      kind: verdictKindAbort,
      disposition: 'HardFail',
      reason: 'boom',
    );
    final composed = composeVerdicts([
      const Verdict(kind: verdictKindModify, transform: RecordText('ignored')),
      abort,
      const Verdict(
        kind: verdictKindPause,
        reason: 'also ignored',
        resumptionSchema: RecordNull(),
      ),
    ]);

    expect(composed.kind, verdictKindAbort);
    expect(composed.reason, 'boom');
  });

  test('single modify stays unwrapped (not an array)', () {
    const only = RecordText('solo');
    final composed = composeVerdicts([
      const Verdict(kind: verdictKindProceed),
      const Verdict(kind: verdictKindModify, transform: only),
    ]);

    expect(composed.kind, verdictKindModify);
    expect(composed.transform, equals(only));
  });

  test('empty or all-proceed input yields proceed', () {
    expect(composeVerdicts(const []).kind, verdictKindProceed);

    final composed = composeVerdicts(const [
      Verdict(kind: verdictKindProceed),
      Verdict(kind: verdictKindProceed),
    ]);
    expect(composed.kind, verdictKindProceed);
  });

  test('rejects unknown verdict kind', () {
    expect(
      () => composeVerdicts(const [Verdict(kind: 'not-a-real-verdict-kind')]),
      throwsFormatException,
    );
  });

  test('pause outranks modify, retry, and proceed', () {
    final composed = composeVerdicts([
      const Verdict(kind: verdictKindRetry, adjustment: RecordInt(1)),
      const Verdict(kind: verdictKindModify, transform: RecordText('x')),
      const Verdict(kind: verdictKindProceed),
      const Verdict(
        kind: verdictKindPause,
        reason: 'need approval',
        resumptionSchema: RecordText('z'),
      ),
    ]);
    expect(composed.kind, verdictKindPause);
    expect(composed.reason, 'need approval');
  });

  test('retry outranks proceed', () {
    final composed = composeVerdicts(const [
      Verdict(kind: verdictKindProceed),
      Verdict(kind: verdictKindRetry, adjustment: RecordInt(3)),
    ]);
    expect(composed.kind, verdictKindRetry);
    expect(composed.adjustment, equals(const RecordInt(3)));
  });

  test('a single transform-less modify composes as RecordNull, not a throw',
      () {
    // Regression: go/kernel/verdict.go's Transform field is a plain Record
    // interface value, so a nil transform composes without error there;
    // this pins the same tolerance for Dart's nullable transform field.
    final composed = composeVerdicts(const [
      Verdict(kind: verdictKindModify),
    ]);

    expect(composed.kind, verdictKindModify);
    expect(composed.transform, equals(const RecordNull()));
  });

  test(
      'a transform-less modify composes alongside other modifies without '
      'throwing', () {
    const withTransform = RecordText('has-transform');
    final composed = composeVerdicts(const [
      Verdict(kind: verdictKindModify, transform: withTransform),
      Verdict(kind: verdictKindModify),
    ]);

    expect(composed.kind, verdictKindModify);
    final transform = composed.transform;
    expect(transform, isA<RecordArray>());
    final elements = (transform as RecordArray).value;
    expect(elements, hasLength(2));
    expect(elements[0], equals(withTransform));
    expect(elements[1], equals(const RecordNull()));
  });
}
