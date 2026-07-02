#!/usr/bin/env bun
/**
 * KRT-AP006: One-shot codemod to rewrite all imports from the five retired
 * contract packages to @tuvren/core subpaths.
 *
 * Scope: all .ts source files under boundaries/ and tools/ except:
 *   - dist/, node_modules/, generated/ directories (generated artifacts)
 *   - The 5 retiring package src/ dirs (replaced wholesale by KRT-AP007)
 *   - @tuvren/core's own src/ (already uses relative imports)
 *
 * Usage:
 *   bun tools/scripts/migrate-to-core.ts           # rewrite in place
 *   bun tools/scripts/migrate-to-core.ts --dry-run  # report only
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";

const DRY_RUN = process.argv.includes("--dry-run");
const ROOT = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");

// Directory names that signal generated or unmanaged trees — skip entirely.
const EXCLUDE_DIR_NAMES = new Set([
  "dist",
  "node_modules",
  "generated",
  ".turbo",
  "artifacts",
]);

// Source directories whose contents will be replaced wholesale by KRT-AP007.
// Also includes the new @tuvren/core src (already uses relative imports).
const EXCLUDE_SRC_PREFIXES = [
  "typescript/core/src",
  "typescript/core-types/src",
  "boundaries/framework/contracts/runtime-api/implementations/typescript/src",
  "boundaries/framework/contracts/event-stream/implementations/typescript/src",
  "boundaries/framework/contracts/tool-contracts/implementations/typescript/src",
  "boundaries/framework/contracts/driver-api/implementations/typescript/src",
  // The codemod script itself
  "tools/scripts/migrate-to-core.ts",
].map((p) => join(ROOT, p));

// ─── Direct module-specifier remaps ───────────────────────────────────────────
// For these packages every import maps to one new target; no per-symbol work needed.

const DIRECT_REMAPS: [old: string, next: string][] = [
  ["@tuvren/core-types", "@tuvren/core"],
  ["@tuvren/runtime-api/events", "@tuvren/core/events"],
  ["@tuvren/runtime-api/execution", "@tuvren/core/execution"],
  ["@tuvren/runtime-api/orchestration", "@tuvren/core/execution"],
  ["@tuvren/runtime-api/tools", "@tuvren/core/tools"],
  ["@tuvren/runtime-api/provider", "@tuvren/core/provider"],
  ["@tuvren/event-stream", "@tuvren/core/events"],
  ["@tuvren/tool-contracts", "@tuvren/core/tools"],
  ["@tuvren/driver-api", "@tuvren/core/driver"],
];

// ─── Per-symbol routing for @tuvren/runtime-api (root) ───────────────────────
// The root facade re-exports from multiple logical areas; each symbol routes to
// the matching focused @tuvren/core/<subpath>.

const RUNTIME_API_ROOT_ROUTING: Record<string, string> = {
  // Primitive types (re-exported at runtime-api root from @tuvren/core-types)
  EpochMs: "@tuvren/core",
  HashString: "@tuvren/core",
  KernelRecord: "@tuvren/core",
  // Errors
  TuvrenValidationError: "@tuvren/core/errors",
  // Events
  ApprovalRequestedEvent: "@tuvren/core/events",
  ApprovalResolvedEvent: "@tuvren/core/events",
  CustomEvent: "@tuvren/core/events",
  DriverAttributedEventSource: "@tuvren/core/events",
  ErrorEvent: "@tuvren/core/events",
  EventSource: "@tuvren/core/events",
  FileDoneEvent: "@tuvren/core/events",
  IterationEndEvent: "@tuvren/core/events",
  IterationStartEvent: "@tuvren/core/events",
  MessageDoneEvent: "@tuvren/core/events",
  MessageStartEvent: "@tuvren/core/events",
  ReasoningDeltaEvent: "@tuvren/core/events",
  ReasoningDoneEvent: "@tuvren/core/events",
  StateCheckpointEvent: "@tuvren/core/events",
  StateSnapshotEvent: "@tuvren/core/events",
  SteeringIncorporatedEvent: "@tuvren/core/events",
  StructuredDeltaEvent: "@tuvren/core/events",
  StructuredDoneEvent: "@tuvren/core/events",
  TextDeltaEvent: "@tuvren/core/events",
  TextDoneEvent: "@tuvren/core/events",
  ToolCallArgsDeltaEvent: "@tuvren/core/events",
  ToolCallDoneEvent: "@tuvren/core/events",
  ToolCallStartEvent: "@tuvren/core/events",
  ToolResultEvent: "@tuvren/core/events",
  ToolStartEvent: "@tuvren/core/events",
  TurnEndEvent: "@tuvren/core/events",
  TurnStartEvent: "@tuvren/core/events",
  TuvrenErrorProjection: "@tuvren/core/events",
  TuvrenStreamEvent: "@tuvren/core/events",
  assertTuvrenStreamEvent: "@tuvren/core/events",
  isTuvrenStreamEvent: "@tuvren/core/events",
  // Messages and content-part types
  ApprovalDecisionType: "@tuvren/core/messages",
  ContentPart: "@tuvren/core/messages",
  FilePart: "@tuvren/core/messages",
  ReasoningPart: "@tuvren/core/messages",
  StructuredPart: "@tuvren/core/messages",
  TextPart: "@tuvren/core/messages",
  ToolCallPart: "@tuvren/core/messages",
  ToolResultPart: "@tuvren/core/messages",
  TuvrenJsonSchema: "@tuvren/core/messages",
  TuvrenJsonValue: "@tuvren/core/messages",
  TuvrenMessage: "@tuvren/core/messages",
  TuvrenModelConfig: "@tuvren/core/messages",
  assertTuvrenMessage: "@tuvren/core/messages",
  isTuvrenMessage: "@tuvren/core/messages",
  // Provider
  ProviderStreamChunk: "@tuvren/core/provider",
  ProviderUsage: "@tuvren/core/provider",
  StructuredOutputRequest: "@tuvren/core/provider",
  TuvrenModelResponse: "@tuvren/core/provider",
  TuvrenPrompt: "@tuvren/core/provider",
  TuvrenProvider: "@tuvren/core/provider",
  assertProviderStreamChunk: "@tuvren/core/provider",
  assertTuvrenModelResponse: "@tuvren/core/provider",
  isProviderStreamChunk: "@tuvren/core/provider",
  isTuvrenModelResponse: "@tuvren/core/provider",
  // Execution, orchestration, and durable-read cursors
  AgentConfig: "@tuvren/core/execution",
  BranchMessagesCursor: "@tuvren/core/execution",
  BranchSummary: "@tuvren/core/execution",
  ContextEngineeringContext: "@tuvren/core/execution",
  ContextEngineeringHelpers: "@tuvren/core/execution",
  ContextEngineeringPlan: "@tuvren/core/execution",
  ContextManifest: "@tuvren/core/execution",
  ContextManifestCounters: "@tuvren/core/execution",
  ContextManifestNameCounters: "@tuvren/core/execution",
  ContextPolicy: "@tuvren/core/execution",
  ContextPolicyResult: "@tuvren/core/execution",
  ExecutionHandle: "@tuvren/core/execution",
  ExecutionResult: "@tuvren/core/execution",
  ExecutionStatus: "@tuvren/core/execution",
  HandoffContextBuilder: "@tuvren/core/execution",
  HandoffContextMode: "@tuvren/core/execution",
  HandoffContextPlan: "@tuvren/core/execution",
  HandoffSourceContext: "@tuvren/core/execution",
  InputSignal: "@tuvren/core/execution",
  IterationDecision: "@tuvren/core/execution",
  ListThreadsCursor: "@tuvren/core/execution",
  LoopPolicy: "@tuvren/core/execution",
  OrchestrationHandle: "@tuvren/core/execution",
  OrchestrationResult: "@tuvren/core/execution",
  OrchestrationRuntime: "@tuvren/core/execution",
  RuntimeResolution: "@tuvren/core/execution",
  ThreadSummary: "@tuvren/core/execution",
  TurnHistoryCursor: "@tuvren/core/execution",
  TurnSnapshot: "@tuvren/core/execution",
  TuvrenRuntime: "@tuvren/core/execution",
  assertContextManifest: "@tuvren/core/execution",
  assertExecutionStatus: "@tuvren/core/execution",
  isExecutionStatus: "@tuvren/core/execution",
  // Tools and approval
  ApprovalDecision: "@tuvren/core/tools",
  ApprovalPolicy: "@tuvren/core/tools",
  ApprovalRequest: "@tuvren/core/tools",
  ApprovalResponse: "@tuvren/core/tools",
  CustomSchema: "@tuvren/core/tools",
  ExecuteFunction: "@tuvren/core/tools",
  PendingToolCall: "@tuvren/core/tools",
  RenderedToolDefinition: "@tuvren/core/tools",
  ToolDispatchContext: "@tuvren/core/tools",
  ToolExecutionContext: "@tuvren/core/tools",
  ToolExecutionResult: "@tuvren/core/tools",
  ToolRegistry: "@tuvren/core/tools",
  TuvrenToolDefinition: "@tuvren/core/tools",
  TuvrenToolResultBatch: "@tuvren/core/tools",
  ValidationErrorPayload: "@tuvren/core/tools",
  ValidationResult: "@tuvren/core/tools",
  assertApprovalRequest: "@tuvren/core/tools",
  assertApprovalResponse: "@tuvren/core/tools",
  assertApprovalResponseForRequest: "@tuvren/core/tools",
  assertTuvrenToolDefinition: "@tuvren/core/tools",
  isApprovalRequest: "@tuvren/core/tools",
  isApprovalResponse: "@tuvren/core/tools",
  isApprovalResponseForRequest: "@tuvren/core/tools",
  isTuvrenToolDefinition: "@tuvren/core/tools",
  // Extension lifecycle handlers
  AfterIterationContext: "@tuvren/core/extensions",
  AfterIterationHandler: "@tuvren/core/extensions",
  AroundModelContext: "@tuvren/core/extensions",
  AroundModelHandler: "@tuvren/core/extensions",
  AroundModelResult: "@tuvren/core/extensions",
  AroundToolContext: "@tuvren/core/extensions",
  AroundToolHandler: "@tuvren/core/extensions",
  AroundToolResult: "@tuvren/core/extensions",
  AroundToolSpec: "@tuvren/core/extensions",
  ExtensionContext: "@tuvren/core/extensions",
  InterceptContext: "@tuvren/core/extensions",
  InterceptHandler: "@tuvren/core/extensions",
  InterceptResult: "@tuvren/core/extensions",
  SystemPromptContext: "@tuvren/core/extensions",
  SystemPromptFn: "@tuvren/core/extensions",
  TuvrenExtension: "@tuvren/core/extensions",
};

// ─── Import parsing and generation ───────────────────────────────────────────

interface ParsedSymbol {
  isType: boolean;
  name: string;
}

function parseSymbols(clause: string, isTopLevelType: boolean): ParsedSymbol[] {
  return clause
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const typeMatch = TYPE_SYMBOL_RE.exec(s);
      if (typeMatch) {
        return { name: typeMatch[1], isType: true };
      }
      return { name: s, isType: isTopLevelType };
    });
}

function generateImport(symbols: ParsedSymbol[], modulePath: string): string {
  const allType = symbols.every((s) => s.isType);
  const keyword = allType ? "import type" : "import";
  const formatName = (s: ParsedSymbol): string =>
    s.isType && !allType ? `type ${s.name}` : s.name;

  if (symbols.length === 1) {
    return `${keyword} { ${formatName(symbols[0])} } from "${modulePath}";`;
  }
  const names = symbols.map(formatName).join(",\n  ");
  return `${keyword} {\n  ${names},\n} from "${modulePath}";`;
}

// Detects `type Foo` prefix in individual import clauses.
const TYPE_SYMBOL_RE = /^type\s+(\S+)$/;

// Regex: matches both single-line and multi-line named import statements
// targeting @tuvren/runtime-api (root only, not subpaths).
// [^}]* matches across newlines since it matches any char except '}'.
const RUNTIME_API_ROOT_IMPORT_RE =
  /import(?:\s+type)?\s*\{([^}]*)\}\s*from\s*"@tuvren\/runtime-api"\s*;/g;

function routeRuntimeApiRoot(
  fullMatch: string,
  clause: string,
  fileRel: string
): string {
  const isTopLevelType = fullMatch.startsWith("import type");
  const symbols = parseSymbols(clause, isTopLevelType);

  const groups = new Map<string, ParsedSymbol[]>();
  for (const sym of symbols) {
    const target = RUNTIME_API_ROOT_ROUTING[sym.name];
    if (target) {
      if (!groups.has(target)) {
        groups.set(target, []);
      }
      groups.get(target)?.push(sym);
    } else {
      console.warn(
        `  ⚠️  ${fileRel}: no routing for "@tuvren/runtime-api" symbol "${sym.name}" — leaving unchanged`
      );
      const fallback = "@tuvren/runtime-api";
      if (!groups.has(fallback)) {
        groups.set(fallback, []);
      }
      groups.get(fallback)?.push(sym);
    }
  }

  // Deterministic output order for clean diffs.
  const sorted = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  return sorted
    .map(([target, syms]) => generateImport(syms, target))
    .join("\n");
}

// ─── Per-file transform ───────────────────────────────────────────────────────

function transformContent(content: string, fileRel: string): string {
  let result = content;

  // Step 1: Direct module-specifier remaps (subpaths and simple packages).
  // Process longer specifiers first so "@tuvren/runtime-api/events" is not
  // partially matched before "@tuvren/runtime-api" is processed.
  const sortedRemaps = [...DIRECT_REMAPS].sort(
    ([a], [b]) => b.length - a.length
  );
  for (const [oldPkg, newPkg] of sortedRemaps) {
    result = result.replaceAll(` from "${oldPkg}"`, ` from "${newPkg}"`);
  }

  // Step 2: Route @tuvren/runtime-api root imports per-symbol.
  // This runs after step 1, so any subpath imports (/events, /execution, …)
  // are already rewritten and the regex only sees bare root imports.
  result = result.replace(RUNTIME_API_ROOT_IMPORT_RE, (match, clause) =>
    routeRuntimeApiRoot(match, clause, fileRel)
  );

  return result;
}

// ─── File system helpers ──────────────────────────────────────────────────────

async function collectTsFiles(dir: string): Promise<string[]> {
  const files: string[] = [];

  async function recurse(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        if (!EXCLUDE_DIR_NAMES.has(entry.name)) {
          await recurse(full);
        }
      } else if (
        entry.isFile() &&
        extname(entry.name) === ".ts" &&
        !entry.name.endsWith(".d.ts")
      ) {
        files.push(full);
      }
    }
  }

  await recurse(dir);
  return files;
}

function isExcluded(filePath: string): boolean {
  return EXCLUDE_SRC_PREFIXES.some(
    (prefix) => filePath === prefix || filePath.startsWith(`${prefix}/`)
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const scanDirs = [join(ROOT, "boundaries"), join(ROOT, "tools")];

  const allFiles: string[] = [];
  for (const dir of scanDirs) {
    allFiles.push(...(await collectTsFiles(dir)));
  }

  let rewritten = 0;
  let unchanged = 0;
  let skipped = 0;

  for (const filePath of allFiles) {
    if (isExcluded(filePath)) {
      skipped++;
      continue;
    }

    const original = await readFile(filePath, "utf-8");
    const fileRel = relative(ROOT, filePath);
    const transformed = transformContent(original, fileRel);

    if (transformed === original) {
      unchanged++;
    } else {
      if (DRY_RUN) {
        console.log(`[dry-run] ${fileRel}`);
      } else {
        await writeFile(filePath, transformed, "utf-8");
        console.log(`  ✓ ${fileRel}`);
      }
      rewritten++;
    }
  }

  const verb = DRY_RUN ? "would rewrite" : "rewritten";
  console.log(
    `\nKRT-AP006 codemod complete: ${rewritten} ${verb}, ${unchanged} unchanged, ${skipped} skipped`
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
