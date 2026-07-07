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

// biome-ignore-all lint/performance/noBarrelFile: This package subpath is the intentional focused contract surface.
// biome-ignore-all assist/source/organizeImports: The organizer merges the one-export-per-statement layout back into a grouped export, which would strip the per-export @experimental release tags ADR-056 requires.

/**
 * `@tuvren/core/capabilities` — the advanced capability-orchestration contract
 * surface (ADR-046/ADR-047).
 *
 * **Experimental subpath (ADR-056, PRD CAP-P0-070):** every export below is
 * still settling and carries an individual `@experimental` TSDoc release tag.
 * The whole subpath is declared experimental, so an untagged export here is a
 * defect, not a stable promotion (ADR-056 consistency floor). Signatures may
 * change without a major version until an export graduates by losing its tag;
 * the import path itself is stable through graduation.
 *
 * @packageDocumentation
 */

// Re-export from the core lib so this module owns the canonical declaration.
// One export per statement so each carries its own @experimental release tag
// (ADR-056 §3: tags on individual exports are the canonical marker the
// freeze/diff gate reads).

/** @experimental */
export type { AttachedClientEndpoint } from "../lib/capability-shapes.js";
/** @experimental */
export type { Binding } from "../lib/capability-shapes.js";
/** @experimental */
export type { Capability } from "../lib/capability-shapes.js";
/** @experimental */
export type { CapabilityInvocationAttribution } from "../lib/capability-shapes.js";
/** @experimental */
export type { CapabilityObservation } from "../lib/capability-shapes.js";
/** @experimental */
export type { CapabilityPolicyContext } from "../lib/capability-shapes.js";
/** @experimental */
export type { CapabilityPolicyEngine } from "../lib/capability-shapes.js";
/** @experimental */
export type { ClientDispatchResult } from "../lib/capability-shapes.js";
/** @experimental */
export type { ClientEndpointBoundary } from "../lib/capability-shapes.js";
/** @experimental */
export type { ClientEndpointCapabilityAdvertisement } from "../lib/capability-shapes.js";
/** @experimental */
export type { ClientInvocationEnvelope } from "../lib/capability-shapes.js";
/** @experimental */
export type { ClientReportedResult } from "../lib/capability-shapes.js";
/** @experimental */
export type { Endpoint } from "../lib/capability-shapes.js";
/** @experimental */
export type { EndpointKind } from "../lib/capability-shapes.js";
/** @experimental */
export type { ExecutionClass } from "../lib/capability-shapes.js";
/** @experimental */
export type { ExposureDecision } from "../lib/capability-shapes.js";
/** @experimental */
export type { InvocationDecision } from "../lib/capability-shapes.js";
/** @experimental */
export type { InvocationLifecycleState } from "../lib/capability-shapes.js";
/** @experimental */
export type { InvocationOwner } from "../lib/capability-shapes.js";
/** @experimental */
export type { PolicyCapabilityMetadata } from "../lib/capability-shapes.js";
/** @experimental */
export type { ToolSurface } from "../lib/capability-shapes.js";
/** @experimental */
export type { TuvrenSandboxExecutor } from "../lib/capability-shapes.js";
