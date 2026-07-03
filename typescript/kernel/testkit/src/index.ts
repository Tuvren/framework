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

// biome-ignore-all lint/performance/noBarrelFile: This package entrypoint is the intentional public contract surface.
export { registerBackendConformanceSuite } from "./lib/backend-conformance-suite.js";
export { registerBackendInvariantSuite } from "./lib/backend-invariant-suite.js";
export { registerBackendRecoverySuite } from "./lib/backend-recovery-suite.js";
export type {
  BackendConformanceSuiteOptions,
  BackendFactory,
  BackendTestSuiteApi,
} from "./lib/backend-test-suite-types.js";
export type { FaultPlan, FaultPoint } from "./lib/fault-injecting-backend.js";
export { createFaultInjectingBackend } from "./lib/fault-injecting-backend.js";
export {
  createCanonicalKernelTestSchema,
  createCanonicalTurnTreePaths,
  createHashFromIndex,
  createHashSequence,
  createIncrementingClock,
  createStoredObjectRecord,
  createStoredOrderedPathChunkRecord,
  createStoredSchemaRecord,
  createStoredTurnNodeRecord,
  createStoredTurnTreeRecord,
  delay,
} from "./lib/kernel-test-fixtures.js";
