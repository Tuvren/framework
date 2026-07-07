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

// KRT-BJ008 (ADR-037, ADR-057): the release versioning lane. Consumes the
// pending changesets under .changeset/, computes version bumps, and applies
// the manifest updates — then re-proves the ADR-037 single-instance invariant
// (every @tuvren package resolves to exactly one version across the release,
// enforced by the config's fixed ["@tuvren/*"] group) before reporting.
//
// This lane NEVER invokes a registry publish. The real publish step is Epic BL
// scope; running the release gate (`bun run release-check`, the full
// verification suite) before acting on this lane's output is the operator's
// responsibility.

import { spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

interface WorkspaceManifest {
  readonly directory: string;
  readonly name: string;
  readonly private: boolean;
  readonly tuvrenDependencyRanges: ReadonlyMap<string, string>;
  readonly version: string;
}

const REPO_ROOT = path.resolve(import.meta.dirname, "../../");
const CHANGESET_DIRECTORY = path.join(REPO_ROOT, ".changeset");

await main();

async function main(): Promise<void> {
  console.log("Tuvren release versioning lane (KRT-BJ008)");
  console.log("- computes changeset version bumps; never publishes");

  const pendingChangesets = await listPendingChangesets();

  if (pendingChangesets.length === 0) {
    console.error(
      "[release-lane] no pending changesets under .changeset/ — record a change intent with `bunx changeset` before running the release lane"
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    `- pending changesets: ${pendingChangesets
      .map((filename) => path.basename(filename, ".md"))
      .join(", ")}`
  );

  const versionExitCode = await spawnCommand("bunx", ["changeset", "version"]);

  if (versionExitCode !== 0) {
    console.error(
      `[release-lane] \`changeset version\` exited with code ${versionExitCode}`
    );
    process.exitCode = 1;
    return;
  }

  const manifests = await readWorkspaceManifests();
  const violations = validateSingleVersionInvariant(manifests);

  if (violations.length > 0) {
    for (const violation of violations) {
      console.error(`[release-lane] ${violation}`);
    }

    console.error(
      "[release-lane] ADR-037 single-version invariant violated after version computation; do not release this state"
    );
    process.exitCode = 1;
    return;
  }

  const publishable = manifests.filter((manifest) => !manifest.private);
  const releaseVersion = publishable[0]?.version ?? "unknown";

  console.log(
    `- computed release version ${releaseVersion} across ${publishable.length} publishable packages:`
  );

  for (const manifest of publishable) {
    console.log(`  - ${manifest.name}@${manifest.version}`);
  }

  console.log(
    "- no registry publish was invoked (Epic BL owns the real publish step)"
  );
  console.log(
    "- next: review the updated manifests/changelogs, run `bun run release-check`, and commit"
  );
}

async function listPendingChangesets(): Promise<string[]> {
  const entries = await readdir(CHANGESET_DIRECTORY, { withFileTypes: true });

  return entries
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith(".md") &&
        entry.name !== "README.md"
    )
    .map((entry) => entry.name)
    .sort();
}

async function readWorkspaceManifests(): Promise<WorkspaceManifest[]> {
  const rootManifest = JSON.parse(
    await readFile(path.join(REPO_ROOT, "package.json"), "utf8")
  ) as { workspaces?: string[] };
  const manifests: WorkspaceManifest[] = [];

  for (const workspaceGlob of rootManifest.workspaces ?? []) {
    if (!workspaceGlob.endsWith("/*")) {
      throw new Error(
        `unsupported workspace glob ${workspaceGlob}; the release lane only understands trailing /* globs`
      );
    }

    const parent = path.join(REPO_ROOT, workspaceGlob.slice(0, -2));
    const entries = await readdir(parent, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const manifestPath = path.join(parent, entry.name, "package.json");
      const manifest = await readManifest(manifestPath);

      if (manifest !== undefined) {
        manifests.push(manifest);
      }
    }
  }

  return manifests.sort((left, right) => left.name.localeCompare(right.name));
}

async function readManifest(
  manifestPath: string
): Promise<WorkspaceManifest | undefined> {
  let text: string;

  try {
    text = await readFile(manifestPath, "utf8");
  } catch {
    return undefined; // a workspace parent directory without a package.json
  }

  const parsed = JSON.parse(text) as {
    dependencies?: Record<string, string>;
    name?: string;
    peerDependencies?: Record<string, string>;
    private?: boolean;
    version?: string;
  };

  if (typeof parsed.name !== "string" || typeof parsed.version !== "string") {
    throw new Error(`${manifestPath} is missing a name or version field`);
  }

  const tuvrenDependencyRanges = new Map<string, string>();

  for (const source of [parsed.dependencies, parsed.peerDependencies]) {
    for (const [dependency, range] of Object.entries(source ?? {})) {
      if (dependency.startsWith("@tuvren/")) {
        tuvrenDependencyRanges.set(dependency, range);
      }
    }
  }

  return {
    directory: path.relative(REPO_ROOT, path.dirname(manifestPath)),
    name: parsed.name,
    private: parsed.private === true,
    tuvrenDependencyRanges,
    version: parsed.version,
  };
}

// ADR-037: leaf packages peer-depend on @tuvren/core so a host resolves
// exactly one core instance; the release model therefore versions every
// @tuvren package in lockstep (the changeset config's fixed group) and every
// in-repo cross-package range stays on the workspace protocol (replaced with
// the single release version at publish time) or pins that same version.
function validateSingleVersionInvariant(
  manifests: readonly WorkspaceManifest[]
): string[] {
  const violations: string[] = [];
  const versions = new Set(manifests.map((manifest) => manifest.version));

  if (versions.size > 1) {
    violations.push(
      `@tuvren packages diverged onto ${versions.size} versions after the bump: ${[
        ...versions,
      ]
        .sort()
        .join(", ")}`
    );
  }

  const releaseVersion = manifests[0]?.version;

  for (const manifest of manifests) {
    for (const [dependency, range] of manifest.tuvrenDependencyRanges) {
      const acceptable =
        range.startsWith("workspace:") ||
        range === releaseVersion ||
        range === `~${releaseVersion}` ||
        range === `^${releaseVersion}`;

      if (!acceptable) {
        violations.push(
          `${manifest.name} (${manifest.directory}) depends on ${dependency}@${range}, which neither uses the workspace protocol nor resolves to the single release version ${releaseVersion}`
        );
      }
    }
  }

  return violations;
}

function spawnCommand(
  executable: string,
  args: readonly string[]
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: REPO_ROOT,
      env: process.env,
      stdio: "inherit",
    });

    child.once("error", reject);
    child.once("close", (code) => {
      resolve(code ?? 1);
    });
  });
}
