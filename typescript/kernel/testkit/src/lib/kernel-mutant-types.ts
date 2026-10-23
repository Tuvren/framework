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

import type { HashString, KernelRecord } from "@tuvren/core";
import type {
  RuntimeBackend,
  RuntimeKernel,
  RuntimeKernelRunLiveness,
} from "@tuvren/kernel-protocol";

import type { FaultPlan } from "./fault-injecting-backend.js";

/** ADR-0079 negative-control kinds. */
export type KernelMutantKind =
  | "implementation"
  | "instrumentation"
  | "observation";

/** Reference-implementation functions a conformance adapter calls directly. */
export interface KernelMutantCodec {
  decodeDeterministicKernelRecord: (bytes: Uint8Array) => KernelRecord;
  hashOpaqueObjectBytes: (bytes: Uint8Array) => Promise<HashString>;
}

export type KernelMutantKernel = RuntimeKernel & RuntimeKernelRunLiveness;

export interface KernelMutantBackendContext {
  /** Identity shared by every backend bound to one storage substrate. */
  readonly substrate?: object;
}

export type FaultInjectingBackendFactory = (
  inner: RuntimeBackend,
  plan: FaultPlan
) => RuntimeBackend;

export type KernelMutantActivate = () => void;

export interface KernelMutantSeams {
  readonly backend?: (
    backend: RuntimeBackend,
    context: KernelMutantBackendContext,
    activate: KernelMutantActivate
  ) => RuntimeBackend;
  readonly codec?: (
    codec: KernelMutantCodec,
    activate: KernelMutantActivate
  ) => KernelMutantCodec;
  readonly faultInjection?: (
    factory: FaultInjectingBackendFactory,
    activate: KernelMutantActivate
  ) => FaultInjectingBackendFactory;
  readonly kernel?: (
    kernel: KernelMutantKernel,
    backend: RuntimeBackend,
    activate: KernelMutantActivate
  ) => KernelMutantKernel;
}

export type KernelMutantSeamName = keyof KernelMutantSeams;

export interface KernelMutantDefinition {
  /** Builds fresh seams, so per-selection state never leaks between runs. */
  readonly createSeams: () => KernelMutantSeams;
  readonly kind: KernelMutantKind;
  readonly mutantId: string;
  readonly signal: string;
}

export interface KernelMutantSummary {
  readonly kind: KernelMutantKind;
  readonly mutantId: string;
  readonly signal: string;
}

/** Mutant activation: proof that the mutated branch executed (ADR-0079 §3). */
export interface KernelMutantActivation extends KernelMutantSummary {
  readonly activated: boolean;
  readonly activationCount: number;
}

/**
 * One selected mutant with its own activation counter. Every `wrap*` method
 * returns its argument unchanged unless this mutant mutates that seam.
 */
export interface SelectedKernelMutant extends KernelMutantSummary {
  readonly readActivation: () => KernelMutantActivation;
  readonly seams: readonly KernelMutantSeamName[];
  readonly wrapBackend: (
    backend: RuntimeBackend,
    context?: KernelMutantBackendContext
  ) => RuntimeBackend;
  readonly wrapCodec: (codec: KernelMutantCodec) => KernelMutantCodec;
  readonly wrapFaultInjection: (
    factory: FaultInjectingBackendFactory
  ) => FaultInjectingBackendFactory;
  readonly wrapKernel: (
    kernel: KernelMutantKernel,
    backend: RuntimeBackend
  ) => KernelMutantKernel;
}
