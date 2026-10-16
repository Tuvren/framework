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

import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

import { TuvrenPersistenceError } from "@tuvren/core";

const firstModules = [
  "../src/lib/postgres-backend.ts",
  "../src/index.ts",
] as const;

const firstModule = process.env.TUVREN_BACKEND_POSTGRES_FIRST_MODULE;

interface FaultInjectionControl {
  setFaultHooks: (...hooks: never[]) => unknown;
  supportsFaultPoint: (faultPoint: string) => boolean;
}

const isFaultInjectionControl = (
  value: unknown
): value is FaultInjectionControl =>
  typeof value === "object" &&
  value !== null &&
  "setFaultHooks" in value &&
  typeof value.setFaultHooks === "function" &&
  "supportsFaultPoint" in value &&
  typeof value.supportsFaultPoint === "function";

if (firstModule === undefined) {
  for (const modulePath of firstModules) {
    test(`preserves PostgreSQL factory behavior when ${modulePath} initializes first`, () => {
      const result = spawnSync(process.execPath, ["test", import.meta.path], {
        cwd: import.meta.dir,
        encoding: "utf-8",
        env: {
          ...process.env,
          TUVREN_BACKEND_POSTGRES_FIRST_MODULE: modulePath,
        },
        timeout: 10_000,
      });

      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stderr).toContain("1 pass");
      expect(result.stderr).toContain("0 fail");
    });
  }
} else {
  test("keeps canonical exports, eager controls, and first constructor failure", async () => {
    await import(firstModule);

    const publicApi = await import("../src/index.ts");
    const backendModule = await import("../src/lib/postgres-backend.ts");

    expect(Object.keys(publicApi)).toEqual([
      "createPostgresBackend",
      "destroyPostgresBackend",
    ]);
    expect(publicApi.createPostgresBackend).toBe(
      backendModule.createPostgresBackend
    );
    expect(publicApi.destroyPostgresBackend).toBe(
      backendModule.destroyPostgresBackend
    );
    expect({
      constructor: backendModule.createPostgresBackend.constructor.name,
      length: backendModule.createPostgresBackend.length,
      name: backendModule.createPostgresBackend.name,
    }).toEqual({
      constructor: "Function",
      length: 1,
      name: "createPostgresBackend",
    });
    expect({
      constructor: backendModule.destroyPostgresBackend.constructor.name,
      length: backendModule.destroyPostgresBackend.length,
      name: backendModule.destroyPostgresBackend.name,
    }).toEqual({
      constructor: "AsyncFunction",
      length: 1,
      name: "destroyPostgresBackend",
    });

    const backend = publicApi.createPostgresBackend({
      scope: "m12-initialization",
    });
    try {
      expect(backend.capabilities()).toEqual({
        "maintenance.reclamation": true,
        "shared-lease-clock": true,
        "thread.enumeration": true,
      });
      expect({
        close: typeof backend.close,
        destroy: typeof backend.destroy,
        fsck: typeof backend.fsck,
      }).toEqual({ close: "function", destroy: "function", fsck: "function" });

      const symbols = Object.getOwnPropertySymbols(backend);
      expect(symbols.map((symbol) => symbol.description)).toEqual([
        "tuvren.kernel.testkit.fault-injection-control",
      ]);
      const [faultSymbol] = symbols;
      if (faultSymbol === undefined) {
        throw new TypeError(
          "expected the eager fault-injection control symbol"
        );
      }
      const faultControl: unknown = Reflect.get(backend, faultSymbol);
      if (!isFaultInjectionControl(faultControl)) {
        throw new TypeError(
          "expected the eager fault-injection control surface"
        );
      }
      expect(Object.keys(faultControl)).toEqual([
        "setFaultHooks",
        "supportsFaultPoint",
      ]);
      expect(faultControl.supportsFaultPoint("before-commit")).toBe(true);
      expect(faultControl.supportsFaultPoint("mid-commit")).toBe(true);
      expect(faultControl.supportsFaultPoint("after-commit-before-ack")).toBe(
        true
      );
      expect(faultControl.supportsFaultPoint("unknown")).toBe(false);
    } finally {
      await backend.close();
    }

    let constructionError: unknown;
    try {
      publicApi.createPostgresBackend({ schemaName: "INVALID!", scope: "" });
    } catch (error: unknown) {
      constructionError = error;
    }
    expect(constructionError).toBeInstanceOf(TuvrenPersistenceError);
    expect(constructionError).toMatchObject({
      code: "postgres_backend_invalid_schema_name",
      details: { schemaName: "INVALID!" },
      message:
        'postgres backend schema "INVALID!" must match ^[a-z][a-z0-9_-]*$',
      name: "TuvrenPersistenceError",
    });
    if (!(constructionError instanceof TuvrenPersistenceError)) {
      throw new TypeError("expected a schema-name persistence error");
    }
    if (
      typeof constructionError.details !== "object" ||
      constructionError.details === null ||
      Array.isArray(constructionError.details)
    ) {
      throw new TypeError("expected object-shaped constructor error details");
    }
    expect(Object.keys(constructionError.details)).toEqual(["schemaName"]);
  });
}
