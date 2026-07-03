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

import type { Scope } from "@tuvren/core";
import { createEmptyState } from "./memory-backend-state.js";
import type { BackendState } from "./memory-backend-types.js";

/**
 * Shared in-memory substrate that keys every kernel store by Scope (ADR-048
 * scope-keyed map realization; ADR-049 scope-resolved identity). Each Scope owns
 * an independent `BackendState`, so two memory backends bound to different Scopes
 * but sharing one store never observe each other's objects, trees, nodes,
 * schemas, staging, or enumerations. Two backends bound to the *same* Scope and
 * store share that Scope's committed state (so a host can reconstruct a scoped
 * runtime per request and retain the tenant's durable state).
 *
 * Per-Scope transaction serialization lives here, so concurrent transactions
 * from multiple backend instances bound to the same store and Scope are
 * serialized exactly as a single backend instance would serialize its own.
 */
export class MemoryScopeStore {
  private readonly states = new Map<Scope, BackendState>();
  private readonly scopeQueues = new Map<Scope, Promise<void>>();

  /**
   * Returns the committed `BackendState` for a Scope, creating an empty one on
   * first use. Callers must hold the per-Scope lock (`runExclusive`) before
   * reading or committing so reads observe a stable committed snapshot.
   */
  getState(scope: Scope): BackendState {
    let state = this.states.get(scope);

    if (state === undefined) {
      state = createEmptyState();
      this.states.set(scope, state);
    }

    return state;
  }

  /** Replaces the committed `BackendState` for a Scope. */
  setState(scope: Scope, state: BackendState): void {
    this.states.set(scope, state);
  }

  /**
   * Drops a Scope's entire partition from the substrate (full tenant
   * offboarding; kernel spec §9.4). Removes the committed state so a later
   * `getState` re-creates an empty partition, and forgets the per-Scope
   * serialization queue. Distinct Scopes sharing this store are untouched, so
   * isolation-by-construction makes offboarding one tenant invisible to every
   * other. Callers must hold the per-Scope lock (`runExclusive`) so the drop
   * does not race a concurrent transaction on the same Scope.
   */
  dropScope(scope: Scope): void {
    this.states.delete(scope);
    this.scopeQueues.delete(scope);
  }

  /**
   * Runs `work` with exclusive access to a Scope, serializing all transactions
   * for that Scope across every backend instance sharing this store. Distinct
   * Scopes never contend with one another.
   */
  async runExclusive<T>(scope: Scope, work: () => Promise<T>): Promise<T> {
    const priorTransaction = this.scopeQueues.get(scope) ?? Promise.resolve();
    let releaseQueue: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseQueue = resolve;
    });

    this.scopeQueues.set(
      scope,
      priorTransaction.then(() => gate)
    );

    await priorTransaction;

    try {
      return await work();
    } finally {
      releaseQueue?.();
    }
  }
}

/**
 * Creates a shared scope-keyed memory substrate. Pass the returned store to
 * multiple `createMemoryBackend({ scope, store })` calls so each Scope is
 * isolated by construction while persisting across per-request backends.
 */
export function createMemoryScopeStore(): MemoryScopeStore {
  return new MemoryScopeStore();
}
