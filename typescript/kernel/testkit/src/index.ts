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
 * Shared conformance/invariant/recovery test suites and fixtures for
 * `RuntimeBackend` implementations.
 *
 * {@link registerBackendConformanceSuite}, {@link registerBackendInvariantSuite},
 * and {@link registerBackendRecoverySuite} each register a battery of test
 * cases against a {@link BackendTestSuiteApi} (a thin shim over the calling
 * package's own test framework), exercising a fresh backend from
 * {@link BackendFactory} per case. Any `RuntimeBackend` implementation that
 * passes all three suites upholds the same transactional, referential, and
 * lineage invariants as the reference (memory) backend.
 *
 * {@link createFaultInjectingBackend} wraps a `RuntimeBackend` so its next
 * matching transaction fails at a chosen {@link FaultPoint} per a
 * {@link FaultPlan}, for exercising crash-recovery behavior.
 *
 * {@link selectKernelMutant} selects one test-only negative-control mutant
 * (ADR-0079) that wraps the reference backend, kernel, codec, or fault seam
 * and records its activation. Production packages must never import it.
 *
 * The `create*` and `delay` exports from `kernel-test-fixtures.js` build
 * canonical `Stored*` records and small deterministic helpers (hash
 * sequences, incrementing clocks) shared across the suites and available to
 * package-local tests.
 */

export { registerBackendConformanceSuite } from "./lib/backend-conformance-suite.js";
export { registerBackendInvariantSuite } from "./lib/backend-invariant-suite.js";
export { registerBackendRecoverySuite } from "./lib/backend-recovery-suite.js";
export type {
  BackendConformanceSuiteOptions,
  BackendFactory,
  BackendTestSuiteApi,
} from "./lib/backend-test-suite-types.js";
export type { PhaseStats, TimingStats } from "./lib/bench-phase-stats.js";
export {
  formatNs,
  formatPhaseTable,
  percentile,
  readSampleCountFromEnv,
  summarizePhases,
} from "./lib/bench-phase-stats.js";
export type { FaultPlan, FaultPoint } from "./lib/fault-injecting-backend.js";
export { createFaultInjectingBackend } from "./lib/fault-injecting-backend.js";
export {
  listKernelMutants,
  selectKernelMutant,
} from "./lib/kernel-mutant-registry.js";
export type {
  FaultInjectingBackendFactory,
  KernelMutantActivation,
  KernelMutantBackendContext,
  KernelMutantCodec,
  KernelMutantKernel,
  KernelMutantKind,
  KernelMutantSeamName,
  KernelMutantSummary,
  SelectedKernelMutant,
} from "./lib/kernel-mutant-types.js";
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
