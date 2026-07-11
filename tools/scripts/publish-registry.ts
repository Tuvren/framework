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

// KRT-BL003 (ADR-054, ADR-057, ADR-037): the registry publication pipeline.
// Publishes the curated Tuvren package set — the frozen stable core
// (`@tuvren/core`, `@tuvren/sdk`), the published leaf packages, and the
// published-INTERNAL engine tier (`@tuvren/runtime`, `@tuvren/kernel-protocol`,
// `@tuvren/kernel-runtime`, `@tuvren/provider-api`, `@tuvren/telemetry-semconv`)
// that exists on the registry only for dependency resolution (ADR-057 item 5,
// KRT-BL001 §2.6/§5) — with npm provenance.
//
// Modes:
//   --preflight         run every publish gate, touch nothing
//   --dry-run           preflight + per-package tarball verification via
//                       `npm publish --dry-run` on materialized manifests
//   --publish           the real thing; requires a CI OIDC context for
//                       provenance (GitHub Actions `id-token: write`) — a local
//                       publish cannot carry provenance and is refused, per the
//                       KRT-BL003 acceptance criterion
//   --verify-consumer   post-publish acceptance: fresh temp-dir install of the
//                       PUBLISHED packages from the registry and a first Turn
//                       through `createTuvren` imported from @tuvren/sdk
//                       (ADR-057 item 1)
//
// Workspace-protocol materialization is done HERE, deliberately, instead of
// delegating to a package manager's publish command: the ADR-037 tilde range
// on every `@tuvren/core` peer dependency is a STOP condition of this ticket,
// so the transform that produces it is explicit, asserted, and testable —
// `workspace:~` → `~<version>`, `workspace:*` → `<version>` (exact, safe under
// the fixed `["@tuvren/*"]` lockstep group). Any other workspace range fails
// the preflight rather than being guessed at.
//
// Publish order is topological over `@tuvren/*` dependency edges so the
// registry never has a window where a published package references a
// not-yet-published dependency.

import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { walkPackageManifests } from "./lib/walk-package-manifests.js";

interface WorkspacePackage {
  readonly directory: string;
  readonly manifest: PackageManifest;
  readonly name: string;
}

interface PackageManifest {
  dependencies?: Record<string, string>;
  description?: string;
  files?: string[];
  license?: string;
  name?: string;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  private?: boolean;
  repository?: unknown;
  version?: string;
  [key: string]: unknown;
}

const REPO_ROOT = path.resolve(import.meta.dirname, "../../");

// The published-internal engine tier (ADR-057 item 5; KRT-BL001 §2.6 and §5.1):
// on the registry solely so the host-facing packages resolve, never
// host-installable, never semver-guaranteed. Preflight enforces that each one
// declares that posture in its manifest description and README.
const INTERNAL_PUBLISHED_PACKAGES: readonly string[] = [
  "@tuvren/runtime",
  "@tuvren/kernel-protocol",
  "@tuvren/kernel-runtime",
  "@tuvren/provider-api",
  "@tuvren/telemetry-semconv",
];

/**
 * Single owner of the workspace-protocol range vocabulary: preflight accepts
 * exactly the ranges this table can materialize, so the STOP-condition
 * predicate and the publish-time transform cannot drift apart.
 * `workspace:~` → `~<version>` (the ADR-037 tilde range), `workspace:*` →
 * `<version>` (exact pin, safe under the fixed `["@tuvren/*"]` group).
 * Declared above the top-level `await main()` — anything below it is in the
 * temporal dead zone while main runs.
 */
const WORKSPACE_RANGE_MATERIALIZERS: Readonly<
  Record<string, (version: string) => string>
> = {
  "workspace:*": (version) => version,
  "workspace:~": (version) => `~${version}`,
};

const PLACEHOLDER_VERSION = "0.0.0";
const INTERNAL_POSTURE_PATTERN = /[Ii]nternal/;

// The consumer program exercises only the published host import contract
// (ADR-057 item 3): @tuvren/sdk root, @tuvren/core types, and the two chosen
// leaf packages. It never imports @tuvren/runtime or a kernel package.
const FIRST_TURN_SOURCE = `import { createMemoryBackend } from "@tuvren/backend-memory";
import type { TuvrenModelResponse, TuvrenProvider } from "@tuvren/core/provider";
import { createReActRunner } from "@tuvren/runner-react";
import { createTuvren } from "@tuvren/sdk";

const response: TuvrenModelResponse = {
  finishReason: "stop",
  parts: [{ text: "first-turn-ok", type: "text" }],
  usage: { inputTokens: 1, outputTokens: 1 },
};

const provider: TuvrenProvider = {
  generate: () => Promise.resolve(structuredClone(response)),
  id: "consumer-smoke-provider",
  async *stream() {
    await Promise.resolve();
    yield* [];
  },
};

await using instance = await createTuvren({
  backend: createMemoryBackend(),
  provider,
  runner: createReActRunner({ providerCallMode: "generate" }),
});

const thread = await instance.runtime.createThread({});
// The orchestration tier carries createTuvren's default agent config, which
// is where the construction-time provider is bound (ADR-040/057).
const handle = instance.orchestration.executeTurn({
  agent: "agent",
  branchId: thread.branchId,
  signal: { parts: [{ text: "hello tuvren", type: "text" }] },
  threadId: thread.threadId,
});

// Consuming the event stream is what starts orchestration execution; drain
// it concurrently with awaiting the result (same pattern as the
// batteries-included conformance adapter).
const drained = (async () => {
  const events = [];
  for await (const event of handle.allEvents()) {
    events.push(event);
  }
  return events;
})();

const result = await handle.awaitResult();
const events = await drained;

if (events.length === 0) {
  throw new Error("first turn emitted no stream events");
}

if (result.status !== "completed") {
  throw new Error(\`first turn did not complete: \${result.status}\`);
}

const read = await instance.runtime.readBranchMessages({
  branchId: thread.branchId,
});

if (read.messages.length === 0) {
  throw new Error("durable read returned no messages after the first turn");
}

console.log(
  \`first turn completed with \${read.messages.length} durable message(s)\`
);
`;

await main();

async function main(): Promise<void> {
  const mode = process.argv[2];

  switch (mode) {
    case "--build": {
      await buildPublishableSet();
      break;
    }
    case "--preflight": {
      await runPreflight();
      break;
    }
    case "--dry-run": {
      const packages = await runPreflight();
      await publishPackages(packages, { dryRun: true });
      break;
    }
    case "--publish": {
      assertProvenanceCapableEnvironment();
      assertCleanWorktree();
      const packages = await runPreflight();
      await publishPackages(packages, { dryRun: false });
      break;
    }
    case "--verify-consumer": {
      await verifyConsumerInstall(process.argv[3]);
      break;
    }
    default: {
      console.error(
        "[publish-registry] usage: bun tools/scripts/publish-registry.ts --build | --preflight | --dry-run | --publish | --verify-consumer <version>"
      );
      process.exitCode = 1;
    }
  }
}

// ── Build ────────────────────────────────────────────────────────────────────

/**
 * Build exactly the publishable package set (plus whatever `^build` deps Nx
 * pulls in). A bare `nx run-many -t build` also runs gRPC codegen and Rust
 * builds that need the devenv toolchain — unavailable and unnecessary on the
 * publish runner, whose only job is producing the npm `dist/` artifacts.
 */
async function buildPublishableSet(): Promise<void> {
  const publishable = (await readWorkspacePackages()).filter(
    (pkg) => pkg.manifest.private !== true
  );
  const projects = await Promise.all(
    publishable.map(async (pkg) => {
      const project = JSON.parse(
        await readFile(path.join(pkg.directory, "project.json"), "utf8")
      ) as { name?: string };

      if (project.name === undefined) {
        throw new Error(
          `[publish-registry] ${pkg.name}: project.json has no name; cannot scope the build`
        );
      }

      return project.name;
    })
  );

  const build = spawnSync(
    "bun",
    ["run", "nx", "run-many", "-t", "build", "-p", projects.join(",")],
    { cwd: REPO_ROOT, stdio: "inherit" }
  );

  if (build.status !== 0) {
    process.exitCode = 1;
    throw new Error("[publish-registry] publishable-set build failed");
  }
}

// ── Preflight ────────────────────────────────────────────────────────────────

async function runPreflight(): Promise<WorkspacePackage[]> {
  const failures: string[] = [];
  const all = await readWorkspacePackages();
  const publishable = all.filter((pkg) => pkg.manifest.private !== true);
  const publishableNames = new Set(publishable.map((pkg) => pkg.name));

  // KRT-BL003 STOP: the KRT-BL002 freeze snapshot must pass on the exact
  // commit being published.
  const freezeGate = spawnSync(
    "bun",
    ["tools/scripts/api-freeze-gate.ts", "--check"],
    { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] }
  );

  if (freezeGate.status !== 0) {
    failures.push(
      `the ADR-054/056 freeze gate does not pass on this commit:\n${freezeGate.stdout ?? ""}${freezeGate.stderr ?? ""}`
    );
  }

  const versions = new Set(publishable.map((pkg) => pkg.manifest.version));

  if (versions.size !== 1) {
    failures.push(
      `ADR-037 lockstep violated: publishable packages carry ${versions.size} distinct versions (${[...versions].join(", ")})`
    );
  }

  if (versions.has(PLACEHOLDER_VERSION)) {
    failures.push(
      "the 0.0.0 placeholder version is still present — run the release lane (`bun run release`) before publishing"
    );
  }

  for (const pkg of publishable) {
    failures.push(...(await validatePackage(pkg, publishableNames)));
  }

  for (const name of INTERNAL_PUBLISHED_PACKAGES) {
    if (!publishableNames.has(name)) {
      failures.push(
        `${name} must be publishable (it is a registry dependency of the published set, ADR-057 item 5) but is marked private`
      );
    }
  }

  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(`[publish-registry] preflight: ${failure}`);
    }

    process.exitCode = 1;
    throw new Error(`${failures.length} preflight failure(s)`);
  }

  const ordered = topologicalOrder(publishable);
  console.log(
    `[publish-registry] preflight passed: ${ordered.length} packages at ${publishable[0]?.manifest.version} (publish order: ${ordered
      .map((pkg) => pkg.name.replace("@tuvren/", ""))
      .join(" → ")})`
  );

  return ordered;
}

async function validatePackage(
  pkg: WorkspacePackage,
  publishableNames: ReadonlySet<string>
): Promise<string[]> {
  const failures: string[] = [];
  const { manifest, name, directory } = pkg;

  for (const field of ["description", "license", "repository", "files"]) {
    if (manifest[field] === undefined) {
      failures.push(`${name}: manifest lacks "${field}"`);
    }
  }

  if (manifest.license !== undefined && manifest.license !== "Apache-2.0") {
    failures.push(`${name}: license must be Apache-2.0`);
  }

  for (const artifact of ["LICENSE", "README.md"]) {
    if (!(await fileExists(path.join(directory, artifact)))) {
      failures.push(`${name}: missing ${artifact} (ships in the tarball)`);
    }
  }

  if (!(await fileExists(path.join(directory, "dist")))) {
    failures.push(
      `${name}: dist/ is not built — run the build lane before publishing`
    );
  }

  // Unlike LICENSE/README (which npm auto-includes), dist ships only if the
  // `files` allowlist names it — a misconfigured allowlist would publish a
  // code-less tarball that every other check here still passes.
  if (manifest.files !== undefined && !manifest.files.includes("dist")) {
    failures.push(
      `${name}: "files" allowlist does not include "dist" — the tarball would ship no code`
    );
  }

  failures.push(...(await validateInternalPosture(pkg)));
  failures.push(...validateDependencyRanges(pkg, publishableNames));

  return failures;
}

/** ADR-057 item 5 / KRT-BL001 §5.6: the internal tier must self-describe. */
async function validateInternalPosture(
  pkg: WorkspacePackage
): Promise<string[]> {
  if (!INTERNAL_PUBLISHED_PACKAGES.includes(pkg.name)) {
    return [];
  }

  const failures: string[] = [];

  if (!INTERNAL_POSTURE_PATTERN.test(pkg.manifest.description ?? "")) {
    failures.push(
      `${pkg.name}: published-internal package must state its internal posture in the manifest description`
    );
  }

  const readme = await readFile(
    path.join(pkg.directory, "README.md"),
    "utf8"
  ).catch(() => "");

  if (!INTERNAL_POSTURE_PATTERN.test(readme)) {
    failures.push(
      `${pkg.name}: published-internal package must state its internal posture in README.md`
    );
  }

  return failures;
}

function validateDependencyRanges(
  pkg: WorkspacePackage,
  publishableNames: ReadonlySet<string>
): string[] {
  const failures: string[] = [];
  const { manifest, name } = pkg;

  // KRT-BL003 STOP: every @tuvren/core peer dependency must materialize as
  // the ADR-037 tilde range — `workspace:~` is the only accepted in-tree form.
  const corePeer = manifest.peerDependencies?.["@tuvren/core"];

  if (corePeer !== undefined && corePeer !== "workspace:~") {
    failures.push(
      `${name}: @tuvren/core peer range is "${corePeer}" — ADR-037 requires the tilde range ("workspace:~") at publish time (STOP condition)`
    );
  }

  // The classification itself is also load-bearing: a package that references
  // @tuvren/core in dependencies/optionalDependencies would bundle a second
  // core instance in consumer trees, defeating ADR-037's single-instance
  // guarantee even with a correct range (the reason provider-api was
  // reclassified to a peer in KRT-BL003).
  for (const section of ["dependencies", "optionalDependencies"] as const) {
    if (manifest[section]?.["@tuvren/core"] !== undefined) {
      failures.push(
        `${name}: @tuvren/core appears in ${section} — ADR-037 requires it as a peerDependency (single shared instance) on every published package`
      );
    }
  }

  // Registry-resolution closure: every @tuvren dependency of a published
  // package must itself be published. Sections are checked separately — a
  // name appearing in two sections must not mask a bad range in one of them
  // (merging would defer the failure from preflight to mid-publish).
  for (const section of [
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
  ] as const) {
    for (const [depName, range] of Object.entries(manifest[section] ?? {})) {
      if (!depName.startsWith("@tuvren/")) {
        continue;
      }

      if (!publishableNames.has(depName)) {
        failures.push(
          `${name}: ${section} entry ${depName} is not publishable — registry installs would fail to resolve`
        );
      }

      if (
        range.startsWith("workspace:") &&
        WORKSPACE_RANGE_MATERIALIZERS[range] === undefined
      ) {
        failures.push(
          `${name}: workspace range "${range}" on ${depName} (${section}) has no defined materialization — use workspace:~ or workspace:*`
        );
      }
    }
  }

  return failures;
}

// ── Publish ──────────────────────────────────────────────────────────────────

function assertProvenanceCapableEnvironment(): void {
  if (process.env.ACTIONS_ID_TOKEN_REQUEST_URL === undefined) {
    console.error(
      "[publish-registry] --publish requires a CI OIDC context (GitHub Actions with `id-token: write`): npm provenance — a KRT-BL003 acceptance criterion — cannot be produced by a local publish. Run the release workflow (.github/workflows/release.yml) instead, or use --dry-run locally."
    );
    process.exitCode = 1;
    throw new Error("no OIDC context");
  }
}

/**
 * True only when the registry positively confirms the exact version exists.
 * Any failure (network, auth, spawn) returns false so the loop proceeds to a
 * real `npm publish`, whose own duplicate-version rejection stays the
 * backstop — this check may only ever skip work, never invent it.
 */
function isAlreadyPublished(name: string, version: string): boolean {
  const result = spawnSync(
    "npm",
    ["view", `${name}@${version}`, "version", "--json"],
    { encoding: "utf8" }
  );

  return (
    result.status === 0 &&
    (result.stdout ?? "").trim() === JSON.stringify(version)
  );
}

function assertCleanWorktree(): void {
  const status = spawnSync("git", ["status", "--porcelain"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });

  if (status.status !== 0 || (status.stdout ?? "").trim() !== "") {
    console.error(
      "[publish-registry] --publish requires a clean worktree; the published artifacts must correspond to a commit"
    );
    process.exitCode = 1;
    throw new Error("dirty worktree");
  }
}

async function publishPackages(
  ordered: WorkspacePackage[],
  options: { dryRun: boolean }
): Promise<void> {
  for (const pkg of ordered) {
    const materialized = materializeManifest(pkg);

    // Resumability: published versions are immutable, so a real-publish run
    // that failed mid-loop (network, registry, auth) would otherwise be
    // unresumable — re-running hits npm's duplicate-version rejection on the
    // packages that already made it. Skipping those turns "re-run the release
    // workflow" into the recovery path for a torn release.
    if (
      !options.dryRun &&
      isAlreadyPublished(pkg.name, materialized.version ?? "")
    ) {
      console.log(
        `[publish-registry] already on the registry, skipping: ${pkg.name}@${materialized.version}`
      );
      continue;
    }

    const manifestPath = path.join(pkg.directory, "package.json");
    const original = await readFile(manifestPath, "utf8");

    await writeFile(manifestPath, `${JSON.stringify(materialized, null, 2)}\n`);

    try {
      // This flag is what makes the packages public — the matching
      // `access: "public"` in .changeset/config.json only governs a
      // `changeset publish` invocation, which this pipeline does not use.
      const args = [
        "publish",
        "--access",
        "public",
        ...(options.dryRun ? ["--dry-run"] : ["--provenance"]),
      ];
      const result = spawnSync("npm", args, {
        cwd: pkg.directory,
        stdio: "inherit",
      });

      if (result.status !== 0) {
        throw new Error(
          `[publish-registry] npm publish failed for ${pkg.name}`
        );
      }
    } finally {
      // Restore the workspace-protocol manifest byte-for-byte.
      await writeFile(manifestPath, original);
    }

    console.log(
      `[publish-registry] ${options.dryRun ? "dry-run verified" : "published"}: ${pkg.name}@${materialized.version}`
    );
  }

  if (options.dryRun) {
    console.log(
      "[publish-registry] dry run complete — no registry mutation occurred"
    );
  }
}

function materializeManifest(pkg: WorkspacePackage): PackageManifest {
  const manifest = structuredClone(pkg.manifest);
  const version = manifest.version;

  if (version === undefined) {
    throw new Error(`${pkg.name}: manifest has no version`);
  }

  for (const section of [
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
  ] as const) {
    const entries = manifest[section];

    if (entries === undefined) {
      continue;
    }

    for (const [depName, range] of Object.entries(entries)) {
      const materialize = WORKSPACE_RANGE_MATERIALIZERS[range];

      if (materialize !== undefined) {
        entries[depName] = materialize(version);
      } else if (range.startsWith("workspace:")) {
        throw new Error(
          `${pkg.name}: unexpected workspace range "${range}" on ${depName} survived preflight`
        );
      }
    }
  }

  // devDependencies never ship; drop them so a stray workspace: range there
  // cannot confuse registry tooling.
  manifest.devDependencies = undefined;

  return manifest;
}

function topologicalOrder(packages: WorkspacePackage[]): WorkspacePackage[] {
  const byName = new Map(packages.map((pkg) => [pkg.name, pkg]));
  const visited = new Set<string>();
  const ordered: WorkspacePackage[] = [];

  const visit = (pkg: WorkspacePackage, trail: string[]): void => {
    if (visited.has(pkg.name)) {
      return;
    }

    if (trail.includes(pkg.name)) {
      throw new Error(
        `[publish-registry] dependency cycle: ${[...trail, pkg.name].join(" → ")}`
      );
    }

    // Peer edges are included deliberately: a peer is provided by the
    // consumer, so it is not strictly a publish-order constraint, but
    // ordering by it too keeps the "never reference a not-yet-published
    // package" guarantee conservative. Today no @tuvren peer target has
    // @tuvren edges of its own, so this cannot manufacture a false cycle.
    for (const depName of Object.keys({
      ...pkg.manifest.dependencies,
      ...pkg.manifest.optionalDependencies,
      ...pkg.manifest.peerDependencies,
    })) {
      const dep = byName.get(depName);

      if (dep !== undefined) {
        visit(dep, [...trail, pkg.name]);
      }
    }

    visited.add(pkg.name);
    ordered.push(pkg);
  };

  for (const pkg of [...packages].sort((a, b) => (a.name < b.name ? -1 : 1))) {
    visit(pkg, []);
  }

  return ordered;
}

// ── Consumer verification (post-publish acceptance) ─────────────────────────

/**
 * KRT-BL003 acceptance: a consumer installing the PUBLISHED packages fresh
 * (no workspace links, no local tarballs) can issue a first Turn by calling
 * `createTuvren` from the published `@tuvren/sdk` root export.
 */
async function verifyConsumerInstall(
  version: string | undefined
): Promise<void> {
  if (version === undefined || version === "") {
    console.error(
      "[publish-registry] --verify-consumer requires the published version, e.g. --verify-consumer 0.1.0"
    );
    process.exitCode = 1;
    return;
  }

  const workDir = await mkdtemp(path.join(tmpdir(), "tuvren-consumer-"));

  try {
    await writeFile(
      path.join(workDir, "package.json"),
      `${JSON.stringify(
        {
          dependencies: {
            "@tuvren/backend-memory": version,
            "@tuvren/core": version,
            "@tuvren/runner-react": version,
            "@tuvren/sdk": version,
          },
          name: "tuvren-consumer-smoke",
          private: true,
          type: "module",
        },
        null,
        2
      )}\n`
    );

    await writeFile(path.join(workDir, "first-turn.ts"), FIRST_TURN_SOURCE);

    const install = spawnSync("bun", ["install"], {
      cwd: workDir,
      stdio: "inherit",
    });

    if (install.status !== 0) {
      throw new Error("fresh install of the published packages failed");
    }

    const run = spawnSync("bun", ["first-turn.ts"], {
      cwd: workDir,
      stdio: "inherit",
    });

    if (run.status !== 0) {
      throw new Error("first Turn against the published packages failed");
    }

    console.log(
      `[publish-registry] consumer verification passed: fresh install of ${version} completed a first Turn via createTuvren from @tuvren/sdk`
    );
  } catch (error) {
    process.exitCode = 1;
    console.error(`[publish-registry] consumer verification failed: ${error}`);
  } finally {
    await rm(workDir, { force: true, recursive: true });
  }
}

// ── Shared helpers ───────────────────────────────────────────────────────────

async function readWorkspacePackages(): Promise<WorkspacePackage[]> {
  const packages: WorkspacePackage[] = [];

  for (const manifestPath of await walkPackageManifests(
    path.join(REPO_ROOT, "typescript")
  )) {
    const manifest = JSON.parse(
      await readFile(manifestPath, "utf8")
    ) as PackageManifest;

    if (manifest.name?.startsWith("@tuvren/")) {
      packages.push({
        directory: path.dirname(manifestPath),
        manifest,
        name: manifest.name,
      });
    }
  }

  return packages;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}
