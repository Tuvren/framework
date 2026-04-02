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

export type KrakenErrorCode = string;

export interface KrakenErrorOptions {
  cause?: unknown;
  code: KrakenErrorCode;
  details?: unknown;
}

export function isKrakenErrorCode(value: unknown): value is KrakenErrorCode {
  return typeof value === "string" && KRAKEN_ERROR_CODE_PATTERN.test(value);
}

export function assertKrakenErrorCode(
  value: unknown,
  label = "value"
): asserts value is KrakenErrorCode {
  if (!isKrakenErrorCode(value)) {
    throw new TypeError(
      `${label} must be a lowercase snake_case Kraken error code`
    );
  }
}

export abstract class KrakenError extends Error {
  readonly code: KrakenErrorCode;
  readonly details?: unknown;
  override readonly cause?: unknown;

  protected constructor(message: string, options: KrakenErrorOptions) {
    assertKrakenErrorCode(options.code, "options.code");
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

export class KrakenValidationError extends KrakenError {
  // biome-ignore lint/complexity/noUselessConstructor: The shared base constructor is protected, so public subclasses must re-expose construction intentionally.
  constructor(message: string, options: KrakenErrorOptions) {
    super(message, options);
  }
}
export class KrakenPersistenceError extends KrakenError {
  // biome-ignore lint/complexity/noUselessConstructor: The shared base constructor is protected, so public subclasses must re-expose construction intentionally.
  constructor(message: string, options: KrakenErrorOptions) {
    super(message, options);
  }
}
export class KrakenLineageError extends KrakenError {
  // biome-ignore lint/complexity/noUselessConstructor: The shared base constructor is protected, so public subclasses must re-expose construction intentionally.
  constructor(message: string, options: KrakenErrorOptions) {
    super(message, options);
  }
}
export class KrakenRecoveryError extends KrakenError {
  // biome-ignore lint/complexity/noUselessConstructor: The shared base constructor is protected, so public subclasses must re-expose construction intentionally.
  constructor(message: string, options: KrakenErrorOptions) {
    super(message, options);
  }
}
export class KrakenRuntimeError extends KrakenError {
  // biome-ignore lint/complexity/noUselessConstructor: The shared base constructor is protected, so public subclasses must re-expose construction intentionally.
  constructor(message: string, options: KrakenErrorOptions) {
    super(message, options);
  }
}
export class KrakenProviderError extends KrakenError {
  // biome-ignore lint/complexity/noUselessConstructor: The shared base constructor is protected, so public subclasses must re-expose construction intentionally.
  constructor(message: string, options: KrakenErrorOptions) {
    super(message, options);
  }
}
