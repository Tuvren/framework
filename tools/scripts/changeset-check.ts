/**
 * Public changeset coverage gate (KRT-BN003).
 *
 * Changesets status intentionally cannot be the policy oracle here: with this
 * repository's fixed group and privatePackages.version setting it reports
 * version propagation for private packages and only rejects zero changesets.
 * This gate instead maps Git path changes to the current publishable manifests
 * and requires a direct, validated changeset entry for each affected package.
 */
import { spawn } from "node:child_process";
import type { Dirent } from "node:fs";
import { access, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { parseDocument } from "yaml";
import { walkPackageManifests } from "./lib/walk-package-manifests.js";

interface CommandResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

interface ChangesetCheckOptions {
  readonly base: string;
  readonly rootDirectory: string;
}

interface PackageManifest {
  readonly directory: string;
  readonly name: string;
  readonly private: boolean;
}

interface PendingChangeset {
  readonly relativePath: string;
  readonly releaseTypes: ReadonlyMap<string, string>;
  readonly summary: string;
}

interface ChangesetContents {
  readonly releaseTypes: ReadonlyMap<string, string>;
  readonly summary: string;
}

const REPO_ROOT = path.resolve(import.meta.dirname, "../../");
const CHANGESET_DIRECTORY = ".changeset";
const CHANGESET_METADATA_FILES = new Set(["README.md"]);
const RELEASE_TYPES = new Set(["major", "minor", "patch"]);
const FULL_GIT_COMMIT = /^[0-9a-f]{40}$/u;

if (import.meta.main) {
  const base = parseBaseArgument(process.argv.slice(2));

  try {
    await checkChangesetCoverage({ base, rootDirectory: REPO_ROOT });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`changeset-check: FAIL — ${message}`);
    process.exitCode = 1;
  }
}

export async function checkChangesetCoverage(
  options: ChangesetCheckOptions
): Promise<void> {
  const baseRevision = await resolveRevision(
    options.rootDirectory,
    options.base
  );
  const manifests = await readWorkspaceManifests(options.rootDirectory);
  const changedPaths = await readChangedPaths(
    options.rootDirectory,
    baseRevision
  );
  const changedPublicPackages = manifests.filter(
    (manifest) =>
      !manifest.private &&
      manifest.name.startsWith("@tuvren/") &&
      [...changedPaths].some((changedPath) =>
        isPathWithin(manifest.directory, changedPath)
      )
  );

  if (changedPublicPackages.length === 0) {
    console.log("changeset-check: OK — no publishable package paths changed");
    return;
  }

  const changesets = await readPendingChangesets(options.rootDirectory);
  const coveredNames = new Set<string>();

  for (const changeset of changesets) {
    if (
      !(
        changedPaths.has(changeset.relativePath) &&
        (await changesetHasNewOrUpdatedIntent(
          options.rootDirectory,
          baseRevision,
          changeset
        ))
      )
    ) {
      continue;
    }

    for (const name of changeset.releaseTypes.keys()) {
      coveredNames.add(name);
    }
  }

  const uncovered = changedPublicPackages.filter(
    (manifest) => !coveredNames.has(manifest.name)
  );

  if (uncovered.length === 0) {
    console.log(
      `changeset-check: OK — direct changeset coverage for ${changedPublicPackages.length} publishable package(s)`
    );
    return;
  }

  if (changesets.length === 0) {
    const releaseProof = await proveConsumedGeneratedRelease({
      baseRevision,
      changedPaths,
      manifests,
      rootDirectory: options.rootDirectory,
    });

    if (releaseProof === undefined) {
      console.log(
        "changeset-check: OK — consumed changesets reproduce the generated public release"
      );
      return;
    }

    throw new Error(
      `publishable package changes lack direct changesets (${formatPackageNames(uncovered)}); consumed-release proof failed: ${releaseProof}`
    );
  }

  throw new Error(
    `publishable package changes lack direct changesets: ${formatPackageNames(uncovered)}`
  );
}

function parseBaseArgument(arguments_: readonly string[]): string {
  if (arguments_.length === 0) {
    return "master";
  }

  if (arguments_.length !== 1 || !arguments_[0]?.startsWith("--base=")) {
    throw new Error("usage: bun run changeset:check --base=<git revision>");
  }

  const base = arguments_[0].slice("--base=".length);

  if (base.length === 0) {
    throw new Error("--base must name a Git revision");
  }

  return base;
}

async function resolveRevision(
  rootDirectory: string,
  revision: string
): Promise<string> {
  const result = await runCommand(
    "git",
    ["rev-parse", "--verify", `${revision}^{commit}`],
    rootDirectory
  );

  if (result.exitCode !== 0) {
    throw new Error(
      `cannot resolve base revision ${JSON.stringify(revision)}; fetch the pull-request base with full history`
    );
  }

  const resolved = result.stdout.trim();

  if (!FULL_GIT_COMMIT.test(resolved)) {
    throw new Error(
      `Git returned an invalid base commit for ${JSON.stringify(revision)}`
    );
  }

  return resolved;
}

async function readChangedPaths(
  rootDirectory: string,
  baseRevision: string
): Promise<ReadonlySet<string>> {
  const commands: ReadonlyArray<readonly string[]> = [
    [
      "diff",
      "--name-only",
      "-z",
      "--diff-filter=ACDMR",
      `${baseRevision}...HEAD`,
    ],
    ["diff", "--name-only", "-z", "--diff-filter=ACDMR"],
    ["diff", "--cached", "--name-only", "-z", "--diff-filter=ACDMR"],
    ["ls-files", "--others", "--exclude-standard", "-z"],
  ];
  const changedPaths = new Set<string>();

  for (const args of commands) {
    const result = await runCommand("git", args, rootDirectory);

    if (result.exitCode !== 0) {
      throw new Error(
        `cannot determine changed paths with git ${args[0] ?? ""}`
      );
    }

    for (const rawPath of result.stdout.split("\0")) {
      if (rawPath.length === 0) {
        continue;
      }

      changedPaths.add(normalizeGitPath(rawPath));
    }
  }

  return changedPaths;
}

async function readWorkspaceManifests(
  rootDirectory: string
): Promise<PackageManifest[]> {
  const rootManifest = await readJsonFile(
    path.join(rootDirectory, "package.json")
  );
  const workspacePatterns = readWorkspacePatterns(rootManifest);
  const manifests: PackageManifest[] = [];
  const names = new Set<string>();

  for (const workspacePattern of workspacePatterns) {
    const parent = workspacePattern.slice(0, -2);
    const parentDirectory = path.join(rootDirectory, parent);

    try {
      await access(parentDirectory);
    } catch {
      throw new Error(
        `workspace directory ${JSON.stringify(parent)} is missing`
      );
    }

    const manifestPaths = await walkPackageManifests(parentDirectory);

    for (const manifestPath of manifestPaths) {
      const directory = normalizeGitPath(
        path.relative(rootDirectory, path.dirname(manifestPath))
      );

      if (!matchesWorkspacePattern(directory, workspacePattern)) {
        continue;
      }

      const manifest = await readPackageManifest(manifestPath, directory);

      if (names.has(manifest.name)) {
        throw new Error(
          `workspace package name ${manifest.name} is declared more than once`
        );
      }

      names.add(manifest.name);
      manifests.push(manifest);
    }
  }

  if (manifests.length === 0) {
    throw new Error("no workspace package manifests could be established");
  }

  return manifests.sort((left, right) => left.name.localeCompare(right.name));
}

function readWorkspacePatterns(value: unknown): string[] {
  if (!(isObject(value) && Array.isArray(value.workspaces))) {
    throw new Error("root package.json must declare a workspaces array");
  }

  const patterns: string[] = [];

  for (const pattern of value.workspaces) {
    if (
      typeof pattern !== "string" ||
      !pattern.endsWith("/*") ||
      pattern.length <= 2 ||
      pattern.startsWith("/") ||
      pattern.includes("..")
    ) {
      throw new Error(
        "workspace patterns must be relative trailing-star directories"
      );
    }

    patterns.push(pattern);
  }

  return patterns;
}

async function readPackageManifest(
  manifestPath: string,
  directory: string
): Promise<PackageManifest> {
  const value = await readJsonFile(manifestPath);

  if (!isObject(value) || typeof value.name !== "string") {
    throw new Error(`${directory}/package.json must declare a string name`);
  }

  return {
    directory,
    name: value.name,
    private: value.private === true,
  };
}

async function readJsonFile(filePath: string): Promise<unknown> {
  let text: string;

  try {
    text = await readFile(filePath, "utf8");
  } catch {
    throw new Error(`cannot read ${filePath}`);
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${filePath} is not valid JSON`);
  }
}

async function readPendingChangesets(
  rootDirectory: string
): Promise<PendingChangeset[]> {
  const directory = path.join(rootDirectory, CHANGESET_DIRECTORY);
  let entries: Dirent<string>[];

  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    throw new Error("cannot read .changeset directory");
  }

  const changesets: PendingChangeset[] = [];

  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name)
  )) {
    if (
      !(entry.isFile() && entry.name.endsWith(".md")) ||
      CHANGESET_METADATA_FILES.has(entry.name)
    ) {
      continue;
    }

    changesets.push(
      await parseChangeset(path.join(directory, entry.name), entry.name)
    );
  }

  return changesets;
}

async function parseChangeset(
  filePath: string,
  filename: string
): Promise<PendingChangeset> {
  const text = await readFile(filePath, "utf8");
  const contents = parseChangesetContents(text, filename);

  return {
    relativePath: `${CHANGESET_DIRECTORY}/${filename}`,
    releaseTypes: contents.releaseTypes,
    summary: contents.summary,
  };
}

function parseChangesetContents(
  text: string,
  filename: string
): ChangesetContents {
  if (!text.startsWith("---\n")) {
    throw new Error(`.changeset/${filename} must begin with YAML frontmatter`);
  }

  const closingMarker = text.indexOf("\n---", 4);

  if (closingMarker === -1) {
    throw new Error(`.changeset/${filename} has unterminated YAML frontmatter`);
  }

  const frontmatter = text.slice(4, closingMarker);
  const document = parseDocument(frontmatter);

  if (document.errors.length > 0 || document.warnings.length > 0) {
    throw new Error(`.changeset/${filename} has invalid YAML frontmatter`);
  }

  const value: unknown = document.toJS();

  if (!isObject(value)) {
    throw new Error(`.changeset/${filename} frontmatter must be a mapping`);
  }

  const releaseTypes = new Map<string, string>();

  for (const [packageName, releaseType] of Object.entries(value)) {
    if (typeof releaseType !== "string" || !RELEASE_TYPES.has(releaseType)) {
      throw new Error(
        `.changeset/${filename} has an invalid release type for ${packageName}`
      );
    }

    releaseTypes.set(packageName, releaseType);
  }

  return {
    releaseTypes,
    summary: text.slice(closingMarker + "\n---".length).trim(),
  };
}

async function changesetHasNewOrUpdatedIntent(
  rootDirectory: string,
  baseRevision: string,
  current: PendingChangeset
): Promise<boolean> {
  const baseEntry = await runCommand(
    "git",
    ["ls-tree", "-z", baseRevision, "--", current.relativePath],
    rootDirectory
  );

  if (baseEntry.exitCode !== 0) {
    throw new Error(`cannot inspect base changeset ${current.relativePath}`);
  }

  if (baseEntry.stdout.length === 0) {
    return true;
  }

  const baseContents = await runCommand(
    "git",
    ["show", `${baseRevision}:${current.relativePath}`],
    rootDirectory
  );

  if (baseContents.exitCode !== 0) {
    throw new Error(`cannot read base changeset ${current.relativePath}`);
  }

  const baseContentsParsed = parseChangesetContents(
    baseContents.stdout,
    path.basename(current.relativePath)
  );

  return (
    !sameReleaseTypes(baseContentsParsed.releaseTypes, current.releaseTypes) ||
    (current.summary.length > 0 &&
      current.summary !== baseContentsParsed.summary)
  );
}

function sameReleaseTypes(
  left: ReadonlyMap<string, string>,
  right: ReadonlyMap<string, string>
): boolean {
  if (left.size !== right.size) {
    return false;
  }

  for (const [packageName, releaseType] of left) {
    if (right.get(packageName) !== releaseType) {
      return false;
    }
  }

  return true;
}

async function proveConsumedGeneratedRelease(options: {
  readonly baseRevision: string;
  readonly changedPaths: ReadonlySet<string>;
  readonly manifests: readonly PackageManifest[];
  readonly rootDirectory: string;
}): Promise<string | undefined> {
  const candidate = await findLatestPendingChangesetRevision(
    options.rootDirectory,
    options.baseRevision
  );

  if (candidate === undefined) {
    return "no pending-changeset snapshot exists after the base revision";
  }

  const publicChangeBeforeVersion = await findPublicChangeBetweenRevisions(
    options.rootDirectory,
    options.baseRevision,
    candidate,
    options.manifests
  );

  if (publicChangeBeforeVersion !== undefined) {
    return `public path ${JSON.stringify(publicChangeBeforeVersion)} changed before the pending-changeset snapshot`;
  }

  const unexpectedWorkingOrReleasePath = [...options.changedPaths]
    .sort()
    .find(
      (changedPath) =>
        isPublicPackagePath(changedPath, options.manifests) &&
        !isGeneratedReleasePath(changedPath, options.manifests)
    );

  if (unexpectedWorkingOrReleasePath !== undefined) {
    return `public path ${JSON.stringify(unexpectedWorkingOrReleasePath)} is not generated release output`;
  }

  const temporaryDirectory = await mkdtemp(
    path.join(tmpdir(), "tuvren-changeset-replay-")
  );

  try {
    await rm(temporaryDirectory, { force: true, recursive: true });
    const checkout = await runCommand(
      "git",
      ["worktree", "add", "--detach", temporaryDirectory, candidate],
      options.rootDirectory
    );

    if (checkout.exitCode !== 0) {
      return "could not create the disposable Git worktree needed for release replay";
    }

    const cliPath = path.join(REPO_ROOT, "node_modules/@changesets/cli/bin.js");
    const replay = await runCommand(
      process.execPath,
      [cliPath, "version"],
      temporaryDirectory
    );

    if (replay.exitCode !== 0) {
      return "installed Changesets could not replay the pending release snapshot";
    }

    return compareGeneratedRelease(
      options.rootDirectory,
      temporaryDirectory,
      options.manifests
    );
  } finally {
    await runCommand(
      "git",
      ["worktree", "remove", "--force", temporaryDirectory],
      options.rootDirectory
    );
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
}

async function findLatestPendingChangesetRevision(
  rootDirectory: string,
  baseRevision: string
): Promise<string | undefined> {
  const descendants = await runCommand(
    "git",
    ["rev-list", "--ancestry-path", `${baseRevision}..HEAD`],
    rootDirectory
  );

  if (descendants.exitCode !== 0) {
    throw new Error("cannot inspect Git history for a consumed release");
  }

  const revisions = [...descendants.stdout.split("\n"), baseRevision];

  for (const revision of revisions) {
    if (revision.length === 0) {
      continue;
    }

    const paths = await runCommand(
      "git",
      ["ls-tree", "-r", "--name-only", revision, "--", CHANGESET_DIRECTORY],
      rootDirectory
    );

    if (paths.exitCode !== 0) {
      throw new Error(
        "cannot inspect .changeset history for a consumed release"
      );
    }

    if (
      paths.stdout
        .split("\n")
        .some(
          (filePath) =>
            filePath.endsWith(".md") && path.basename(filePath) !== "README.md"
        )
    ) {
      return revision;
    }
  }

  return undefined;
}

async function findPublicChangeBetweenRevisions(
  rootDirectory: string,
  baseRevision: string,
  candidate: string,
  manifests: readonly PackageManifest[]
): Promise<string | undefined> {
  const result = await runCommand(
    "git",
    [
      "diff",
      "--name-only",
      "-z",
      "--diff-filter=ACDMR",
      `${baseRevision}..${candidate}`,
    ],
    rootDirectory
  );

  if (result.exitCode !== 0) {
    throw new Error("cannot inspect pre-version public package paths");
  }

  return result.stdout
    .split("\0")
    .filter((value) => value.length > 0)
    .map(normalizeGitPath)
    .sort()
    .find((changedPath) => isPublicPackagePath(changedPath, manifests));
}

function isGeneratedReleasePath(
  changedPath: string,
  manifests: readonly PackageManifest[]
): boolean {
  if (
    changedPath === "bun.lock" ||
    changedPath.startsWith(`${CHANGESET_DIRECTORY}/`)
  ) {
    return true;
  }

  return manifests.some(
    (manifest) =>
      (changedPath === `${manifest.directory}/package.json` ||
        changedPath === `${manifest.directory}/CHANGELOG.md`) &&
      manifest.name.startsWith("@tuvren/")
  );
}

function isPublicPackagePath(
  changedPath: string,
  manifests: readonly PackageManifest[]
): boolean {
  return manifests.some(
    (manifest) =>
      !manifest.private &&
      manifest.name.startsWith("@tuvren/") &&
      isPathWithin(manifest.directory, changedPath)
  );
}

async function compareGeneratedRelease(
  rootDirectory: string,
  generatedDirectory: string,
  manifests: readonly PackageManifest[]
): Promise<string | undefined> {
  for (const manifest of manifests) {
    if (manifest.private || !manifest.name.startsWith("@tuvren/")) {
      continue;
    }

    for (const filename of ["package.json", "CHANGELOG.md"]) {
      const relativePath = path.join(manifest.directory, filename);
      const expected = await readOptionalFile(
        path.join(generatedDirectory, relativePath)
      );
      const actual = await readOptionalFile(
        path.join(rootDirectory, relativePath)
      );

      if (expected !== actual) {
        return `${normalizeGitPath(relativePath)} does not match the installed Changesets-generated release output`;
      }
    }
  }

  return undefined;
}

async function readOptionalFile(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return undefined;
  }
}

function matchesWorkspacePattern(directory: string, pattern: string): boolean {
  const parent = pattern.slice(0, -2);
  const prefix = `${parent}/`;

  return (
    directory.startsWith(prefix) &&
    !directory.slice(prefix.length).includes("/")
  );
}

function isPathWithin(directory: string, changedPath: string): boolean {
  return changedPath === directory || changedPath.startsWith(`${directory}/`);
}

function normalizeGitPath(filePath: string): string {
  const normalized = filePath.replaceAll("\\", "/");

  if (normalized.startsWith("/") || normalized.split("/").includes("..")) {
    throw new Error(
      `Git returned an unsafe repository path ${JSON.stringify(filePath)}`
    );
  }

  return normalized;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatPackageNames(manifests: readonly PackageManifest[]): string {
  return manifests.map((manifest) => manifest.name).join(", ");
}

function runCommand(
  executable: string,
  args: readonly string[],
  cwd: string
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(executable, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    function finish(exitCode: number): void {
      if (settled) {
        return;
      }

      settled = true;
      resolve({ exitCode, stderr, stdout });
    }

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once("error", (error: Error) => {
      stderr += error.message;
      finish(1);
    });
    child.once("close", (code) => {
      finish(code ?? 1);
    });
  });
}
