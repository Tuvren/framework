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

import type {
  KernelMutantDefinition,
  KernelMutantSeamName,
  KernelMutantSummary,
  SelectedKernelMutant,
} from "./kernel-mutant-types.js";
import { PROTOCOL_KERNEL_MUTANTS } from "./kernel-mutants-protocol.js";
import { STORAGE_KERNEL_MUTANTS } from "./kernel-mutants-storage.js";

const KERNEL_MUTANTS: readonly KernelMutantDefinition[] = [
  ...PROTOCOL_KERNEL_MUTANTS,
  ...STORAGE_KERNEL_MUTANTS,
].toSorted((left, right) => left.mutantId.localeCompare(right.mutantId));

const SEAM_NAMES: readonly KernelMutantSeamName[] = [
  "backend",
  "codec",
  "faultInjection",
  "kernel",
];

const summarize = ({
  kind,
  mutantId,
  signal,
}: KernelMutantDefinition): KernelMutantSummary => ({ kind, mutantId, signal });

/** The registered test-only kernel mutants (ADR-0079), ordered by id. */
export const listKernelMutants = (): readonly KernelMutantSummary[] =>
  KERNEL_MUTANTS.map(summarize);

/**
 * Selects one mutant with a fresh activation counter. Only the selected
 * mutant's seams alter what they wrap; every other seam is the identity.
 *
 * @throws {Error} when `mutantId` is not registered.
 */
export const selectKernelMutant = (mutantId: string): SelectedKernelMutant => {
  const definition = KERNEL_MUTANTS.find(
    (candidate) => candidate.mutantId === mutantId
  );
  if (definition === undefined) {
    throw new Error(`unknown kernel mutant ${mutantId}`);
  }

  const summary = summarize(definition);
  const seams = definition.createSeams();
  let activationCount = 0;
  const activate = (): void => {
    activationCount += 1;
  };

  return Object.freeze({
    ...summary,
    readActivation: () => ({
      ...summary,
      activated: activationCount > 0,
      activationCount,
    }),
    seams: SEAM_NAMES.filter((name) => seams[name] !== undefined),
    wrapBackend: (backend, context = {}) =>
      seams.backend?.(backend, context, activate) ?? backend,
    wrapCodec: (codec) => seams.codec?.(codec, activate) ?? codec,
    wrapFaultInjection: (factory) =>
      seams.faultInjection?.(factory, activate) ?? factory,
    wrapKernel: (kernel, backend) =>
      seams.kernel?.(kernel, backend, activate) ?? kernel,
  } satisfies SelectedKernelMutant);
};
