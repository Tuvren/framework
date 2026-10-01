// ADR-0070 / KRT-BP005 type-aware project discovery. tsgolint resolves each
// project through its root `tsconfig.json` and the configs it references;
// tests, benches and smoke files live only in `tsconfig.typecheck.json`. The
// certification wrappers lacked a root project config and the conformance
// adapters lacked both root and typecheck configs, so those source trees never
// entered the type-aware program. M9a covered the first 14 package roots; M9b
// covers the remaining 13 and proves the compiler-parsed membership of every
// intended source file.
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import ts from "typescript";

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

// M9b package roots: the host, providers, streaming and telemetry roots. These
// are the remaining package `tsconfig.json` files that lacked a typecheck
// reference when M9a landed.
const M9B_PACKAGE_ROOTS = [
  "typescript/host/remote-session",
  "typescript/host/repl",
  "typescript/host/session",
  "typescript/host/session-client",
  "typescript/providers/bridge-ai-sdk",
  "typescript/providers/provider-api",
  "typescript/providers/testkit",
  "typescript/streaming/agui",
  "typescript/streaming/core",
  "typescript/streaming/sse",
  "typescript/streaming/ws",
  "typescript/telemetry/otel",
  "typescript/telemetry/semconv",
] as const;

const PACKAGE_ROOTS = [...M9A_PACKAGE_ROOTS, ...M9B_PACKAGE_ROOTS] as const;

const ALL_PROJECT_ROOTS = [
  ...PACKAGE_ROOTS,
  ...CERTIFICATION_WRAPPER_ROOTS,
  ...CONFORMANCE_ADAPTER_ROOTS,
] as const;

const LOCAL_SOURCE_DIRS = ["bench", "smoke", "src", "test"] as const;

interface ProjectTsConfig {
  compilerOptions?: Record<string, unknown>;
  files?: unknown[];
  include?: unknown;
  references?: { path?: unknown }[];
}

interface ParsedProject {
  errors: string[];
  fileNames: Set<string>;
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

// The membership proof must read the compiler's parsed file set, including the
// inherited `include`/`exclude` rules, rather than the raw include strings. The
// host is `ts.sys` plus the one method the API requires for unrecoverable
// config diagnostics.
function parseProjectFiles(relativeConfigPath: string): ParsedProject {
  const configPath = path.join(REPO_ROOT, relativeConfigPath);
  const host: ts.ParseConfigFileHost = {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (diagnostic): void => {
      throw new Error(
        `${relativeConfigPath}: ${ts.flattenDiagnosticMessageText(
          diagnostic.messageText,
          " "
        )}`
      );
    },
  };
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, host);
  if (parsed === undefined) {
    throw new Error(`${relativeConfigPath} did not parse`);
  }
  const fileNames = new Set(
    parsed.fileNames.map((fileName) => path.normalize(fileName))
  );
  const errors = parsed.errors.map(
    (diagnostic) =>
      `TS${diagnostic.code} ${ts.flattenDiagnosticMessageText(
        diagnostic.messageText,
        " "
      )}`
  );
  return { errors, fileNames };
}

function collectTypeScriptFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTypeScriptFiles(absolute));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(absolute);
    }
  }
  return files;
}

function hasTypeScriptFiles(directory: string): boolean {
  return collectTypeScriptFiles(directory).length > 0;
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

  test("all 33 package, wrapper and adapter roots expose a root project config", () => {
    expect(ALL_PROJECT_ROOTS.length).toBe(33);
    for (const root of ALL_PROJECT_ROOTS) {
      expect(
        existsSync(path.join(REPO_ROOT, root, "tsconfig.json")),
        `${root} tsconfig.json`
      ).toBe(true);
    }
  });

  test("package roots reference their lib and typecheck aggregators", () => {
    for (const root of PACKAGE_ROOTS) {
      const rootConfig = readConfigDocument(path.join(root, "tsconfig.json"));
      expect(rootConfig.files, `${root} files`).toEqual([]);
      const references = referencedPaths(rootConfig);
      expect(references, `${root} lib reference`).toContain(
        "./tsconfig.lib.json"
      );
      expect(references, `${root} typecheck reference`).toContain(
        "./tsconfig.typecheck.json"
      );
      // tsgolint selects the first matching project reference, so the
      // typecheck aggregator must precede the lib project for source files.
      expect(
        references.indexOf("./tsconfig.typecheck.json"),
        `${root} typecheck precedes lib`
      ).toBeLessThan(references.indexOf("./tsconfig.lib.json"));

      const typecheck = readConfigDocument(
        path.join(root, "tsconfig.typecheck.json")
      );
      expect(compilerFlag(typecheck, "composite"), `${root} composite`).toBe(
        false
      );
    }
  });

  test("typecheck aggregators cover every local TypeScript source directory", () => {
    for (const root of PACKAGE_ROOTS) {
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

  // tsgolint rejects a referenced project whose `allowImportingTsExtensions`
  // has no matching no-emit setting with `typescript(tsconfig-error)`. That
  // surfaced as project-resolution noise after M9a referenced the package
  // aggregators, so every typecheck config that imports `.ts` extensions must
  // disable emit.
  test("type-aware package typecheck configs disable emit at the config level", () => {
    for (const root of PACKAGE_ROOTS) {
      const typecheck = readConfigDocument(
        path.join(root, "tsconfig.typecheck.json")
      );
      if (compilerFlag(typecheck, "allowImportingTsExtensions") === true) {
        expect(compilerFlag(typecheck, "noEmit"), `${root} noEmit`).toBe(true);
      }
    }
  });

  // Full membership proof: resolve the root project's typecheck reference,
  // parse it with the installed TypeScript compiler, and require every actual
  // src/test/bench/smoke file to appear in the compiler-parsed file set. This
  // catches inherited include/exclude rules a string check would miss and stops
  // files from being dropped to manufacture zero resolution errors.
  test("every intended package source file resolves through the parsed typecheck project", () => {
    for (const root of PACKAGE_ROOTS) {
      const rootConfig = readConfigDocument(path.join(root, "tsconfig.json"));
      expect(
        referencedPaths(rootConfig),
        `${root} typecheck reference`
      ).toContain("./tsconfig.typecheck.json");

      const parsed = parseProjectFiles(
        path.join(root, "tsconfig.typecheck.json")
      );
      expect(parsed.errors, `${root} config errors`).toEqual([]);

      for (const directory of LOCAL_SOURCE_DIRS) {
        const absolute = path.join(REPO_ROOT, root, directory);
        if (!existsSync(absolute)) {
          continue;
        }
        for (const file of collectTypeScriptFiles(absolute)) {
          expect(
            parsed.fileNames.has(path.normalize(file)),
            `${root} missing ${path.relative(REPO_ROOT, file)}`
          ).toBe(true);
        }
      }
    }
  });

  test("the tools discovery config covers its actual TypeScript inventory", () => {
    const parsed = parseProjectFiles("tools/tsconfig.json");
    expect(parsed.errors, "tools/tsconfig.json errors").toEqual([]);
    for (const directory of ["scripts", "conformance"] as const) {
      const absolute = path.join(REPO_ROOT, "tools", directory);
      for (const file of collectTypeScriptFiles(absolute)) {
        expect(
          parsed.fileNames.has(path.normalize(file)),
          `tools missing ${path.relative(REPO_ROOT, file)}`
        ).toBe(true);
      }
    }
  });
});
