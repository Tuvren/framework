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
 * Shared, runner-owned secret-absence scanner for the `secret-isolation` check
 * set (ADR-0044, KRT-BD004). It recursively flattens an observation surface
 * (persisted kernel records, captured canonical stream events, captured
 * telemetry, or a recorded transcript) into searchable text and asserts that
 * none of the configured secrets — or their common derived leak forms — appear.
 *
 * The runner, never the adapter, owns this verdict: adapters supply only raw
 * observations and the configured secret values.
 */

import { SECRET_VALUE_PATTERNS } from "@tuvren/core/security";

/**
 * Length of the leading partial-token prefix scanned for. Long enough to be
 * distinctive (avoid trivial substring hits) yet short enough that any longer
 * partial leak of the secret still contains it.
 */
const PARTIAL_TOKEN_PREFIX_LENGTH = 16;
/** Separator placed between flattened parts so a secret cannot match across a boundary. */
const PART_SEPARATOR = " ";

export interface SecretLeakFinding {
  /** The configured secret value that leaked. */
  secret: string;
  /** The derived leak form that matched (e.g. "raw", "bearer-prefixed"). */
  variant: string;
}

/**
 * Return every configured secret that appears in the surface in any covered
 * variant form. An empty result means the surface is secret-free.
 */
export function findSecretLeaks(
  surface: unknown,
  secrets: readonly string[]
): SecretLeakFinding[] {
  const haystack = buildHaystack(surface);
  const haystackLower = haystack.toLowerCase();
  const findings: SecretLeakFinding[] = [];

  for (const secret of secrets) {
    if (typeof secret !== "string" || secret.length === 0) {
      continue;
    }

    for (const [variant, value, caseInsensitive] of secretVariants(secret)) {
      if (value.length === 0) {
        continue;
      }
      const matched = caseInsensitive
        ? haystackLower.includes(value.toLowerCase())
        : haystack.includes(value);
      if (matched) {
        findings.push({ secret, variant });
        break;
      }
    }
  }

  return findings;
}

export interface SecretPatternLeakFinding {
  /** The structural pattern name that matched (e.g. "jwt", "url-credential"). */
  pattern: string;
  /** A bounded preview of the offending value (never the full raw secret text). */
  preview: string;
}

/** Length of the bounded preview kept in a finding so findings never echo a full raw secret. */
const PATTERN_LEAK_PREVIEW_LENGTH = 24;

/**
 * Recursively scan a surface for secret-*shaped* values — detected
 * structurally via `SECRET_VALUE_PATTERNS` (`@tuvren/core/security`), the same
 * ordered pattern list `sanitizeSecretLikeText`/`screenValueForSecretPatterns`
 * derive their redaction OR-chain from — rather than value-equality against a
 * configured secret list. Deriving both from one shared list (instead of each
 * independently re-listing the same patterns) guarantees this detector and the
 * screen can never drift apart: anything flagged here is something the screen
 * would have redacted. An empty result means the surface carries no
 * pattern-detectable secret residue.
 */
export function findSecretPatternLeaks(
  surface: unknown
): SecretPatternLeakFinding[] {
  const strings: string[] = [];
  collectStrings(surface, strings, new Set());

  const findings: SecretPatternLeakFinding[] = [];
  const seenValues = new Set<string>();

  for (const value of strings) {
    if (value.length === 0 || seenValues.has(value)) {
      continue;
    }
    seenValues.add(value);

    for (const [pattern, regex] of SECRET_VALUE_PATTERNS) {
      if (regex.test(value)) {
        findings.push({
          pattern,
          preview:
            value.length > PATTERN_LEAK_PREVIEW_LENGTH
              ? `${value.slice(0, PATTERN_LEAK_PREVIEW_LENGTH)}…`
              : value,
        });
        break;
      }
    }
  }

  return findings;
}

/** Convenience boolean wrapper over {@link findSecretPatternLeaks}. */
export function hasSecretPatternResidue(surface: unknown): boolean {
  return findSecretPatternLeaks(surface).length > 0;
}

/** The covered derived leak forms per ADR-0044 §4 (KRT-BD004). */
function secretVariants(
  secret: string
): [variant: string, value: string, caseInsensitive: boolean][] {
  const variants: [string, string, boolean][] = [
    // Raw value, including a header-normalized (case-folded) match.
    ["raw", secret, false],
    ["header-normalized", secret, true],
    ["bearer-prefixed", `Bearer ${secret}`, true],
    ["url-encoded", encodeURIComponent(secret), false],
    ["base64", base64Encode(secret), false],
    ["base64url", base64UrlEncode(secret), false],
  ];

  // Scan for the leading prefix so any longer truncated-token leak contains it.
  if (secret.length > PARTIAL_TOKEN_PREFIX_LENGTH) {
    variants.push([
      "partial-token",
      secret.slice(0, PARTIAL_TOKEN_PREFIX_LENGTH),
      false,
    ]);
  }

  return variants;
}

function base64Encode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

function base64UrlEncode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

/** Recursively flatten a surface into a single searchable string. */
function buildHaystack(surface: unknown): string {
  const parts: string[] = [];
  collectStrings(surface, parts, new Set());
  try {
    parts.push(JSON.stringify(surface));
  } catch {
    // Cyclic or non-serializable surfaces are still covered by collectStrings.
  }
  return parts.join(PART_SEPARATOR);
}

function collectStrings(
  value: unknown,
  parts: string[],
  seen: Set<object>
): void {
  if (typeof value === "string") {
    parts.push(value);
    return;
  }

  if (value instanceof Uint8Array) {
    // Decode raw bytes (e.g. CBOR-encoded kernel records) as text and base64 so
    // secrets embedded in binary payloads are still detectable.
    parts.push(Buffer.from(value).toString("utf8"));
    parts.push(Buffer.from(value).toString("base64"));
    return;
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) {
      return;
    }
    seen.add(value);
    for (const entry of value) {
      collectStrings(entry, parts, seen);
    }
    return;
  }

  if (typeof value === "object" && value !== null) {
    if (seen.has(value)) {
      return;
    }
    seen.add(value);
    for (const [key, entry] of Object.entries(value)) {
      parts.push(key);
      collectStrings(entry, parts, seen);
    }
  }
}
