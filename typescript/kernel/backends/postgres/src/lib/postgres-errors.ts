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

import { TuvrenPersistenceError, TuvrenValidationError } from "@tuvren/core";

/** SQLSTATE codes from Postgres drivers (e.g. 23503 foreign_key_violation). */
const SQLSTATE_CODE = /^[0-9A-Z]{5}$/;

/** Runtime syscalls that identify a DNS or socket operation. */
const NETWORK_SYSCALLS = new Set(["connect", "getaddrinfo", "read", "write"]);

/** TLS verification failures surfaced by Node-compatible runtimes. */
const TLS_ERROR_CODE =
  /^(?:CERT_|DEPTH_ZERO_SELF_SIGNED_CERT$|ERR_TLS_|SELF_SIGNED_CERT_IN_CHAIN$|UNABLE_TO_)/u;

/** Connection-lifecycle codes created by Postgres.js itself. */
const POSTGRES_JS_CONNECTION_ERROR_CODES = new Set([
  "CONNECTION_CLOSED",
  "CONNECTION_DESTROYED",
  "CONNECTION_ENDED",
  "CONNECT_TIMEOUT",
]);

/** True for a runtime error raised by DNS lookup or socket I/O. */
function isNetworkError(error: Error, code: string): boolean {
  const syscall = Reflect.get(error, "syscall");
  return (
    (typeof syscall === "string" && NETWORK_SYSCALLS.has(syscall)) ||
    TLS_ERROR_CODE.test(code)
  );
}

/**
 * True only for errors the PostgreSQL driver/engine actually produced. A
 * bare 5-char uppercase `code` is not enough: Node errno codes like `EPIPE`
 * and `EPERM` also match {@link SQLSTATE_CODE}, and labeling one of those
 * with a `postgresCode` would hand operators a confidently wrong signal on
 * exactly the failure paths they page on. Postgres.js engine errors are
 * `PostgresError` instances carrying a `severity` field. Native DNS/socket
 * errors and Postgres.js's own connection-lifecycle errors are classified
 * separately by {@link normalizeBackendError}.
 */
function isPostgresEngineError(error: Error, code: string): boolean {
  return (
    SQLSTATE_CODE.test(code) &&
    (error.name === "PostgresError" ||
      typeof Reflect.get(error, "severity") === "string")
  );
}

/**
 * Constructs the backend's uniform `TuvrenPersistenceError`. Codes follow the
 * `postgres_backend_<reason>` convention.
 */
export function persistenceError(
  message: string,
  code: string,
  details?: unknown,
  cause?: unknown
): TuvrenPersistenceError {
  return new TuvrenPersistenceError(message, { cause, code, details });
}

/**
 * Normalizes any thrown value at the backend boundary so callers only ever
 * see `Error` instances: Tuvren errors pass through untouched, PostgreSQL
 * driver/engine errors are wrapped as `postgres_backend_engine_error` with
 * the original as `cause`, other `Error`s pass through, and non-`Error`
 * values are wrapped as `postgres_backend_operation_failed`.
 */
export function normalizeBackendError(error: unknown): Error {
  if (error instanceof TuvrenPersistenceError) {
    return error;
  }

  if (error instanceof TuvrenValidationError) {
    return error;
  }

  if (error instanceof Error) {
    const code =
      typeof Reflect.get(error, "code") === "string"
        ? (Reflect.get(error, "code") as string)
        : undefined;
    // node-postgres / postgres.js surface SQLSTATE codes as 5-char strings
    // (e.g. 23503 foreign_key_violation). Postgres.js deliberately forwards
    // native runtime DNS/socket failures unchanged, so keep those codes out of
    // the postgresCode field and expose their actual provenance instead.
    if (code !== undefined && isNetworkError(error, code)) {
      return persistenceError(
        `postgres backend connection failed: ${error.message}`,
        "postgres_backend_connection_error",
        {
          message: error.message,
          networkCode: code,
        },
        error
      );
    }

    if (code !== undefined && POSTGRES_JS_CONNECTION_ERROR_CODES.has(code)) {
      return persistenceError(
        `postgres backend connection failed: ${error.message}`,
        "postgres_backend_connection_error",
        {
          driverCode: code,
          message: error.message,
        },
        error
      );
    }

    if (code !== undefined && isPostgresEngineError(error, code)) {
      return persistenceError(
        `postgres backend engine operation failed: ${error.message}`,
        "postgres_backend_engine_error",
        {
          message: error.message,
          postgresCode: code,
        },
        error
      );
    }

    return error;
  }

  return persistenceError(
    "postgres backend operation failed",
    "postgres_backend_operation_failed",
    { value: String(error) }
  );
}

/** Extracts a human-readable message from any thrown value. */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
