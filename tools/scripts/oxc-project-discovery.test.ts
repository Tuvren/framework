// ADR-0070 / KRT-BP005 type-aware project discovery. tsgolint resolves each
// project through its root `tsconfig.json` and the configs it references;
// tests, benches and smoke files live only in `tsconfig.typecheck.json`. The
// certification wrappers lacked a root project config and the conformance
// adapters lacked both root and typecheck configs, so those source trees never
// entered the type-aware program.
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { loadNxProjectFiles, targetCommandStrings } from "./lib/nx-projects.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");

const CERTIFICATION_WRAPPER_ROOTS = [
  "typescript/certification",
  "typescript/kernel/certification",
  "typescript/providers/certification",
] as const;

const CONFORMANCE_ADAPTER_ROOTS = [
  "typescript/conformance-adapter",
  "typescript/kernel/conformance-adapter",
  "typescript/providers/conformance-adapter",
] as const;

// M9a package roots: the kernel roots plus the core/sdk/runtime/testkit/runners
// and tools roots. The kernel certification wrappers and the three conformance
// adapters belong to M8's completed discovery proof above.
const M9A_PACKAGE_ROOTS = [
  "typescript/core",
  "typescript/kernel/backends/memory",
  "typescript/kernel/backends/postgres",
  "typescript/kernel/backends/shared",
  "typescript/kernel/backends/sqlite",
  "typescript/kernel/grpc-client",
  "typescript/kernel/protocol",
  "typescript/kernel/runtime",
  "typescript/kernel/testkit",
  "typescript/runners/react",
  "typescript/runtime",
  "typescript/sdk",
  "typescript/testkit",
  "typescript/tools/mcp-client",
] as const;

const LOCAL_SOURCE_DIRS = ["bench", "smoke", "src", "test"] as const;

interface ProjectTsConfig {
  compilerOptions?: Record<string, unknown>;
  files?: unknown[];
  include?: unknown;
  references?: { path?: unknown }[];
}

function parseJson<T>(text: string): T {
  return JSON.parse(text) as T;
}

function readProjectTsConfig(relativePath: string): ProjectTsConfig {
  return parseJson<ProjectTsConfig>(
    readFileSync(path.join(REPO_ROOT, relativePath), "utf8")
  );
}

function referencesTypecheck(config: ProjectTsConfig): boolean {
  return (config.references ?? []).some(
    (reference) => reference.path === "./tsconfig.typecheck.json"
  );
}

// M9a readers. The package-root proof starts from `JSON.parse` as `unknown` and
// narrows each field it reads, so a malformed or reshaped config fails loudly
// instead of being cast into the expected interface.
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readConfigDocument(relativePath: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(
    readFileSync(path.join(REPO_ROOT, relativePath), "utf8")
  );
  if (!isRecord(parsed)) {
    throw new Error(`${relativePath} is not a JSON object`);
  }
  return parsed;
}

function referencedPaths(config: Record<string, unknown>): string[] {
  if (!Array.isArray(config.references)) {
    return [];
  }
  const paths: string[] = [];
  for (const reference of config.references) {
    if (isRecord(reference) && typeof reference.path === "string") {
      paths.push(reference.path);
    }
  }
  return paths;
}

function includedPatterns(config: Record<string, unknown>): string[] {
  if (!Array.isArray(config.include)) {
    return [];
  }
  return config.include.filter(
    (entry): entry is string => typeof entry === "string"
  );
}

function compilerFlag(
  config: Record<string, unknown>,
  key: string
): boolean | undefined {
  const compilerOptions = config.compilerOptions;
  if (!isRecord(compilerOptions)) {
    return undefined;
  }
  const value = compilerOptions[key];
  return typeof value === "boolean" ? value : undefined;
}

function hasTypeScriptFiles(directory: string): boolean {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (hasTypeScriptFiles(path.join(directory, entry.name))) {
        return true;
      }
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      return true;
    }
  }
  return false;
}

describe("type-aware project discovery", () => {
  test("certification wrappers expose their typecheck config through a root reference", () => {
    for (const root of CERTIFICATION_WRAPPER_ROOTS) {
      const rootConfig = readProjectTsConfig(path.join(root, "tsconfig.json"));
      expect(rootConfig.files, `${root} files`).toEqual([]);
      expect(referencesTypecheck(rootConfig), `${root} reference`).toBe(true);

      // The root config must not replace the existing source-only typecheck
      // config with a declaration/emit config.
      const typecheck = readProjectTsConfig(
        path.join(root, "tsconfig.typecheck.json")
      );
      expect(typecheck.compilerOptions?.noEmit, `${root} noEmit`).toBe(true);
      expect(typecheck.compilerOptions?.composite, `${root} composite`).toBe(
        false
      );
    }
  });

  test("conformance adapters expose source-only root and typecheck configs", () => {
    for (const root of CONFORMANCE_ADAPTER_ROOTS) {
      const rootConfig = readProjectTsConfig(path.join(root, "tsconfig.json"));
      expect(rootConfig.files, `${root} files`).toEqual([]);
      expect(referencesTypecheck(rootConfig), `${root} reference`).toBe(true);

      const typecheck = readProjectTsConfig(
        path.join(root, "tsconfig.typecheck.json")
      );
      expect(typecheck.compilerOptions?.noEmit, `${root} noEmit`).toBe(true);
      expect(typecheck.compilerOptions?.composite, `${root} composite`).toBe(
        false
      );
      expect(typecheck.include, `${root} include`).toEqual(
        expect.arrayContaining(["src/**/*.ts"])
      );
    }
  });

  test("every conformance adapter routes a native source-only typecheck", () => {
    const projects = loadNxProjectFiles(REPO_ROOT);
    const byRoot = new Map(
      projects.map((project) => [path.dirname(project.path), project])
    );

    for (const root of CONFORMANCE_ADAPTER_ROOTS) {
      const project = byRoot.get(root);
      expect(project, `${root} project.json`).toBeDefined();
      const commands =
        project === undefined
          ? []
          : targetCommandStrings(project.project.targets?.typecheck ?? {});
      expect(commands, `${root} typecheck`).toContain(
        `bun tools/scripts/typecheck-project.ts ${root}`
      );
    }
  });

  test("M9a package roots reference their lib and typecheck aggregators", () => {
    for (const root of M9A_PACKAGE_ROOTS) {
      const rootConfig = readConfigDocument(path.join(root, "tsconfig.json"));
      expect(rootConfig.files, `${root} files`).toEqual([]);
      const references = referencedPaths(rootConfig);
      expect(references, `${root} lib reference`).toContain(
        "./tsconfig.lib.json"
      );
      expect(references, `${root} typecheck reference`).toContain(
        "./tsconfig.typecheck.json"
      );

      const typecheck = readConfigDocument(
        path.join(root, "tsconfig.typecheck.json")
      );
      expect(compilerFlag(typecheck, "composite"), `${root} composite`).toBe(
        false
      );
    }
  });

  test("M9a typecheck aggregators cover every local TypeScript source directory", () => {
    for (const root of M9A_PACKAGE_ROOTS) {
      const typecheck = readConfigDocument(
        path.join(root, "tsconfig.typecheck.json")
      );
      const include = includedPatterns(typecheck);
      for (const directory of LOCAL_SOURCE_DIRS) {
        const absolute = path.join(REPO_ROOT, root, directory);
        if (existsSync(absolute) && hasTypeScriptFiles(absolute)) {
          expect(include, `${root} ${directory}`).toContain(
            `${directory}/**/*.ts`
          );
        }
      }
    }
  });
});
