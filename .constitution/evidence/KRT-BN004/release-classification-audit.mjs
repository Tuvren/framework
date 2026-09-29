import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const baseline = "b2244918fbc3cef0ed81cec78fddd686ac0a0427";
const evidenceDirectory = resolvePath(
  process.env.KRT_BN004_EVIDENCE_DIR ?? ".constitution/evidence/KRT-BN004"
);
const snapshotPath = resolvePath(
  process.env.KRT_BN004_SNAPSHOT_PATH ??
    "tools/scripts/__snapshots__/api-surface/api-surface-snapshot.json"
);
const comparisonPath = resolvePath(
  process.env.KRT_BN004_COMPARISON_PATH ??
    path.join(evidenceDirectory, "published-stable-snapshot-comparison.json")
);
const changesetPath = resolvePath(
  process.env.KRT_BN004_CHANGESET_PATH ?? ".changeset/cool-papayas-bathe.md"
);

function resolvePath(candidate) {
  return path.isAbsolute(candidate) ? candidate : path.join(root, candidate);
}

function atBaseline(relativePath) {
  return execFileSync("git", ["show", `${baseline}:${relativePath}`], {
    cwd: root,
    encoding: "utf8",
  });
}

function atHead(relativePath) {
  return readFileSync(path.join(root, relativePath), "utf8");
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function requireFact(condition, detail) {
  if (!condition) {
    throw new Error(detail);
  }
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function recordKey(record) {
  return `${record.entrypoint}#${record.name}`;
}

function snapshotRecords(snapshot) {
  const records = new Map();

  for (const [entrypoint, exports] of Object.entries(snapshot.entrypoints)) {
    for (const [name, exportRecord] of Object.entries(exports)) {
      if (
        exportRecord === null ||
        typeof exportRecord !== "object" ||
        typeof exportRecord.kind !== "string" ||
        typeof exportRecord.signature !== "string" ||
        typeof exportRecord.stability !== "string"
      ) {
        continue;
      }

      records.set(recordKey({ entrypoint, name }), {
        entrypoint,
        name,
        kind: exportRecord.kind,
        signature: exportRecord.signature,
        stability: exportRecord.stability,
      });
    }
  }

  return records;
}

function stableDelta(baselineRecords, currentRecords) {
  const additions = [];
  const removals = [];
  const stabilityDowngrades = [];
  const signatureChanges = [];

  for (const [key, before] of baselineRecords) {
    if (before.stability !== "stable") {
      continue;
    }

    const after = currentRecords.get(key);
    if (after === undefined) {
      removals.push(before);
      continue;
    }

    if (after.stability !== "stable") {
      stabilityDowngrades.push({ before, after });
      continue;
    }

    if (before.kind !== after.kind || before.signature !== after.signature) {
      signatureChanges.push({
        entrypoint: before.entrypoint,
        name: before.name,
        before: pickComparableRecord(before),
        after: pickComparableRecord(after),
      });
    }
  }

  for (const [key, after] of currentRecords) {
    if (after.stability === "stable" && !baselineRecords.has(key)) {
      additions.push(after);
    }
  }

  return { additions, removals, stabilityDowngrades, signatureChanges };
}

function pickComparableRecord(record) {
  return {
    kind: record.kind,
    signature: record.signature,
    stability: record.stability,
  };
}

function byRecordKey(left, right) {
  return recordKey(left).localeCompare(recordKey(right));
}

const baselineSnapshot = JSON.parse(
  atBaseline(
    "tools/scripts/__snapshots__/api-surface/api-surface-snapshot.json"
  )
);
const currentSnapshot = readJson(snapshotPath);
const comparison = readJson(comparisonPath);
const baselineRecords = snapshotRecords(baselineSnapshot);
const currentRecords = snapshotRecords(currentSnapshot);
const delta = stableDelta(baselineRecords, currentRecords);

requireFact(
  comparison.baseline === baseline,
  `snapshot comparison baseline is ${JSON.stringify(comparison.baseline)}, expected ${baseline}`
);
requireFact(
  delta.removals.length === 0,
  `stable snapshot removals are not release-classified: ${delta.removals
    .map(recordKey)
    .sort()
    .join(", ")}`
);
requireFact(
  delta.stabilityDowngrades.length === 0,
  `stable snapshot stability downgrades are not release-classified: ${delta.stabilityDowngrades
    .map(({ before }) => recordKey(before))
    .sort()
    .join(", ")}`
);

const expectedStableChanges = [
  ["@tuvren/core/execution", "AgentConfig"],
  ["@tuvren/sdk", "AgentConfig"],
].map(([entrypoint, name]) => `${entrypoint}#${name}`);
const actualStableChanges = delta.signatureChanges
  .map((record) => `${record.entrypoint}#${record.name}`)
  .sort();
requireFact(
  sameJson(actualStableChanges, [...expectedStableChanges].sort()),
  `stable snapshot signature changes are ${JSON.stringify(actualStableChanges)}, expected only ${JSON.stringify(
    [...expectedStableChanges].sort()
  )}`
);

for (const change of delta.signatureChanges) {
  const expectedAddition = "sanitizeToolResult?: SanitizeToolResultHook; ";
  const expectedAfter = change.before.signature.replace(
    "serverExecution?:",
    `${expectedAddition}serverExecution?:`
  );
  requireFact(
    change.before.kind === "type" &&
      change.after.kind === "type" &&
      change.before.stability === "stable" &&
      change.after.stability === "stable" &&
      expectedAfter !== change.before.signature &&
      change.after.signature === expectedAfter,
    `${change.entrypoint}#${change.name} must solely add optional sanitizeToolResult?: SanitizeToolResultHook`
  );
}

const comparableStableChanges = [...delta.signatureChanges].sort(byRecordKey);
requireFact(
  sameJson(comparison.existingStableSignatureChanges, comparableStableChanges),
  "published stable snapshot comparison does not exactly match the derived stable signature delta"
);
requireFact(
  sameJson(comparison.baselineLedger, baselineSnapshot.ledger),
  "published stable snapshot comparison baseline ledger does not match the baseline snapshot"
);
requireFact(
  sameJson(comparison.currentLedger, currentSnapshot.ledger),
  "published stable snapshot comparison current ledger does not match the current snapshot"
);

const stableAdditionLedgerEntries = currentSnapshot.ledger
  .flatMap((entry) => entry.changes)
  .filter((change) => change.endsWith(": export-added"))
  .map((change) => change.slice(0, -": export-added".length))
  .sort();
const stableAdditionKeys = delta.additions.map(recordKey).sort();
requireFact(
  sameJson(stableAdditionKeys, stableAdditionLedgerEntries),
  `stable snapshot additions are not exactly the additive ledger entries: ${JSON.stringify(
    stableAdditionKeys
  )}`
);

const baselinePostgres = atBaseline(
  "typescript/kernel/backends/postgres/src/lib/postgres-backend-persistence.ts"
);
const headPostgres = atHead(
  "typescript/kernel/backends/postgres/src/lib/postgres-backend-persistence.ts"
);
const migrationTest = atHead(
  "typescript/kernel/backends/postgres/test/backend-postgres.blob-migration.test.ts"
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
    headPostgres.includes(
      "const normalized = schemaName ?? DEFAULT_SCHEMA_NAME;"
    ),
  "HEAD does not default Postgres schemaName to tuvren_kernel"
);
requireFact(
  headPostgres.includes("one-table-per-record-family relational") &&
    headPostgres.includes("blob-per-scope snapshot into its relational rows"),
  "HEAD does not establish the relational row-per-record replacement"
);
requireFact(
  headPostgres.includes("first time a pre-#110 schema is opened") &&
    migrationTest.includes("forcing the open-time") &&
    migrationTest.includes("backend_postgres_snapshots"),
  "HEAD lacks selected-schema first-open legacy blob migration coverage"
);
requireFact(
  guardTest.includes("postgres_backend_legacy_blob_schema_elsewhere"),
  "HEAD lacks the legacy default-schema incompatibility guard"
);

const changeset = readFileSync(changesetPath, "utf8");
const requiredReleaseNotes = [
  [
    "SDK optional hook surface",
    /@tuvren\/core` and `@tuvren\/sdk`\s+add the optional `AgentConfig` sanitization hook/i,
  ],
  [
    "PostgreSQL relational row-per-record storage",
    /relational row-per-record storage/i,
  ],
  [
    "public-to-tuvren_kernel default schema",
    /default schema from\s+`public` to\s+`tuvren_kernel`/i,
  ],
  ["explicit public schema selection", /schemaName:\s*"public"/],
  [
    "selected-schema first-open migration",
    /selected legacy schema migrates on first open/i,
  ],
  ["unsupported downgrade", /downgrades aren't supported/i],
];
for (const [label, pattern] of requiredReleaseNotes) {
  requireFact(pattern.test(changeset), `changeset release notes omit ${label}`);
}

console.log(
  `stable snapshot delta: ${delta.signatureChanges.length} exact existing signature changes and ${delta.additions.length} additive stable exports`
);
console.log(
  "core/sdk AgentConfig: solely adds optional sanitizeToolResult?: SanitizeToolResultHook"
);
console.log(
  "release notes: SDK hook, PostgreSQL relational storage, schema migration, and downgrade support verified"
);
