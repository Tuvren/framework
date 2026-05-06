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
  TuvrenPersistenceError,
  TuvrenValidationError,
} from "@tuvren/core-types";

export function persistenceError(
  message: string,
  code: string,
  details?: unknown,
  cause?: unknown
): TuvrenPersistenceError {
  return new TuvrenPersistenceError(message, { cause, code, details });
}

export function normalizeBackendError(error: unknown): Error {
  if (error instanceof TuvrenPersistenceError) {
    return error;
  }

  if (error instanceof TuvrenValidationError) {
    return error;
  }

  if (error instanceof Error) {
    const sqliteCode =
      typeof Reflect.get(error, "code") === "string"
        ? (Reflect.get(error, "code") as string)
        : undefined;

    if (sqliteCode?.startsWith("SQLITE_") === true) {
      return persistenceError(
        `sqlite backend engine operation failed: ${error.message}`,
        "sqlite_backend_engine_error",
        {
          message: error.message,
          sqliteCode,
        },
        error
      );
    }

    return error;
  }

  return persistenceError(
    "sqlite backend operation failed",
    "sqlite_backend_operation_failed",
    { value: String(error) }
  );
}

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
