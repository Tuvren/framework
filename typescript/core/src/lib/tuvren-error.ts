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

const KRAKEN_ERROR_CODE_PATTERN = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;

/**
 * A stable, machine-readable error code in lowercase `snake_case` (for
 * example `invalid_runner_result` or `execution_bound_exceeded`). Codes are
 * part of the public contract: hosts branch on `code`, not on message text.
 */
export type TuvrenErrorCode = string;

/**
 * Constructor options shared by every {@link TuvrenError} subclass.
 */
export interface TuvrenErrorOptions {
  /** Underlying error or value that caused this error, if any. */
  cause?: unknown;
  /** Stable machine-readable code; must be lowercase `snake_case`. */
  code: TuvrenErrorCode;
  /** Arbitrary diagnostic payload (often the offending value). */
  details?: unknown;
}

/**
 * True when `value` is a well-formed {@link TuvrenErrorCode}: one or more
 * lowercase alphanumeric segments joined by single underscores.
 */
export function isTuvrenErrorCode(value: unknown): value is TuvrenErrorCode {
  return typeof value === "string" && KRAKEN_ERROR_CODE_PATTERN.test(value);
}

/**
 * Asserts that `value` is a well-formed {@link TuvrenErrorCode}.
 *
 * @param value - Untrusted candidate code.
 * @param label - Name used in the error message (defaults to `"value"`).
 * @throws TypeError when {@link isTuvrenErrorCode} rejects the value.
 */
export function assertTuvrenErrorCode(
  value: unknown,
  label = "value"
): asserts value is TuvrenErrorCode {
  if (!isTuvrenErrorCode(value)) {
    throw new TypeError(
      `${label} must be a lowercase snake_case Tuvren error code`
    );
  }
}

/**
 * Abstract base of the Tuvren error family (re-exported at the package root
 * per ADR-037).
 *
 * Every Tuvren error carries a validated stable {@link TuvrenErrorCode}, an
 * optional `details` diagnostic payload, and an optional `cause`. The
 * constructor sets `name` to the concrete subclass name and rejects
 * malformed codes eagerly. Catch on the family (`instanceof TuvrenError`)
 * or a concrete subclass, then branch on `code`.
 */
export abstract class TuvrenError extends Error {
  readonly code: TuvrenErrorCode;
  readonly details?: unknown;
  override readonly cause?: unknown;

  protected constructor(message: string, options: TuvrenErrorOptions) {
    assertTuvrenErrorCode(options.code, "options.code");
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause }
    );

    this.name = new.target.name;
    this.code = options.code;
    this.details = options.details;
    this.cause = options.cause;
  }
}

/**
 * Raised when a value fails contract validation — the error type thrown by
 * the `assert*` guards in this package (for example codes
 * `invalid_runner_result`, `invalid_tuvren_message`,
 * `tool_input_validation_failed`).
 */
export class TuvrenValidationError extends TuvrenError {
  // biome-ignore lint/complexity/noUselessConstructor: The shared base constructor is protected, so public subclasses must re-expose construction intentionally.
  constructor(message: string, options: TuvrenErrorOptions) {
    super(message, options);
  }
}
/** Raised for durable-storage/persistence failures. */
export class TuvrenPersistenceError extends TuvrenError {
  // biome-ignore lint/complexity/noUselessConstructor: The shared base constructor is protected, so public subclasses must re-expose construction intentionally.
  constructor(message: string, options: TuvrenErrorOptions) {
    super(message, options);
  }
}
/** Raised for turn/branch lineage violations (ancestry, containment). */
export class TuvrenLineageError extends TuvrenError {
  // biome-ignore lint/complexity/noUselessConstructor: The shared base constructor is protected, so public subclasses must re-expose construction intentionally.
  constructor(message: string, options: TuvrenErrorOptions) {
    super(message, options);
  }
}
/** Raised when crash/interruption recovery cannot restore execution. */
export class TuvrenRecoveryError extends TuvrenError {
  // biome-ignore lint/complexity/noUselessConstructor: The shared base constructor is protected, so public subclasses must re-expose construction intentionally.
  constructor(message: string, options: TuvrenErrorOptions) {
    super(message, options);
  }
}
/**
 * Raised for runtime execution failures (for example codes
 * `execution_cancelled` or `execution_bound_exceeded`).
 */
export class TuvrenRuntimeError extends TuvrenError {
  // biome-ignore lint/complexity/noUselessConstructor: The shared base constructor is protected, so public subclasses must re-expose construction intentionally.
  constructor(message: string, options: TuvrenErrorOptions) {
    super(message, options);
  }
}
/** Raised for model-provider failures surfaced through the provider seam. */
export class TuvrenProviderError extends TuvrenError {
  // biome-ignore lint/complexity/noUselessConstructor: The shared base constructor is protected, so public subclasses must re-expose construction intentionally.
  constructor(message: string, options: TuvrenErrorOptions) {
    super(message, options);
  }
}
