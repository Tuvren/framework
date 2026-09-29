import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const baseline = "b2244918fbc3cef0ed81cec78fddd686ac0a0427";

function atBaseline(relativePath) {
  return execFileSync("git", ["show", `${baseline}:${relativePath}`], {
    cwd: root,
    encoding: "utf8",
  });
}

function atHead(relativePath) {
  return readFileSync(path.join(root, relativePath), "utf8");
}

function requireFact(condition, detail) {
  if (!condition) throw new Error(detail);
}

const baselineCore = atBaseline("typescript/core/src/lib/runtime-contract-shapes.ts");
const headCore = atHead("typescript/core/src/lib/runtime-contract-shapes.ts");
requireFact(
  !baselineCore.includes("sanitizeToolResult?:"),
  "the baseline unexpectedly contains sanitizeToolResult"
);
requireFact(
  headCore.includes("sanitizeToolResult?: SanitizeToolResultHook;"),
  "HEAD does not contain the optional sanitizeToolResult addition"
);

const baselineSdk = atBaseline("typescript/sdk/src/index.ts");
const headSdk = atHead("typescript/sdk/src/index.ts");
const agentReexport = "  AgentConfig,";
requireFact(
  baselineSdk.includes(agentReexport) && headSdk.includes(agentReexport),
  "SDK does not preserve the AgentConfig re-export"
);

const baselinePostgres = atBaseline(
  "typescript/kernel/backends/postgres/src/lib/postgres-backend-persistence.ts"
);
const headPostgres = atHead(
  "typescript/kernel/backends/postgres/src/lib/postgres-backend-persistence.ts"
);
const guardTest = atHead(
  "typescript/kernel/backends/postgres/test/backend-postgres.legacy-blob-elsewhere-guard.test.ts"
);
requireFact(
  baselinePostgres.includes('const normalized = schemaName ?? "public";'),
  "the published baseline does not default Postgres schemaName to public"
);
requireFact(
  headPostgres.includes('const DEFAULT_SCHEMA_NAME = "tuvren_kernel";') &&
    headPostgres.includes("const normalized = schemaName ?? DEFAULT_SCHEMA_NAME;"),
  "HEAD does not default Postgres schemaName to tuvren_kernel"
);
requireFact(
  guardTest.includes("postgres_backend_legacy_blob_schema_elsewhere"),
  "HEAD lacks the legacy-default-schema incompatibility guard"
);

const changeset = atHead(".changeset/cool-papayas-bathe.md");
requireFact(
  changeset.includes('\"@tuvren/core\": patch') &&
    changeset.includes('\"@tuvren/sdk\": patch') &&
    changeset.includes('\"@tuvren/backend-postgres\": minor'),
  "changeset does not encode the approved direct release classes"
);
requireFact(
  changeset.includes('schemaName: \"public\"') &&
    changeset.includes("selected legacy schema migrates on first open"),
  "changeset does not explain the selected-schema migration requirement"
);

console.log("core/sdk: additive optional AgentConfig hook and preserved SDK re-export (patch)");
console.log("backend-postgres: omitted schemaName changes public -> tuvren_kernel (minor)");
console.log("backend-postgres: legacy default-schema upgrade requires explicit schema selection");
