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

import {
  isSecretLikeKey,
  REDACTED,
  sanitizeSecretLikeText,
} from "@tuvren/core/security";
import type { TelemetryAttributeValue } from "@tuvren/core/telemetry";
import { TUVREN_RUNTIME_TELEMETRY_ATTRIBUTE_KEYS } from "@tuvren/telemetry-semconv";

// The regex-based structural secret-pattern primitives (secret-key-shaped
// names, URL-embedded credentials, connection strings, auth headers,
// credential assignments, JWTs, long-secretish tokens) live in
// @tuvren/core/security (ADR-044, KRT-BK004) so the AI SDK provider bridge can
// share them without depending on @tuvren/runtime. This module keeps its own,
// telemetry-attribute-specific policy — the allowlist, and the canonical-hash
// / UUID exemptions below — layered on top of those shared primitives.
const CANONICAL_HASH_PATTERN = /^[a-f0-9]{64}$/iu;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const HASH_ATTRIBUTE_KEYS: ReadonlySet<string> = new Set([
  "tuvren.runtime.checkpoint.hash",
  "tuvren.runtime.parent_checkpoint.hash",
  "tuvren.runtime.resumed_from.hash",
]);
const ID_ATTRIBUTE_KEYS: ReadonlySet<string> = new Set([
  "tuvren.runtime.branch.id",
  "tuvren.runtime.run.id",
  "tuvren.runtime.thread.id",
  "tuvren.runtime.tool_call.id",
  "tuvren.runtime.turn.id",
]);

const ALLOWED_ATTRIBUTE_KEYS: ReadonlySet<string> = new Set(
  TUVREN_RUNTIME_TELEMETRY_ATTRIBUTE_KEYS
);

export function filterTelemetryAttributes(
  attributes: Record<string, TelemetryAttributeValue>
): Record<string, TelemetryAttributeValue> {
  const filtered: Record<string, TelemetryAttributeValue> = {};

  for (const [key, value] of Object.entries(attributes)) {
    if (!isTelemetryAttributeAllowed(key) || isSecretLikeKey(key)) {
      continue;
    }

    const screened = sanitizeTelemetryAttributeValue(key, value);

    if (screened !== undefined) {
      filtered[key] = screened;
    }
  }

  return filtered;
}

export function isTelemetryAttributeAllowed(key: string): boolean {
  return ALLOWED_ATTRIBUTE_KEYS.has(key);
}

export function sanitizeTelemetryErrorSummary(message: string): string {
  const compact = message.replace(/\s+/gu, " ").trim();

  if (compact.length === 0) {
    return "runtime error";
  }

  return sanitizeSecretLikeText(compact).slice(0, 512);
}

function sanitizeTelemetryAttributeValue(
  key: string,
  value: TelemetryAttributeValue
): TelemetryAttributeValue | undefined {
  if (typeof value !== "string") {
    return value;
  }

  if (HASH_ATTRIBUTE_KEYS.has(key) && CANONICAL_HASH_PATTERN.test(value)) {
    return value;
  }

  if (ID_ATTRIBUTE_KEYS.has(key) && UUID_PATTERN.test(value)) {
    return value;
  }

  const sanitized = sanitizeSecretLikeText(value);
  return sanitized === REDACTED ? undefined : sanitized;
}
