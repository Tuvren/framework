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

/**
 * Maps one item per consumer pull, preserving effect order and stopping on
 * early return or rejection without starting later operations.
 * @yields {Awaited<Output>} Each settled mapped value in input order.
 */
export const mapSequential = async function* mapSequential<Input, Output>(
  values: Iterable<Input> | AsyncIterable<Input>,
  map: (value: Input) => Promise<Output>
): AsyncGenerator<Awaited<Output>, void, unknown> {
  for await (const value of values) {
    yield map(value);
  }
};

/**
 * Advances state only when pulled. The generator serializes next calls and
 * delegates cleanup, so returning or throwing never starts another step.
 * @yields {Value} Each value until the step reports the end with null.
 */
export const unfoldAsync = async function* unfoldAsync<State, Value>(
  initial: State,
  step: (state: State) => Promise<{ next: State; value: Value } | null>
): AsyncGenerator<Value, void, unknown> {
  let state = initial;
  const steps: AsyncIterable<Value> = {
    [Symbol.asyncIterator]: () => ({
      next: async (): Promise<IteratorResult<Value, void>> => {
        const result = await step(state);
        if (result === null) {
          return { done: true, value: undefined };
        }
        state = result.next;
        return { done: false, value: result.value };
      },
    }),
  };
  for await (const value of steps) {
    yield value;
  }
};
