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
 * In-memory reference backend for the Tuvren kernel.
 *
 * {@link createMemoryBackend} builds a `RuntimeBackend` that keeps all durable
 * state in process memory. It is the reference implementation the SQLite and
 * PostgreSQL backends are held against: every transaction runs against a
 * copy-on-write clone of the committed state, is validated against the full
 * committed-state invariant suite, and is swapped in atomically, so partial
 * writes are never observable.
 *
 * {@link createMemoryScopeStore} builds the shared scope-keyed substrate
 * (ADR-049): passing one store to several `createMemoryBackend` calls lets
 * backends bound to the same Scope share durable state while distinct Scopes
 * stay isolated by construction.
 *
 * @packageDocumentation
 */

export type { MemoryBackendOptions } from "./lib/memory-backend.js";
// biome-ignore lint/performance/noBarrelFile: This package entrypoint is the intentional public contract surface.
export { createMemoryBackend } from "./lib/memory-backend.js";
export type { MemoryScopeStore } from "./lib/memory-backend-scope-store.js";
export { createMemoryScopeStore } from "./lib/memory-backend-scope-store.js";
