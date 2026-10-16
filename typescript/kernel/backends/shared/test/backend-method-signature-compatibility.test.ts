/**
 * Copyright 2026 Oscar Yáñez Cisterna (@SkrOYC)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { expect, test } from "bun:test";

import type {
  BackendInvariantRecordUtils,
  ValidationHelpers,
} from "@tuvren/backend-shared";

type NarrowBytes = Uint8Array & { readonly consumerBrand: unique symbol };
type NarrowHash = string & { readonly verifiedHashBrand: unique symbol };
declare const narrowHashValidator: (hash: NarrowHash) => string;

interface NarrowConsumer {
  // oxlint-disable-next-line typescript/method-signature-style -- This fixture proves the historical narrower consumer method specialization.
  areBytesEqual(left: NarrowBytes, right: NarrowBytes): boolean;
}

const verifyValidationHelpersVariance = (): void => {
  const validationHelpers: Pick<ValidationHelpers, "validateHashString"> = {
    // @ts-expect-error Function properties stay contravariant under strictFunctionTypes.
    validateHashString: narrowHashValidator,
  };
  void validationHelpers;
};
void verifyValidationHelpersVariance;

test("published method signatures preserve narrower consumer specialization", () => {
  const narrowConsumer: NarrowConsumer = {
    areBytesEqual(left: NarrowBytes, right: NarrowBytes): boolean {
      return left === right;
    },
  };
  const publishedConsumer: Pick<BackendInvariantRecordUtils, "areBytesEqual"> =
    narrowConsumer;

  expect(publishedConsumer).toBe(narrowConsumer);
});
