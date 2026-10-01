// ADR-0070 / KRT-BP005 type-aware project discovery. tsgolint resolves each
// project through its root `tsconfig.json` and the configs it references;
// tests, benches and smoke files live only in `tsconfig.typecheck.json`. The
// certification wrappers lacked a root project config and the conformance
// adapters lacked both root and typecheck configs, so those source trees never
// entered the type-aware program.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
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
});
