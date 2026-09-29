import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = process.cwd();
const auditPath = fileURLToPath(
  new URL("./release-classification-audit.mjs", import.meta.url)
);
const changesetPath = path.join(root, ".changeset/cool-papayas-bathe.md");
const snapshotPath = path.join(
  root,
  "tools/scripts/__snapshots__/api-surface/api-surface-snapshot.json"
);
const comparisonPath = path.join(
  root,
  ".constitution/evidence/KRT-BN004/published-stable-snapshot-comparison.json"
);
const scratch = mkdtempSync(path.join(os.tmpdir(), "KRT-BN004-negative-"));

function requireFact(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertFailure(name, expectedMessage, overrides) {
  const result = spawnSync(process.execPath, [auditPath], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...overrides },
  });
  const output = `${result.stdout}${result.stderr}`;
  requireFact(result.status !== 0, `${name}: audit unexpectedly passed`);
  requireFact(
    output.includes(expectedMessage),
    `${name}: expected ${JSON.stringify(expectedMessage)}, got ${JSON.stringify(output)}`
  );
  console.log(`${name}: rejected`);
}

try {
  const originalChangeset = readFileSync(changesetPath, "utf8");
  const noteRemovals = [
    [
      "SDK optional hook surface",
      "add the optional `AgentConfig` sanitization hook",
      "add a configuration extension",
    ],
    [
      "PostgreSQL relational row-per-record storage",
      "relational row-per-record storage",
      "relational storage",
    ],
    [
      "public-to-tuvren_kernel default schema",
      "changes the default schema from\n`public` to `tuvren_kernel`",
      "changes the schema default",
    ],
    [
      "explicit public schema selection",
      'schemaName: "public"',
      "an explicit schema name",
    ],
    [
      "selected-schema first-open migration",
      "selected legacy schema migrates on first open",
      "selected legacy schema migrates later",
    ],
    [
      "unsupported downgrade",
      "Downgrades aren't supported",
      "Downgrade policy applies",
    ],
  ];

  for (const [label, needle, replacement] of noteRemovals) {
    const mutated = originalChangeset.replace(needle, replacement);
    requireFact(
      mutated !== originalChangeset,
      `${label}: fixture needle was absent`
    );
    const fixture = path.join(
      scratch,
      `${label.replaceAll(/[^a-z0-9]+/gi, "-")}.md`
    );
    writeFileSync(fixture, mutated);
    assertFailure(
      `note removal: ${label}`,
      `changeset release notes omit ${label}`,
      {
        KRT_BN004_CHANGESET_PATH: fixture,
      }
    );
  }

  const originalComparison = JSON.parse(readFileSync(comparisonPath, "utf8"));
  originalComparison.existingStableSignatureChanges.push({
    entrypoint: "@tuvren/core/execution",
    name: "SyntheticStableExport",
    before: {
      kind: "type",
      signature: "export type Synthetic = string;",
      stability: "stable",
    },
    after: {
      kind: "type",
      signature: "export type Synthetic = number;",
      stability: "stable",
    },
  });
  const extraRecordedComparison = path.join(
    scratch,
    "extra-recorded-stable-delta.json"
  );
  writeFileSync(
    extraRecordedComparison,
    `${JSON.stringify(originalComparison, null, 2)}\n`
  );
  assertFailure(
    "extra recorded stable delta",
    "published stable snapshot comparison does not exactly match the derived stable signature delta",
    { KRT_BN004_COMPARISON_PATH: extraRecordedComparison }
  );

  const originalSnapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));
  const removedSnapshot = structuredClone(originalSnapshot);
  removedSnapshot.entrypoints["@tuvren/core/execution"] = Object.fromEntries(
    Object.entries(
      removedSnapshot.entrypoints["@tuvren/core/execution"]
    ).filter(([name]) => name !== "AgentConfig")
  );
  const removedSnapshotPath = path.join(scratch, "stable-removal.json");
  writeFileSync(
    removedSnapshotPath,
    `${JSON.stringify(removedSnapshot, null, 2)}\n`
  );
  assertFailure(
    "stable removal",
    "stable snapshot removals are not release-classified",
    {
      KRT_BN004_SNAPSHOT_PATH: removedSnapshotPath,
    }
  );

  const downgradedSnapshot = structuredClone(originalSnapshot);
  downgradedSnapshot.entrypoints[
    "@tuvren/core/execution"
  ].AgentConfig.stability = "experimental";
  const downgradedSnapshotPath = path.join(scratch, "stable-downgrade.json");
  writeFileSync(
    downgradedSnapshotPath,
    `${JSON.stringify(downgradedSnapshot, null, 2)}\n`
  );
  assertFailure(
    "stable downgrade",
    "stable snapshot stability downgrades are not release-classified",
    {
      KRT_BN004_SNAPSHOT_PATH: downgradedSnapshotPath,
    }
  );

  const extraSignatureSnapshot = structuredClone(originalSnapshot);
  extraSignatureSnapshot.entrypoints[
    "@tuvren/core/execution"
  ].LoopPolicy.signature += " ";
  const extraSignatureSnapshotPath = path.join(
    scratch,
    "extra-stable-signature.json"
  );
  writeFileSync(
    extraSignatureSnapshotPath,
    `${JSON.stringify(extraSignatureSnapshot, null, 2)}\n`
  );
  assertFailure(
    "extra stable signature",
    "stable snapshot signature changes are",
    {
      KRT_BN004_SNAPSHOT_PATH: extraSignatureSnapshotPath,
    }
  );
} finally {
  rmSync(scratch, { force: true, recursive: true });
}
