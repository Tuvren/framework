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
  test('js-safe-int bounds match spec/kernel/cddl/kernel-records.cddl', () {
    // js-safe-int = -9007199254740991..9007199254740991 (±(2^53 - 1)).
    expect(maxSafeInteger, 9007199254740991);
    expect(minSafeInteger, -9007199254740991);
    expect(maxSafeInteger, (1 << 53) - 1);
    expect(minSafeInteger, -maxSafeInteger);
  });
}
