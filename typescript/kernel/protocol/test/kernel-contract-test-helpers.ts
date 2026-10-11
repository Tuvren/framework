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

export const restorePrototypeValue = (
  target: object,
  key: PropertyKey,
  hadOwn: boolean,
  originalValue: unknown
): void => {
  if (hadOwn) {
    Reflect.set(target, key, originalValue);
    return;
  }

  Reflect.deleteProperty(target, key);
};

/** Returns a rejected Error so assertions run after the operation settles. */
export const rejectionOf = async (
  operation: Promise<unknown>
): Promise<Error> => {
  try {
    await operation;
  } catch (error: unknown) {
    if (error instanceof Error) {
      return error;
    }
    throw new Error("Expected the operation to reject with an Error", {
      cause: error,
    });
  }
  throw new Error("Expected the operation to reject");
};
