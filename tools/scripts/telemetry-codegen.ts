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

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type RunCommandResult, runCommand } from "./lib/command-runner.js";

interface ResolvedTelemetryAttribute {
  brief: string;
  examples: string[];
  key: string;
  stability: string;
  type: string;
}

interface ResolvedTelemetryRegistry {
  attributes: ResolvedTelemetryAttribute[];
  registryUrl: string;
  schemaUrl: string;
}

interface TelemetryGeneratorPlan {
  rust: TelemetryGeneratorTarget;
  typescript: TelemetryGeneratorTarget;
}

interface TelemetryGeneratorTarget {
  enabled: boolean;
  outputPath: string;
  templatePath: string;
}

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SEMCONV_REGISTRY_PATH = "telemetry/semconv";
const WEAVER_TEMPLATE_ROOT = resolve(REPO_ROOT, "tools/generators/telemetry");
const WEAVER_RESOLVED_REGISTRY_TARGET = "resolved-registry";
const GENERATOR_PLAN_PATH = resolve(
  REPO_ROOT,
  "tools/generators/telemetry/generator-plan.json"
);
const REGISTRY_MANIFEST_PATH = resolve(
  REPO_ROOT,
  "telemetry/semconv/registry_manifest.yaml"
);
const MARKDOWN_OUTPUT_PATH = resolve(
  REPO_ROOT,
  "telemetry/semantic-conventions.md"
);
const JSON_OUTPUT_PATH = resolve(REPO_ROOT, "telemetry/otel-attributes.json");
const NEWLINE_PATTERN = /\r?\n/u;

await main();

async function main(): Promise<void> {
  await ensureWeaverIsAvailable();
  await runWeaverRegistryCheck();
  const generatorPlan = await readGeneratorPlan();
  const typescriptOutputPath = resolve(
    REPO_ROOT,
    generatorPlan.typescript.outputPath
  );
  const rustOutputPath = resolve(REPO_ROOT, generatorPlan.rust.outputPath);

  const temporaryDirectory = await mkdtemp(
    resolve(tmpdir(), "tuvren-telemetry-")
  );

  try {
    const resolvedRegistry = await generateResolvedWeaverRegistry(
      temporaryDirectory,
      await readRegistrySchemaUrl()
    );

    await mkdir(dirname(MARKDOWN_OUTPUT_PATH), { recursive: true });
    await mkdir(dirname(JSON_OUTPUT_PATH), { recursive: true });
    await mkdir(dirname(typescriptOutputPath), { recursive: true });
    await mkdir(dirname(rustOutputPath), { recursive: true });

    await writeFile(
      MARKDOWN_OUTPUT_PATH,
      renderTelemetryMarkdown(resolvedRegistry)
    );
    await writeFile(
      JSON_OUTPUT_PATH,
      `${JSON.stringify(
        {
          attributes: resolvedRegistry.attributes,
          registryUrl: resolvedRegistry.registryUrl,
          schemaUrl: resolvedRegistry.schemaUrl,
        },
        null,
        2
      )}\n`
    );
    await writeFile(
      typescriptOutputPath,
      renderTelemetryTypescript(resolvedRegistry)
    );
    await writeRustTelemetryOutput(
      generatorPlan.rust,
      rustOutputPath,
      resolvedRegistry
    );
    // Rust telemetry can still be disabled by the generator plan, so rustfmt
    // only runs when this invocation actually wrote the Rust target file.
    await formatGeneratedOutputs(
      typescriptOutputPath,
      generatorPlan.rust.enabled ? rustOutputPath : undefined
    );
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
}

async function readGeneratorPlan(): Promise<TelemetryGeneratorPlan> {
  const planText = await readFile(GENERATOR_PLAN_PATH, "utf8");
  const plan = JSON.parse(planText);

  if (!isRecord(plan)) {
    throw new Error("telemetry generator plan must be an object");
  }

  return {
    rust: readGeneratorTarget(plan.rust, "rust"),
    typescript: readGeneratorTarget(plan.typescript, "typescript"),
  };
}

function readGeneratorTarget(
  value: unknown,
  label: string
): TelemetryGeneratorTarget {
  if (
    !isRecord(value) ||
    typeof value.outputPath !== "string" ||
    typeof value.templatePath !== "string"
  ) {
    throw new Error(`telemetry generator ${label} target is invalid`);
  }

  return {
    enabled: value.enabled === true,
    outputPath: value.outputPath,
    templatePath: value.templatePath,
  };
}

async function writeRustTelemetryOutput(
  rustTarget: TelemetryGeneratorTarget,
  rustOutputPath: string,
  resolvedRegistry: ResolvedTelemetryRegistry
): Promise<void> {
  await readFile(resolve(REPO_ROOT, rustTarget.templatePath), "utf8");

  if (!rustTarget.enabled) {
    return;
  }

  await writeFile(rustOutputPath, renderTelemetryRust(resolvedRegistry));
}

async function ensureWeaverIsAvailable(): Promise<void> {
  let result: RunCommandResult;

  try {
    result = await runCommand(["weaver", "--version"], {
      captureOutput: true,
      cwd: REPO_ROOT,
    });
  } catch {
    throw new Error(
      "weaver is required on PATH; activate the repo environment with direnv before running telemetry code generation"
    );
  }

  if (result.code === 0) {
    return;
  }

  throw new Error(
    "weaver is required on PATH; activate the repo environment with direnv before running telemetry code generation"
  );
}

async function runWeaverRegistryCheck(): Promise<void> {
  const result = await runCommand(
    ["weaver", "registry", "check", "-r", SEMCONV_REGISTRY_PATH, "--future"],
    {
      captureOutput: true,
      cwd: REPO_ROOT,
    }
  );

  if (result.code !== 0) {
    throw new Error(
      result.stderr || result.stdout || "weaver registry check failed"
    );
  }
}

async function generateResolvedWeaverRegistry(
  outputDirectory: string,
  schemaUrl: string
): Promise<ResolvedTelemetryRegistry> {
  // Upstream Weaver deprecated `registry resolve`, but the repo-pinned build
  // in this workspace does not yet ship `registry package`. Epic R therefore
  // stays on the supported `registry generate` family with a repo-owned target
  // that emits the resolved-registry JSON we consume below.
  const result = await runCommand(
    [
      "weaver",
      "registry",
      "generate",
      "--future",
      "-r",
      SEMCONV_REGISTRY_PATH,
      "-t",
      WEAVER_TEMPLATE_ROOT,
      WEAVER_RESOLVED_REGISTRY_TARGET,
      outputDirectory,
    ],
    {
      captureOutput: true,
      cwd: REPO_ROOT,
    }
  );

  if (result.code !== 0) {
    throw new Error(
      result.stderr || result.stdout || "weaver registry generate failed"
    );
  }

  const resolvedJson = await readFile(
    resolve(outputDirectory, "resolved-registry.json"),
    "utf8"
  );

  return parseResolvedTelemetryRegistry(resolvedJson, schemaUrl);
}

async function readRegistrySchemaUrl(): Promise<string> {
  const manifestText = await readFile(REGISTRY_MANIFEST_PATH, "utf8");
  let schemaBaseUrl = "";
  let semconvVersion = "";

  for (const line of manifestText.split(NEWLINE_PATTERN)) {
    if (line.startsWith("schema_base_url: ")) {
      schemaBaseUrl = line.slice("schema_base_url: ".length);
      continue;
    }

    if (line.startsWith("semconv_version: ")) {
      semconvVersion = line.slice("semconv_version: ".length);
    }
  }

  if (schemaBaseUrl.length === 0 || semconvVersion.length === 0) {
    throw new Error(
      "registry_manifest.yaml must define schema_base_url and semconv_version"
    );
  }

  return `${schemaBaseUrl}${semconvVersion}`;
}

async function formatGeneratedOutputs(
  typescriptOutputPath: string,
  rustOutputPath: string | undefined
): Promise<void> {
  const result = await runCommand(
    [
      "bunx",
      "--bun",
      "@biomejs/biome",
      "check",
      "--write",
      MARKDOWN_OUTPUT_PATH,
      JSON_OUTPUT_PATH,
      typescriptOutputPath,
    ],
    {
      captureOutput: true,
      cwd: REPO_ROOT,
    }
  );

  if (result.code !== 0) {
    throw new Error(
      result.stderr ||
        result.stdout ||
        "formatting generated telemetry outputs failed"
    );
  }

  if (rustOutputPath == null) {
    return;
  }

  const rustfmtResult = await runCommand(["rustfmt", rustOutputPath], {
    captureOutput: true,
    cwd: REPO_ROOT,
  });

  if (rustfmtResult.code !== 0) {
    throw new Error(
      rustfmtResult.stderr ||
        rustfmtResult.stdout ||
        "formatting generated Rust telemetry output failed"
    );
  }
}

function parseResolvedTelemetryRegistry(
  jsonText: string,
  schemaUrl: string
): ResolvedTelemetryRegistry {
  const parsedRegistry = JSON.parse(jsonText);

  if (!isRecord(parsedRegistry)) {
    throw new Error("resolved telemetry registry must be an object");
  }

  if (
    typeof parsedRegistry.registry_url !== "string" ||
    parsedRegistry.registry_url.length === 0
  ) {
    throw new Error("resolved telemetry registry is missing registry_url");
  }

  return {
    attributes: collectResolvedTelemetryAttributes(parsedRegistry.groups),
    registryUrl: parsedRegistry.registry_url,
    schemaUrl,
  };
}

function normalizeResolvedTelemetryAttribute(
  value: Partial<ResolvedTelemetryAttribute>
): ResolvedTelemetryAttribute {
  if (
    typeof value.key !== "string" ||
    typeof value.type !== "string" ||
    typeof value.brief !== "string" ||
    typeof value.stability !== "string" ||
    !Array.isArray(value.examples)
  ) {
    throw new Error("resolved telemetry attribute is incomplete");
  }

  return {
    brief: value.brief,
    examples: value.examples,
    key: value.key,
    stability: value.stability,
    type: value.type,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function collectResolvedTelemetryAttributes(
  groups: unknown
): ResolvedTelemetryAttribute[] {
  if (!Array.isArray(groups)) {
    throw new Error("resolved telemetry registry groups must be an array");
  }

  const attributes: ResolvedTelemetryAttribute[] = [];

  for (const group of groups) {
    if (!(isRecord(group) && Array.isArray(group.attributes))) {
      continue;
    }

    for (const attribute of group.attributes) {
      if (!isRecord(attribute)) {
        continue;
      }

      attributes.push(
        normalizeResolvedTelemetryAttribute({
          brief: attribute.brief,
          examples: attribute.examples,
          key: attribute.name,
          stability: attribute.stability,
          type: attribute.type,
        })
      );
    }
  }

  return attributes;
}

function renderTelemetryMarkdown(registry: ResolvedTelemetryRegistry): string {
  const tableRows = registry.attributes
    .map(
      (attribute) =>
        `| \`${attribute.key}\` | \`${attribute.type}\` | \`${attribute.stability}\` | ${attribute.brief} | ${attribute.examples
          .map((example) => `\`${example}\``)
          .join(", ")} |`
    )
    .join("\n");

  return `# Tuvren Runtime Semantic Conventions

Generated from \`telemetry/semconv/tuvren-runtime.yaml\` via \`weaver\`.

- Schema URL: \`${registry.schemaUrl}\`
- Resolved registry: \`${registry.registryUrl}\`

| Attribute | Type | Stability | Brief | Examples |
| --- | --- | --- | --- | --- |
${tableRows}
`;
}

function renderTelemetryTypescript(
  registry: ResolvedTelemetryRegistry
): string {
  const attributeEntries = registry.attributes
    .map(
      (attribute) =>
        `  "${attribute.key}": {\n    brief: ${JSON.stringify(
          attribute.brief
        )},\n    examples: ${JSON.stringify(
          attribute.examples
        )},\n    stability: ${JSON.stringify(
          attribute.stability
        )},\n    type: ${JSON.stringify(attribute.type)},\n  },`
    )
    .join("\n");

  const attributeKeys = registry.attributes
    .map((attribute) => `    "${attribute.key}",`)
    .join("\n");
  const attributeKeyUnion = registry.attributes
    .map((attribute) => JSON.stringify(attribute.key))
    .join(" |\n  ");

  return `/**
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

export interface TuvrenRuntimeTelemetryAttributeDefinition {
  readonly brief: string;
  readonly examples: readonly string[];
  readonly stability: string;
  readonly type: string;
}

export const TUVREN_RUNTIME_TELEMETRY_SCHEMA_URL = ${JSON.stringify(
    registry.schemaUrl
  )};

export const TUVREN_RUNTIME_TELEMETRY_ATTRIBUTES: Readonly<
  Record<string, TuvrenRuntimeTelemetryAttributeDefinition>
> = Object.freeze({
${attributeEntries}
});

export type TuvrenRuntimeTelemetryAttributeKey =
  ${attributeKeyUnion};

export const TUVREN_RUNTIME_TELEMETRY_ATTRIBUTE_KEYS: readonly TuvrenRuntimeTelemetryAttributeKey[] =
  Object.freeze([
${attributeKeys}
  ]);
`;
}

function renderTelemetryRust(registry: ResolvedTelemetryRegistry): string {
  const attributeEntries = registry.attributes
    .map(
      (attribute) =>
        `    TuvrenRuntimeTelemetryAttributeDefinition {\n        key: ${JSON.stringify(
          attribute.key
        )},\n        brief: ${JSON.stringify(
          attribute.brief
        )},\n        examples: &[${attribute.examples
          .map((example) => JSON.stringify(example))
          .join(", ")}],\n        stability: ${JSON.stringify(
          attribute.stability
        )},\n        r#type: ${JSON.stringify(attribute.type)},\n    },`
    )
    .join("\n");

  const attributeKeys = registry.attributes
    .map((attribute) => `    ${JSON.stringify(attribute.key)},`)
    .join("\n");

  return `// Copyright 2026 Oscar Yáñez Cisterna (@SkrOYC)
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
//
// Generated from telemetry/semconv/tuvren-runtime.yaml via weaver.

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct TuvrenRuntimeTelemetryAttributeDefinition {
    pub key: &'static str,
    pub brief: &'static str,
    pub examples: &'static [&'static str],
    pub stability: &'static str,
    pub r#type: &'static str,
}

pub const TUVREN_RUNTIME_TELEMETRY_SCHEMA_URL: &str = ${JSON.stringify(
    registry.schemaUrl
  )};

pub const TUVREN_RUNTIME_TELEMETRY_ATTRIBUTES: &[TuvrenRuntimeTelemetryAttributeDefinition] = &[
${attributeEntries}
];

pub const TUVREN_RUNTIME_TELEMETRY_ATTRIBUTE_KEYS: &[&str] = &[
${attributeKeys}
];
`;
}
