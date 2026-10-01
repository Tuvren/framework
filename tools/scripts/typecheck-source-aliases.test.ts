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

// KRT-BP005 source-only typecheck contracts. The three testkit typecheck
// configs grew `smoke/**/*.ts` membership in M9; those smoke files import their
// own package by name (`@tuvren/framework-testkit`, …). TypeScript's package
// self-reference resolves that import through package.json `exports` to
// `dist/index.d.ts`, which does not exist on a fresh checkout — so the configs
// must carry a source `paths` alias for their own package. This suite proves
// resolution lands on `src/index.ts` and, with the alias removed, reproduces
// the fresh-checkout failure even though this machine has warmed `dist/`.
//
// The hiding host is read-only: it reports the three `dist/` trees as absent to
// the compiler without touching them, matching how the installed TypeScript
// 6.0.2 API (`getParsedCommandLineOfConfigFile`, `resolveModuleName`,
// `createProgram`) performs module resolution.
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import path from "node:path";

import ts from "typescript";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");

interface TestkitCase {
  config: string;
  packageName: string;
  smokeFile: string;
}

const TESTKITS: readonly TestkitCase[] = [
  {
    config: "typescript/testkit/tsconfig.typecheck.json",
    packageName: "@tuvren/framework-testkit",
    smokeFile: "typescript/testkit/smoke/package-exports.ts",
  },
  {
    config: "typescript/kernel/testkit/tsconfig.typecheck.json",
    packageName: "@tuvren/kernel-testkit",
    smokeFile: "typescript/kernel/testkit/smoke/package-exports.ts",
  },
  {
    config: "typescript/providers/testkit/tsconfig.typecheck.json",
    packageName: "@tuvren/provider-testkit",
    smokeFile: "typescript/providers/testkit/smoke/package-exports.ts",
  },
];

const HIDDEN_DIST_DIRECTORIES = [
  "typescript/testkit/dist",
  "typescript/kernel/testkit/dist",
  "typescript/providers/testkit/dist",
].map((relative) => path.join(REPO_ROOT, relative));

const UNRESOLVED_MODULE_CODE = 2307;

function isHiddenOutput(fileName: string): boolean {
  const normalized = path.resolve(fileName);
  return HIDDEN_DIST_DIRECTORIES.some(
    (directory) =>
      normalized === directory ||
      normalized.startsWith(`${directory}${path.sep}`)
  );
}

// Read-only mirror of `ts.sys` that pretends the three testkit build-output
// trees do not exist. Nothing on disk is modified or deleted.
function hidingModuleResolutionHost(): ts.ModuleResolutionHost {
  return {
    directoryExists: (directory) => ts.sys.directoryExists(directory),
    fileExists: (fileName) =>
      !isHiddenOutput(fileName) && ts.sys.fileExists(fileName),
    getCurrentDirectory: () => REPO_ROOT,
    readFile: (fileName) =>
      isHiddenOutput(fileName) ? undefined : ts.sys.readFile(fileName),
    realpath: (fileName) => ts.sys.realpath?.(fileName) ?? fileName,
  };
}

function parseConfig(relative: string): ts.ParsedCommandLine {
  const host: ts.ParseConfigFileHost = {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (diagnostic): void => {
      throw new Error(
        ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")
      );
    },
  };
  const parsed = ts.getParsedCommandLineOfConfigFile(
    path.join(REPO_ROOT, relative),
    {},
    host
  );
  if (parsed === undefined) {
    throw new Error(`${relative} did not parse`);
  }
  return parsed;
}

function withoutSelfAlias(
  options: ts.CompilerOptions,
  packageName: string
): ts.CompilerOptions {
  const paths = { ...(options.paths ?? {}) };
  delete paths[packageName];
  return { ...options, paths };
}

function unresolvedDiagnostics(
  options: ts.CompilerOptions,
  fileNames: readonly string[]
): ts.Diagnostic[] {
  const host = ts.createCompilerHost(options);
  const fileExists = host.fileExists.bind(host);
  const readFile = host.readFile.bind(host);
  host.fileExists = (fileName) =>
    !isHiddenOutput(fileName) && fileExists(fileName);
  host.readFile = (fileName) =>
    isHiddenOutput(fileName) ? undefined : readFile(fileName);
  const program = ts.createProgram([...fileNames], options, host);
  return ts
    .getPreEmitDiagnostics(program)
    .filter((diagnostic) => diagnostic.code === UNRESOLVED_MODULE_CODE);
}

function sourceFor(testkit: TestkitCase): string {
  return path.join(path.dirname(path.join(REPO_ROOT, testkit.config)), "src");
}

describe("testkit source-only self aliases", () => {
  for (const testkit of TESTKITS) {
    const { config, packageName, smokeFile } = testkit;
    const selfSourceIndex = path.join(sourceFor(testkit), "index.ts");
    const smokeAbsolute = path.join(REPO_ROOT, smokeFile);

    test(`${packageName} resolves to source with build output hidden`, () => {
      const parsed = parseConfig(config);
      const resolved = ts.resolveModuleName(
        packageName,
        smokeAbsolute,
        parsed.options,
        hidingModuleResolutionHost()
      );

      expect(existsSync(selfSourceIndex)).toBe(true);
      expect(resolved.resolvedModule?.resolvedFileName).toBe(selfSourceIndex);
      expect(resolved.resolvedModule?.extension).toBe(ts.Extension.Ts);
      expect(resolved.resolvedModule?.isExternalLibraryImport).toBe(false);
    });

    test(`${packageName} typechecks its smoke source without declarations`, () => {
      const parsed = parseConfig(config);
      expect(unresolvedDiagnostics(parsed.options, parsed.fileNames)).toEqual(
        []
      );
    });

    test(`${packageName} fails to resolve without its self alias`, () => {
      const parsed = parseConfig(config);
      const broken = withoutSelfAlias(parsed.options, packageName);
      const resolved = ts.resolveModuleName(
        packageName,
        smokeAbsolute,
        broken,
        hidingModuleResolutionHost()
      );

      // The alias is the only source resolution: without it, the self
      // reference falls back to the absent `dist` declarations and fails, so
      // this reproduces the fresh-checkout TS2307 while warmed `dist/` exists.
      expect(resolved.resolvedModule).toBeUndefined();
      expect(unresolvedDiagnostics(broken, parsed.fileNames).length).toBe(1);
    });
  }
});
