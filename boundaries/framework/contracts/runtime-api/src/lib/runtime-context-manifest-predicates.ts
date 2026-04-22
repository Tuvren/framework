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
  hasOnlyAllowedKeys,
  isMessageIndexValue,
  isNonEmptyStringValue,
  isNonNegativeFiniteNumberProperty,
  isNonNegativeSafeInteger,
  isNonNegativeSafeIntegerProperty,
  isPlainObject,
  isSerializableRecord,
} from "./runtime-contract-predicates.js";
import type {
  ContextManifest,
  ContextManifestCounters,
  ContextManifestNameCounters,
} from "./runtime-contracts.js";

const CONTEXT_MANIFEST_KEYS = new Set([
  "byRole",
  "extensions",
  "lastAssistantMessageIndex",
  "lastUserMessageIndex",
  "messageCount",
  "tokenEstimate",
  "toolCalls",
  "toolResults",
  "turnBoundaries",
]);
const CONTEXT_MANIFEST_COUNTER_KEYS = new Set([
  "assistant",
  "system",
  "tool",
  "user",
]);
const CONTEXT_MANIFEST_NAME_COUNTER_KEYS = new Set(["byName", "total"]);

export function isContextManifest(value: unknown): value is ContextManifest {
  const byRole = isPlainObject(value) ? value.byRole : undefined;
  const messageCount = isPlainObject(value) ? value.messageCount : undefined;
  const lastAssistantMessageIndex = isPlainObject(value)
    ? value.lastAssistantMessageIndex
    : undefined;
  const lastUserMessageIndex = isPlainObject(value)
    ? value.lastUserMessageIndex
    : undefined;
  const toolCalls = isPlainObject(value) ? value.toolCalls : undefined;
  const toolResults = isPlainObject(value) ? value.toolResults : undefined;

  if (
    !(
      isPlainObject(value) &&
      hasOnlyAllowedKeys(value, CONTEXT_MANIFEST_KEYS) &&
      isContextManifestCounters(byRole) &&
      isSerializableRecord(value.extensions) &&
      isNonNegativeSafeInteger(messageCount) &&
      isNonNegativeFiniteNumberProperty(value, "tokenEstimate") &&
      isContextManifestNameCounters(toolCalls) &&
      isContextManifestNameCounters(toolResults) &&
      Array.isArray(value.turnBoundaries) &&
      value.turnBoundaries.every(
        (item) => Number.isSafeInteger(item) && item >= 0
      )
    )
  ) {
    return false;
  }

  if (
    !(
      isMessageIndexValue(lastAssistantMessageIndex, messageCount) &&
      isMessageIndexValue(lastUserMessageIndex, messageCount)
    )
  ) {
    return false;
  }

  if (
    !(
      hasValidLastRoleIndex(
        byRole.assistant,
        lastAssistantMessageIndex,
        messageCount
      ) &&
      hasValidLastRoleIndex(byRole.user, lastUserMessageIndex, messageCount)
    )
  ) {
    return false;
  }

  if (
    byRole.assistant + byRole.system + byRole.tool + byRole.user !==
    messageCount
  ) {
    return false;
  }

  if (
    !(
      hasMatchingNamedCounterTotal(toolCalls) &&
      hasMatchingNamedCounterTotal(toolResults)
    )
  ) {
    return false;
  }

  if (
    !hasValidTurnBoundaries(
      value.turnBoundaries,
      messageCount,
      byRole.user,
      lastUserMessageIndex,
      byRole.assistant,
      lastAssistantMessageIndex
    )
  ) {
    return false;
  }

  return true;
}

export function isOptionalContextManifestProperty<
  TKey extends string,
  TObject extends Record<string, unknown>,
>(value: TObject, key: TKey): boolean {
  return value[key] === undefined || isContextManifest(value[key]);
}

function isContextManifestCounters(
  value: unknown
): value is ContextManifestCounters {
  return (
    isPlainObject(value) &&
    hasOnlyAllowedKeys(value, CONTEXT_MANIFEST_COUNTER_KEYS) &&
    isNonNegativeSafeIntegerProperty(value, "assistant") &&
    isNonNegativeSafeIntegerProperty(value, "system") &&
    isNonNegativeSafeIntegerProperty(value, "tool") &&
    isNonNegativeSafeIntegerProperty(value, "user")
  );
}

function isContextManifestNameCounters(
  value: unknown
): value is ContextManifestNameCounters {
  return (
    isPlainObject(value) &&
    hasOnlyAllowedKeys(value, CONTEXT_MANIFEST_NAME_COUNTER_KEYS) &&
    isPlainObject(value.byName) &&
    Object.keys(value.byName).every(isNonEmptyStringValue) &&
    Object.values(value.byName).every(
      (count) =>
        typeof count === "number" && Number.isSafeInteger(count) && count >= 0
    ) &&
    isNonNegativeSafeIntegerProperty(value, "total")
  );
}

function hasValidLastRoleIndex(
  roleCount: number,
  lastIndex: number,
  messageCount: number
): boolean {
  if (roleCount === 0) {
    return lastIndex === -1;
  }

  return (
    lastIndex >= roleCount - 1 && lastIndex >= 0 && lastIndex < messageCount
  );
}

function hasMatchingNamedCounterTotal(
  counters: ContextManifestNameCounters
): boolean {
  const namedTotal = Object.values(counters.byName).reduce(
    (sum, count) => sum + count,
    0
  );
  return namedTotal === counters.total;
}

function hasOrderedTurnBoundaries(
  turnBoundaries: number[],
  messageCount: number
): boolean {
  let previousBoundary = -1;

  for (const boundary of turnBoundaries) {
    if (boundary >= messageCount || boundary <= previousBoundary) {
      return false;
    }

    previousBoundary = boundary;
  }

  return true;
}

function hasValidTurnBoundaries(
  turnBoundaries: number[],
  messageCount: number,
  userCount: number,
  lastUserMessageIndex: number,
  assistantCount: number,
  lastAssistantMessageIndex: number
): boolean {
  if (!hasOrderedTurnBoundaries(turnBoundaries, messageCount)) {
    return false;
  }

  if (userCount === 0) {
    return turnBoundaries.length === 0;
  }

  if (!(turnBoundaries.length > 0 && turnBoundaries.length <= userCount)) {
    return false;
  }

  if (userCount === 1) {
    return (
      turnBoundaries.length === 1 && turnBoundaries[0] === lastUserMessageIndex
    );
  }

  // The manifest cannot reconstruct every message role index, but it does know
  // the last assistant position exactly. Any declared user-turn boundary that
  // collides with that known assistant index is structurally impossible.
  if (
    assistantCount > 0 &&
    turnBoundaries.includes(lastAssistantMessageIndex)
  ) {
    return false;
  }

  // There must still be enough index space before the last user message to
  // fit the declared number of user-role messages, even when the first user
  // turn starts after leading system or assistant messages.
  const earliestPossibleFirstUserIndex = lastUserMessageIndex - userCount + 1;

  if (turnBoundaries[0] > earliestPossibleFirstUserIndex) {
    return false;
  }

  if (
    turnBoundaries.length === userCount &&
    turnBoundaries.at(-1) !== lastUserMessageIndex
  ) {
    return false;
  }

  const lastBoundary = turnBoundaries.at(-1);

  return (
    turnBoundaries[0] <= lastUserMessageIndex &&
    lastBoundary !== undefined &&
    lastBoundary <= lastUserMessageIndex
  );
}
