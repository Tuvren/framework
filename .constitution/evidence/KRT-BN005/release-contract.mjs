#!/usr/bin/env bun

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";

const execute = promisify(execFile);

const EXPECTED_PUBLIC_PACKAGES = new Set([
  "@tuvren/backend-memory",
  "@tuvren/backend-postgres",
  "@tuvren/backend-shared",
  "@tuvren/backend-sqlite",
  "@tuvren/core",
  "@tuvren/kernel-grpc-client",
  "@tuvren/kernel-protocol",
  "@tuvren/kernel-runtime",
  "@tuvren/mcp-client",
  "@tuvren/provider-api",
  "@tuvren/provider-bridge-ai-sdk",
  "@tuvren/runner-react",
  "@tuvren/runtime",
  "@tuvren/sdk",
  "@tuvren/stream-agui",
  "@tuvren/stream-core",
  "@tuvren/stream-sse",
  "@tuvren/telemetry-otel",
  "@tuvren/telemetry-semconv",
]);

const SESSION_PACKAGES = new Set([
  "@tuvren/host-session",
  "@tuvren/remote-session",
  "@tuvren/session-client",
  "@tuvren/stream-ws",
]);

const EXPECTED_TOOL_HASHES = new Map([
  [
    "tools/scripts/release-lane.ts",
    "b1676f5efba7a9ebd6ed22a0d40de7cd6b557869f82da7f0a4750f45a33c98b4",
  ],
  [
    "tools/scripts/release-check.ts",
    "7bfc037659200415db657bf9c1be8910a020358c2d51ddd20e849765f3a36a06",
  ],
  [
    "tools/scripts/publish-registry.ts",
    "c5cc0a0cb3b967983a293b1a8f4d52766202693062db5cbf71402fdd23dafc3b",
  ],
]);

const EXPECTED_TYPESCRIPT_SOURCE_AGGREGATE =
  "922dcbaf2123865861bb72af4326d428924303037c2c1e4f11ca7e7a72d9ff3c";

const ALLOWED_WORKSPACE_RANGES = new Set([
  "workspace:*",
  "workspace:~",
  "0.2.0",
  "~0.2.0",
  "^0.2.0",
]);

const LEAD_OWNED_BOOKKEEPING = new Set([
  ".constitution/tasks/epics/EPIC-BN-public-release-readiness.yaml",
]);

const CONSUMED_INTENT_PATH = ".changeset/cool-papayas-bathe.md";

const repoRoot = process.cwd();
const intentPath = process.argv[2];

if (intentPath === undefined) {
  throw new Error(
    "usage: bun release-contract.mjs ABSOLUTE_ARCHIVED_CHANGESET_PATH"
  );
}

await main();

async function main() {
  const manifests = await readWorkspaceManifests();
  assertReleaseInventory(manifests);
  await assertChangelogs(manifests);
  assertChangelogNegativeControl();
  await assertNoPendingNotes();
  await assertIntent(intentPath);
  await assertRecordedSourceHashes();
  await assertCommittedReleaseScope(manifests);
  await assertCurrentWorkingScope();
  await assertBiomeFormat(manifests);
  console.log(
    "release-contract: OK — 30 packages at 0.2.0; 19 public, 11 private; committed release scope and current tree are clean"
  );
}

async function readWorkspaceManifests() {
  const manifests = [];
  const typescriptRoot = path.join(repoRoot, "typescript");

  for await (const manifestPath of walkPackageManifests(typescriptRoot)) {
    const parsed = JSON.parse(await readFile(manifestPath, "utf8"));

    if (
      typeof parsed.name !== "string" ||
      !parsed.name.startsWith("@tuvren/")
    ) {
      continue;
    }

    manifests.push({
      manifestPath,
      directory: path.dirname(manifestPath),
      name: parsed.name,
      private: parsed.private === true,
      version: parsed.version,
      dependencies: {
        ...(parsed.dependencies ?? {}),
        ...(parsed.optionalDependencies ?? {}),
        ...(parsed.peerDependencies ?? {}),
      },
    });
  }

  return manifests.sort((left, right) => left.name.localeCompare(right.name));
}

async function* walkPackageManifests(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === "node_modules") {
      continue;
    }

    const child = path.join(directory, entry.name);
    const manifestPath = path.join(child, "package.json");

    try {
      if ((await stat(manifestPath)).isFile()) {
        yield manifestPath;
      }
    } catch {
      yield* walkPackageManifests(child);
    }
  }
}

function assertReleaseInventory(manifests) {
  assert(
    manifests.length === 30,
    `expected 30 @tuvren manifests, found ${manifests.length}`
  );

  const publicPackages = new Set();
  let privateCount = 0;

  for (const manifest of manifests) {
    assert(
      manifest.version === "0.2.0",
      `${relative(manifest.manifestPath)} has version ${String(manifest.version)}`
    );

    if (manifest.private) {
      privateCount += 1;
    } else {
      publicPackages.add(manifest.name);
    }

    for (const [dependency, range] of Object.entries(manifest.dependencies)) {
      if (!dependency.startsWith("@tuvren/")) {
        continue;
      }

      assert(
        typeof range === "string" && ALLOWED_WORKSPACE_RANGES.has(range),
        `${manifest.name} has unsupported generated range ${dependency}@${String(range)}`
      );
    }
  }

  assert(
    privateCount === 11,
    `expected 11 private packages, found ${privateCount}`
  );
  assertSetEquals(
    publicPackages,
    EXPECTED_PUBLIC_PACKAGES,
    "public package inventory"
  );

  for (const sessionPackage of SESSION_PACKAGES) {
    const manifest = manifests.find(
      (candidate) => candidate.name === sessionPackage
    );
    assert(manifest !== undefined, `missing session package ${sessionPackage}`);
    assert(manifest.private, `${sessionPackage} must remain private`);
    assert(
      !publicPackages.has(sessionPackage),
      `${sessionPackage} is in the publish set`
    );
  }

  for (const manifest of manifests.filter((candidate) => !candidate.private)) {
    for (const dependency of Object.keys(manifest.dependencies)) {
      if (!dependency.startsWith("@tuvren/")) {
        continue;
      }

      assert(
        EXPECTED_PUBLIC_PACKAGES.has(dependency),
        `${manifest.name} depends on private or uncurated ${dependency}`
      );
    }
  }
}

async function assertChangelogs(manifests) {
  for (const manifest of manifests) {
    const changelogPath = path.join(manifest.directory, "CHANGELOG.md");
    const changelog = await readFile(changelogPath, "utf8");
    assertChangelogSection(changelog, relative(changelogPath));
  }
}

function assertChangelogSection(changelog, changelogPath) {
  const header = /^## 0\.2\.0\r?$/gmu.exec(changelog);
  assert(header !== null, `${changelogPath} lacks a 0.2.0 release section`);

  let sectionStart = header.index + header[0].length;

  if (changelog[sectionStart] === "\r") {
    sectionStart += 1;
  }

  if (changelog[sectionStart] === "\n") {
    sectionStart += 1;
  }

  const followingHeader = /^## /gmu;
  followingHeader.lastIndex = sectionStart;
  const sectionEnd = followingHeader.exec(changelog)?.index ?? changelog.length;
  const releaseSection = changelog.slice(sectionStart, sectionEnd);

  for (const dependency of releaseSection.matchAll(
    /@tuvren\/[^\s@]+@([^\s]+)/gu
  )) {
    assert(
      dependency[1] === "0.2.0",
      `${changelogPath} references ${dependency[0]} in its 0.2.0 section`
    );
  }
}

function assertChangelogNegativeControl() {
  const wrongInternalReference = [
    "# fixture",
    "",
    "## 0.2.0",
    "",
    "### Patch Changes",
    "",
    "- Updated dependencies",
    "  - @tuvren/core@0.1.0",
    "",
    "## 0.1.0",
    "",
  ].join("\n");

  let rejected = false;

  try {
    assertChangelogSection(wrongInternalReference, "negative-control.md");
  } catch (error) {
    rejected =
      error instanceof Error && error.message.includes("@tuvren/core@0.1.0");
  }

  assert(
    rejected,
    "negative control accepted a stale internal changelog reference"
  );
  console.log(
    "release-contract: negative control rejected stale internal reference"
  );
}

async function assertNoPendingNotes() {
  const notes = (await readdir(path.join(repoRoot, ".changeset"))).filter(
    (name) => name.endsWith(".md") && name !== "README.md"
  );
  assert(notes.length === 0, `pending changesets remain: ${notes.join(", ")}`);
}

async function assertIntent(archivedIntentPath) {
  const intent = await readFile(archivedIntentPath, "utf8");
  const entries = [
    ...intent.matchAll(/^"(@tuvren\/[^"]+)": (minor|patch)$/gmu),
  ];
  const releases = new Map(entries.map((entry) => [entry[1], entry[2]]));

  assert(
    releases.size === 19,
    `expected 19 archived public release intents, found ${releases.size}`
  );
  assert(
    releases.get("@tuvren/backend-postgres") === "minor",
    "archived intent lacks PostgreSQL minor"
  );
  assert(
    [...releases.values()].filter((releaseType) => releaseType === "patch")
      .length === 18,
    "archived intent does not contain eighteen direct patch releases"
  );
  assertSetEquals(
    new Set(releases.keys()),
    EXPECTED_PUBLIC_PACKAGES,
    "archived intent public inventory"
  );
}

async function assertRecordedSourceHashes() {
  for (const [filePath, expectedHash] of EXPECTED_TOOL_HASHES) {
    const actualHash = await sha256File(path.join(repoRoot, filePath));
    assert(
      actualHash === expectedHash,
      `${filePath} hash drifted: ${actualHash}`
    );
  }

  const sourcePaths = await gitLines([
    "ls-files",
    "-z",
    "typescript/**/src/**",
  ]);
  const sourceHashes = [];

  for (const sourcePath of sourcePaths) {
    sourceHashes.push(
      `${await sha256File(path.join(repoRoot, sourcePath))}  ${sourcePath}`
    );
  }

  const aggregate = sha256Text(`${sourceHashes.join("\n")}\n`);
  assert(
    aggregate === EXPECTED_TYPESCRIPT_SOURCE_AGGREGATE,
    `TypeScript source aggregate drifted: ${aggregate}`
  );
}

async function assertCommittedReleaseScope(manifests) {
  const candidateCommits = (
    await gitOutput([
      "log",
      "--format=%H",
      "--no-renames",
      "--diff-filter=D",
      "HEAD",
      "--",
      CONSUMED_INTENT_PATH,
    ])
  )
    .trim()
    .split("\n")
    .filter((commit) => commit.length > 0);
  const expectedReleasePaths = releasePaths(manifests);
  const acceptedCommits = [];
  const rejectedCommits = [];

  for (const commit of candidateCommits) {
    try {
      await assertReleaseCommitScope(commit, expectedReleasePaths);
      acceptedCommits.push(commit);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      rejectedCommits.push(`${commit}: ${message}`);
    }
  }

  assert(
    acceptedCommits.length === 1,
    `expected one committed release scope anchored by ${CONSUMED_INTENT_PATH}, found ${acceptedCommits.length}; rejected candidates: ${rejectedCommits.join("; ")}`
  );
  console.log(
    `release-contract: committed release scope is ${acceptedCommits[0]} with ${expectedReleasePaths.size} generated manifest and changelog paths`
  );
}

async function assertReleaseCommitScope(commit, expectedReleasePaths) {
  const entries = await gitNameStatusEntries([
    "diff",
    "--name-status",
    "--no-renames",
    `${commit}^`,
    commit,
  ]);
  const entriesByPath = new Map(entries.map((entry) => [entry.path, entry]));
  const generatedPaths = new Set(
    entries
      .filter((entry) => expectedReleasePaths.has(entry.path))
      .map((entry) => entry.path)
  );

  assertSetEquals(
    generatedPaths,
    expectedReleasePaths,
    `committed release ${commit} generated paths`
  );

  for (const generatedPath of expectedReleasePaths) {
    const entry = entriesByPath.get(generatedPath);
    assert(
      entry !== undefined && entry.status !== "D",
      `committed release ${commit} removed generated path ${generatedPath}`
    );
  }

  assert(
    entriesByPath.get(CONSUMED_INTENT_PATH)?.status === "D",
    `committed release ${commit} did not delete ${CONSUMED_INTENT_PATH}`
  );

  for (const entry of entries) {
    if (
      expectedReleasePaths.has(entry.path) ||
      entry.path === CONSUMED_INTENT_PATH
    ) {
      continue;
    }

    assert(
      isLeadOwnedArtifact(entry.path),
      `committed release ${commit} contains unowned product path ${entry.path}`
    );
  }
}

function releasePaths(manifests) {
  return new Set([
    ...manifests.map((manifest) => relative(manifest.manifestPath)),
    ...manifests.map((manifest) =>
      relative(path.join(manifest.directory, "CHANGELOG.md"))
    ),
  ]);
}

async function assertCurrentWorkingScope() {
  const statusEntries = await gitStatusEntries();

  for (const entry of statusEntries) {
    assert(
      isLeadOwnedArtifact(entry.path),
      `working tree contains unowned artifact ${entry.path}`
    );
  }
  console.log(
    `release-contract: current working tree has ${statusEntries.length} owned evidence or bookkeeping entries`
  );
}

function isLeadOwnedArtifact(filePath) {
  return (
    filePath.startsWith(".constitution/evidence/KRT-BN005/") ||
    LEAD_OWNED_BOOKKEEPING.has(filePath)
  );
}

async function assertBiomeFormat(manifests) {
  const generatedPaths = [
    ...manifests.map((manifest) => relative(manifest.manifestPath)),
    ...manifests.map((manifest) =>
      relative(path.join(manifest.directory, "CHANGELOG.md"))
    ),
  ];
  const result = await execute(
    "bunx",
    [
      "--bun",
      "@biomejs/biome",
      "check",
      "--config-path=biome.jsonc",
      ...generatedPaths,
    ],
    {
      cwd: repoRoot,
      env: process.env,
    }
  );

  assert(
    result.stderr.length === 0,
    `Biome formatter emitted stderr: ${result.stderr}`
  );
}

async function gitLines(args) {
  return (await gitOutput(args))
    .split("\0")
    .filter((value) => value.length > 0);
}

async function gitNameStatusEntries(args) {
  return (await gitOutput(args))
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const [status, filePath] = line.split("\t", 2);
      assert(
        status !== undefined && filePath !== undefined,
        `could not parse git name-status entry ${line}`
      );
      return { path: filePath, status };
    });
}

async function gitOutput(args) {
  const { stdout } = await execute("git", args, { cwd: repoRoot });
  return stdout;
}

async function gitStatusEntries() {
  const { stdout } = await execute("git", ["status", "--porcelain=v1", "-z"], {
    cwd: repoRoot,
  });
  return stdout
    .split("\0")
    .filter((entry) => entry.length > 0)
    .map((entry) => ({ path: entry.slice(3), status: entry.slice(0, 2) }));
}

async function sha256File(filePath) {
  return sha256Text(await readFile(filePath));
}

function sha256Text(value) {
  return createHash("sha256").update(value).digest("hex");
}

function relative(filePath) {
  return path.relative(repoRoot, filePath).split(path.sep).join("/");
}

function assertSetEquals(actual, expected, label) {
  const onlyActual = [...actual].filter((value) => !expected.has(value));
  const onlyExpected = [...expected].filter((value) => !actual.has(value));
  assert(
    onlyActual.length === 0 && onlyExpected.length === 0,
    `${label} mismatch: unexpected [${onlyActual.join(", ")}], missing [${onlyExpected.join(", ")}]`
  );
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(`release-contract: ${message}`);
  }
}
