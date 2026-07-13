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
 * A Scope is a host-bound partition identity (ADR-048/049). The host binds a
 * Scope when it constructs a backend/connection; the kernel never defines,
 * authenticates, routes, or discovers tenants and the kernel syscall surface
 * stays scope-free. Durable identity is resolved *within* a Scope, so identical
 * content stored under two Scopes is two independent durable objects and a
 * read/enumeration/existence check can never observe content outside the
 * constructing Scope. The string is opaque to the runtime; the host owns the
 * mapping from its tenancy model to a Scope.
 */
export type Scope = string;

/**
 * The implicit Scope a backend binds to when the host supplies none. Preserves
 * single-tenant behavior: an unscoped backend behaves as one default partition.
 */
export const DEFAULT_SCOPE: Scope = "tuvren.scope.default";

/**
 * True when `value` is a usable {@link Scope}: any non-empty string. The
 * content is opaque to the runtime — the host owns the mapping from its
 * tenancy model to a Scope.
 */
export function isScope(value: unknown): value is Scope {
  return typeof value === "string" && value.length > 0;
}

/**
 * Asserts that `value` is a usable {@link Scope}.
 *
 * @param value - Untrusted candidate scope.
 * @param label - Name used in the error message (defaults to `"scope"`).
 * @throws TypeError when {@link isScope} rejects the value.
 */
export function assertScope(
  value: unknown,
  label = "scope"
): asserts value is Scope {
  if (!isScope(value)) {
    throw new TypeError(
      `${label} must be a non-empty host-bound Scope partition identity`
    );
  }
}
