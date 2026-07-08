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
 * Shared, structural secret-pattern detection primitives (ADR-044, KRT-BK004).
 *
 * These regexes and the `sanitizeSecretLikeText`/`isSecretLikeKey` helpers
 * originated in `@tuvren/runtime`'s telemetry-attribute screen
 * (`telemetry-secret-screening.ts`, KRT-BD001). They live here, in
 * `@tuvren/core`, so any package that already depends on `@tuvren/core` — the
 * runtime's telemetry screen and the AI SDK provider bridge alike — can apply
 * the exact same pattern set without one depending on the other's package.
 *
 * This module is deliberately narrow: it detects secret-*shaped* values by
 * regex. It has no notion of attribute allowlists, canonical-hash/UUID
 * exemptions, or flat-record telemetry-attribute keys — that policy is
 * specific to `filterTelemetryAttributes`'s use case and stays in
 * `@tuvren/runtime`'s `telemetry-secret-screening.ts`.
 */

import { isPlainObject } from "./runtime-contract-predicates.js";

/** Matches key names that read as secret-shaped (used by telemetry-key filtering). */
export const SECRET_KEY_PATTERN =
  /(?:authorization|api[-_.]?key|bearer|client[-_.]?secret|credential|password|private[-_.]?key|secret|token)/iu;
/** Matches a URL embedding inline `user:password@` credentials. */
export const URL_CREDENTIAL_PATTERN =
  /[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/iu;
/** Matches a database connection string carrying inline credentials. */
export const CONNECTION_STRING_PATTERN =
  /\b(?:postgres|postgresql|mysql|mongodb|redis):\/\/\S+/iu;
/** Matches an inline `Authorization:`/`x-api-key:` header assignment. */
export const AUTH_HEADER_PATTERN =
  /\b(?:authorization|x-api-key)\s*[:=]\s*\S+/iu;
/** Matches a `key: value` / `key=value` assignment whose key reads as secret-shaped. */
export const CREDENTIAL_ASSIGNMENT_PATTERN =
  /\b(?:authorization|api[-_.]?key|bearer|client[-_.]?secret|credential|password|private[-_.]?key|secret|token)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/iu;
/** Matches a JWT-shaped (`header.payload.signature`) compact token. */
export const JWT_PATTERN =
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/u;
/** Matches any long, high-entropy-shaped token (generic catch-all). */
export const LONG_SECRETISH_PATTERN = /\b[A-Za-z0-9_~+/.-]{32,}={0,2}\b/u;

/** Sentinel returned in place of a value that matched a secret-shaped pattern. */
export const REDACTED = "[redacted]";

/**
 * True when `key` reads as secret-shaped (e.g. contains "token", "password",
 * "secret", ...). Used to drop attributes/fields whose *name* signals a
 * credential regardless of their value shape.
 */
export function isSecretLikeKey(key: string): boolean {
  return SECRET_KEY_PATTERN.test(key);
}

/**
 * Tests `value` against the full covered pattern set (URL-embedded
 * credentials, connection strings, auth headers, credential assignments, JWTs,
 * and generic long-secretish tokens) and returns the `REDACTED` sentinel on a
 * match, or the original string unchanged otherwise.
 */
export function sanitizeSecretLikeText(value: string): string {
  if (
    URL_CREDENTIAL_PATTERN.test(value) ||
    CONNECTION_STRING_PATTERN.test(value) ||
    AUTH_HEADER_PATTERN.test(value) ||
    CREDENTIAL_ASSIGNMENT_PATTERN.test(value) ||
    JWT_PATTERN.test(value) ||
    LONG_SECRETISH_PATTERN.test(value)
  ) {
    return REDACTED;
  }

  return value;
}

/**
 * Recursively screens `value` for secret-*shaped* strings and replaces them
 * with the `REDACTED` sentinel, leaving every other JSON-safe shape (numbers,
 * booleans, null, undefined, and non-secret-shaped strings) unchanged.
 *
 * Deliberately minimal: this runs after JSON-safety normalization (e.g. the AI
 * SDK provider bridge's `sanitizeMetadataValue`) has already reduced `Date`,
 * `URL`, `Uint8Array`, and `Error` instances to plain strings/objects, so it
 * only needs to recurse through strings, arrays, and plain objects. It does
 * NOT redact based on key name (unlike `filterTelemetryAttributes`'s
 * `isSecretLikeKey` gate) — value-shape detection via the pattern set above is
 * the whole of this function's scope.
 */
export function screenValueForSecretPatterns(value: unknown): unknown {
  if (typeof value === "string") {
    return sanitizeSecretLikeText(value);
  }

  if (Array.isArray(value)) {
    return value.map((entry) => screenValueForSecretPatterns(entry));
  }

  if (isPlainObject(value)) {
    const result: Record<string, unknown> = {};

    for (const [key, entry] of Object.entries(value)) {
      result[key] = screenValueForSecretPatterns(entry);
    }

    return result;
  }

  return value;
}
