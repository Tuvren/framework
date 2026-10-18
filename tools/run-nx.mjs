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

import process from "node:process";

const MIN_NX_MAX_LISTENERS = 64;
/**
 * @typedef {{
 *   getMaxListeners: () => number;
 *   setMaxListeners: (value: number) => void;
 * }} ListenerProcess
 */

/**
 * @param {unknown} value A value crossing the untyped runtime boundary.
 * @returns {unknown} The unchanged value for runtime narrowing.
 */
const toUnknown = (value) => value;

/**
 * @param {unknown} value The runtime value to inspect.
 * @returns {value is ListenerProcess} Whether the value controls listener limits.
 */
const isListenerProcess = (value) =>
  typeof value === "object" &&
  value !== null &&
  "getMaxListeners" in value &&
  typeof value.getMaxListeners === "function" &&
  "setMaxListeners" in value &&
  typeof value.setMaxListeners === "function";

const listenerProcess = toUnknown(process);

if (!isListenerProcess(listenerProcess)) {
  throw new TypeError("The runtime process must support listener limits");
}

if (listenerProcess.getMaxListeners() < MIN_NX_MAX_LISTENERS) {
  // This ceiling contains Nx listener churn while its root cause is traced in
  // the task runner. A future workspace/tooling upgrade can remove the override.
  listenerProcess.setMaxListeners(MIN_NX_MAX_LISTENERS);
}

await import("nx/bin/nx.js");
