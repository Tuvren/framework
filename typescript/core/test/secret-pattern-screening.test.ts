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

import { describe, expect, test } from "bun:test";
import {
  isSecretLikeKey,
  REDACTED,
  sanitizeSecretLikeText,
  screenValueForSecretPatterns,
} from "../src/lib/secret-pattern-screening.js";

const JWT_SHAPED =
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0dXZyZW4tY29yZS10ZXN0In0.QVzX9k3f7c9a1e2b4d6f8a0c5e7b9d1f3a5c7e9b1d3f5a7c9e1b3d5f7a9c1e3b";
const AUTH_HEADER_SHAPED = "authorization: Bearer sk-tuvren-core-test-token";
const CONNECTION_STRING_SHAPED =
  "postgres://app:s3cr3t-p4ss@db.internal:5432/appdb";
const CREDENTIAL_ASSIGNMENT_SHAPED = 'api_key="tuvren-core-test-api-key-value"';
const LONG_SECRETISH_SHAPED = "A".repeat(40);

describe("isSecretLikeKey", () => {
  test("flags key names that read as secret-shaped", () => {
    expect(isSecretLikeKey("apiKey")).toBe(true);
    expect(isSecretLikeKey("Authorization")).toBe(true);
    expect(isSecretLikeKey("client_secret")).toBe(true);
    expect(isSecretLikeKey("password")).toBe(true);
  });

  test("does not flag ordinary key names", () => {
    expect(isSecretLikeKey("modelId")).toBe(false);
    expect(isSecretLikeKey("threadId")).toBe(false);
  });
});

describe("sanitizeSecretLikeText", () => {
  test("redacts a JWT-shaped token", () => {
    expect(sanitizeSecretLikeText(JWT_SHAPED)).toBe(REDACTED);
  });

  test("redacts an auth-header-shaped string", () => {
    expect(sanitizeSecretLikeText(AUTH_HEADER_SHAPED)).toBe(REDACTED);
  });

  test("redacts a connection-string-shaped string", () => {
    expect(sanitizeSecretLikeText(CONNECTION_STRING_SHAPED)).toBe(REDACTED);
  });

  test("redacts a credential-assignment-shaped string", () => {
    expect(sanitizeSecretLikeText(CREDENTIAL_ASSIGNMENT_SHAPED)).toBe(REDACTED);
  });

  test("redacts a long-secretish string", () => {
    expect(sanitizeSecretLikeText(LONG_SECRETISH_SHAPED)).toBe(REDACTED);
  });

  test("leaves an ordinary short string untouched", () => {
    expect(sanitizeSecretLikeText("hello world")).toBe("hello world");
  });
});

describe("screenValueForSecretPatterns", () => {
  test("redacts a secret-shaped string leaf nested inside an object at any depth", () => {
    const value = {
      request: {
        body: {
          headers: {
            authorization: AUTH_HEADER_SHAPED,
          },
        },
      },
    };

    expect(screenValueForSecretPatterns(value)).toEqual({
      request: {
        body: {
          headers: {
            authorization: REDACTED,
          },
        },
      },
    });
  });

  test("redacts a secret-shaped string leaf nested inside an array at any depth", () => {
    const value = {
      warnings: [{ message: "ok" }, [JWT_SHAPED, "fine"]],
    };

    expect(screenValueForSecretPatterns(value)).toEqual({
      warnings: [{ message: "ok" }, [REDACTED, "fine"]],
    });
  });

  test("leaves ordinary short strings, numbers, booleans, null, and undefined untouched", () => {
    const value = {
      count: 3,
      enabled: true,
      label: "fine",
      missing: undefined,
      note: null,
    };

    expect(screenValueForSecretPatterns(value)).toEqual({
      count: 3,
      enabled: true,
      label: "fine",
      note: null,
    });
  });

  test("passes a top-level number/boolean/null/undefined through unchanged", () => {
    expect(screenValueForSecretPatterns(42)).toBe(42);
    expect(screenValueForSecretPatterns(true)).toBe(true);
    expect(screenValueForSecretPatterns(null)).toBeNull();
    expect(screenValueForSecretPatterns(undefined)).toBeUndefined();
  });

  test("handles a sanitizeMetadataValue-shaped uint8array base64 payload without corrupting non-secret-shaped data", () => {
    // Mirrors exactly what the AI SDK bridge's sanitizeMetadataValue produces
    // for a Uint8Array: { base64, type: "uint8array" }. A real, plausible
    // >=32-char base64 blob of random bytes coincidentally matches the
    // long-secretish pattern and gets redacted -- ACCEPTABLE per KRT-BK004's
    // design (redaction is the safe direction) as long as it causes no
    // conformance regression (verified separately via the before/after
    // conformance diff). The `type` discriminant, which is not secret-shaped,
    // must survive untouched.
    const randomBytes = Buffer.from([
      231, 14, 92, 3, 250, 17, 88, 6, 199, 42, 5, 100, 61, 9, 240, 77, 133, 21,
      6, 250, 3, 199, 88, 17, 92, 14, 231, 100, 5, 42, 199, 61,
    ]);
    const base64 = randomBytes.toString("base64");
    const value = { base64, type: "uint8array" };

    const screened = screenValueForSecretPatterns(value) as {
      base64: string;
      type: string;
    };

    expect(screened.type).toBe("uint8array");
    // The base64 blob is >= 32 chars, so it is expected to be redacted.
    expect(screened.base64).toBe(REDACTED);
  });
});
