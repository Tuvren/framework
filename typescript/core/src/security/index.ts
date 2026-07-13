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

/**
 * `@tuvren/core/security` — shared structural secret-pattern screening
 * (ADR-044, KRT-BK004): the named secret-shape regexes, the `REDACTED`
 * sentinel, and the key/value screening helpers. Kept as its own focused
 * subpath so any `@tuvren/core` consumer can screen values for
 * secret-shaped substrings without pulling in the rest of the core
 * surface.
 *
 * @packageDocumentation
 */

export {
  AUTH_HEADER_PATTERN,
  CONNECTION_STRING_PATTERN,
  CREDENTIAL_ASSIGNMENT_PATTERN,
  isSecretLikeKey,
  JWT_PATTERN,
  LONG_SECRETISH_PATTERN,
  REDACTED,
  SECRET_KEY_PATTERN,
  SECRET_VALUE_PATTERNS,
  sanitizeSecretLikeText,
  screenValueForSecretPatterns,
  URL_CREDENTIAL_PATTERN,
} from "../lib/secret-pattern-screening.js";
