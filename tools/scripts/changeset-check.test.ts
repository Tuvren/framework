import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkChangesetCoverage } from "./changeset-check.js";

interface CommandResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

interface Fixture {
  commit(message: string): Promise<void>;
  privateChange(content: string): Promise<void>;
  publicChange(content: string): Promise<void>;
  publicSourceTypeChange(): Promise<void>;
  readonly root: string;
  writeChangeset(filename: string, frontmatter: string): Promise<void>;
  writeChangesetContents(filename: string, contents: string): Promise<void>;
  writePublicManifest(description: string, isPrivate?: boolean): Promise<void>;
}

const REPO_ROOT = path.resolve(import.meta.dirname, "../../");
const CHANGESET_CLI = path.join(
  REPO_ROOT,
  "node_modules/@changesets/cli/bin.js"
);
const fixtureRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    fixtureRoots
      .splice(0)
      .map((fixtureRoot) => rm(fixtureRoot, { force: true, recursive: true }))
  );
});

describe("changeset-check", () => {
  test("fails when a changed public package has no changeset", async () => {
    const fixture = await createFixture();
    await fixture.publicChange("export const changed = true;\n");
    await fixture.commit("change public package");

    await expect(check(fixture)).rejects.toThrow("@tuvren/public-a");
  });

  test("passes when a changed public package has a direct changeset", async () => {
    const fixture = await createFixture();
    await fixture.publicChange("export const changed = true;\n");
    await fixture.writeChangeset("public.md", '"@tuvren/public-a": patch');
    await fixture.commit("change public package with intent");

    await expect(check(fixture)).resolves.toBeUndefined();
  });

  test("does not let unrelated or empty changesets cover a public package", async () => {
    const fixture = await createFixture();
    await fixture.publicChange("export const changed = true;\n");
    await fixture.writeChangeset("unrelated.md", '"@tuvren/private-a": patch');
    await fixture.writeChangeset("empty.md", "{}");
    await fixture.commit("change public package with unrelated intent");

    await expect(check(fixture)).rejects.toThrow("@tuvren/public-a");
  });

  test("rejects every changeset package that native status rejects", async () => {
    const fixture = await createFixture();
    await fixture.publicChange("export const changed = true;\n");
    await fixture.writeChangeset(
      "unknown-package.md",
      '"@tuvren/public-a": patch\n"@tuvren/ghost": patch'
    );
    await fixture.commit("add an unknown changeset package");

    const status = await run(
      process.execPath,
      [CHANGESET_CLI, "status", "--since", "master"],
      fixture.root
    );

    expect(status.exitCode).toBe(1);
    expect(`${status.stdout}${status.stderr}`).toContain(
      "not in the workspace"
    );
    await expect(check(fixture)).rejects.toThrow("@tuvren/ghost");
  });

  test("rejects malformed delimiters that native status rejects", async () => {
    const fixture = await createFixture();
    await fixture.publicChange("export const changed = true;\n");
    await fixture.writeChangesetContents(
      "malformed-delimiter.md",
      '---\n"@tuvren/public-a": patch\n---garbage\n\nFixture release note.\n'
    );
    await fixture.commit("add a malformed changeset delimiter");

    const status = await run(
      process.execPath,
      [CHANGESET_CLI, "status", "--since", "master"],
      fixture.root
    );

    expect(status.exitCode).toBe(1);
    await expect(check(fixture)).rejects.toThrow("frontmatter");
  });

  test("accepts delimiter formats supported by the installed parser", async () => {
    const fixture = await createFixture();
    await fixture.publicChange("export const changed = true;\n");
    await fixture.writeChangesetContents(
      "native-delimiter.md",
      '---\r\n"@tuvren/public-a": patch\r\n---  \r\n\r\nFixture release note.\r\n'
    );
    await fixture.commit("add a native-compatible changeset delimiter");

    const status = await run(
      process.execPath,
      [CHANGESET_CLI, "status", "--since", "master"],
      fixture.root
    );

    expect(status.exitCode).toBe(0);
    await expect(check(fixture)).resolves.toBeUndefined();
  });

  test("does not let a native-valid none release cover a public package", async () => {
    const fixture = await createFixture();
    await fixture.publicChange("export const changed = true;\n");
    await fixture.writeChangeset("public-none.md", '"@tuvren/public-a": none');
    await fixture.commit("change public package with no release intent");

    const outputPath = path.join(fixture.root, "status.json");
    const status = await run(
      process.execPath,
      [CHANGESET_CLI, "status", "--since", "master", "--output", outputPath],
      fixture.root
    );
    const report = JSON.parse(await readFile(outputPath, "utf8")) as unknown;

    expect(status.exitCode).toBe(0);
    expect(releaseVersion(report, "@tuvren/public-a")).toEqual({
      newVersion: "1.0.0",
      oldVersion: "1.0.0",
    });
    await expect(check(fixture)).rejects.toThrow("@tuvren/public-a");
  });

  test("does not let an old pending changeset cover a new public change", async () => {
    const fixture = await createFixture();
    await run("git", ["checkout", "master"], fixture.root);
    await fixture.writeChangeset("old.md", '"@tuvren/public-a": patch');
    await fixture.commit("record existing intent");
    await run("git", ["branch", "-f", "feature", "master"], fixture.root);
    await run("git", ["checkout", "feature"], fixture.root);
    await fixture.publicChange("export const later = true;\n");
    await fixture.commit("change public package after intent");

    await expect(check(fixture)).rejects.toThrow("@tuvren/public-a");
  });

  test("accepts a changed nonempty changeset release note as an updated intent", async () => {
    const fixture = await createFixture();
    await run("git", ["checkout", "master"], fixture.root);
    await fixture.writeChangeset("old.md", '"@tuvren/public-a": patch');
    await fixture.commit("record existing intent");
    await run("git", ["branch", "-f", "feature", "master"], fixture.root);
    await run("git", ["checkout", "feature"], fixture.root);
    await fixture.publicChange("export const later = true;\n");
    await appendFile(
      path.join(fixture.root, ".changeset/old.md"),
      "Updated release note accompanying the public source change.\n"
    );
    await fixture.commit("change source and changeset prose");

    await expect(check(fixture)).resolves.toBeUndefined();
  });

  test("does not let a renamed unchanged pending intent cover a new public change", async () => {
    const fixture = await createFixture();
    await run("git", ["checkout", "master"], fixture.root);
    await fixture.writeChangeset("old.md", '"@tuvren/public-a": patch');
    await fixture.commit("record existing intent");
    await run("git", ["branch", "-f", "feature", "master"], fixture.root);
    await run("git", ["checkout", "feature"], fixture.root);
    await fixture.publicChange("export const later = true;\n");
    await run(
      "git",
      ["mv", ".changeset/old.md", ".changeset/renamed.md"],
      fixture.root
    );
    await fixture.commit("change source and rename unchanged intent");

    await expect(check(fixture)).rejects.toThrow("@tuvren/public-a");
  });

  test("matches native Changesets metadata filtering", async () => {
    const fixture = await createFixture();
    await fixture.publicChange("export const changed = true;\n");
    await fixture.writeChangeset("public.md", '"@tuvren/public-a": patch');

    for (const filename of [
      ".hidden.md",
      "rEaDmE.md",
      "AGENTS.md",
      "CLAUDE.md",
      "GEMINI.md",
    ]) {
      await fixture.writeChangesetContents(filename, "not a changeset\n");
    }
    await fixture.commit("add changeset metadata files");

    const status = await run(
      process.execPath,
      [CHANGESET_CLI, "status", "--since", "master"],
      fixture.root
    );

    expect(status.exitCode).toBe(0);
    await expect(check(fixture)).resolves.toBeUndefined();
  });

  test("exempts private-only and root-only changes", async () => {
    const privateFixture = await createFixture();
    await privateFixture.privateChange("export const changed = true;\n");
    await privateFixture.commit("change private package");
    await expect(check(privateFixture)).resolves.toBeUndefined();

    const rootFixture = await createFixture();
    await writeFile(path.join(rootFixture.root, "README.md"), "root only\n");
    await rootFixture.commit("change root file");
    await expect(check(rootFixture)).resolves.toBeUndefined();
  });

  test("exempts a package made private by its current manifest", async () => {
    const fixture = await createFixture();
    await fixture.writePublicManifest("now private", true);
    await fixture.commit("make package private");

    await expect(check(fixture)).resolves.toBeUndefined();
  });

  test("measures Changesets status private/fixed behavior without using it as coverage", async () => {
    const fixture = await createFixture();
    await fixture.privateChange("export const changed = true;\n");
    const missingStatus = await run(
      process.execPath,
      [CHANGESET_CLI, "status", "--since", "master"],
      fixture.root
    );
    expect(missingStatus.exitCode).toBe(1);
    await fixture.writeChangeset("private.md", '"@tuvren/private-a": patch');
    await fixture.commit("private changeset");

    const outputPath = path.join(fixture.root, "status.json");
    const status = await run(
      process.execPath,
      [CHANGESET_CLI, "status", "--since", "master", "--output", outputPath],
      fixture.root
    );
    const report = JSON.parse(await readFile(outputPath, "utf8")) as unknown;

    expect(status.exitCode).toBe(0);
    expect(releaseNames(report)).toContain("@tuvren/private-a");
    expect(releaseNames(report)).toContain("@tuvren/public-a");
    await expect(check(fixture)).resolves.toBeUndefined();
  });

  test("fails clearly when the requested base cannot resolve", async () => {
    const fixture = await createFixture();

    await expect(
      checkChangesetCoverage({
        base: "missing-base",
        rootDirectory: fixture.root,
      })
    ).rejects.toThrow("cannot resolve base revision");
  });

  test("covers staged, unstaged, and untracked working-tree changes", async () => {
    const fixture = await createFixture();
    await fixture.publicChange("export const staged = true;\n");
    const stage = await run(
      "git",
      ["add", "packages/public-a/src.ts"],
      fixture.root
    );
    expect(stage.exitCode).toBe(0);
    await fixture.publicChange(
      "export const staged = true;\nexport const unstaged = true;\n"
    );
    await fixture.writeChangeset(
      "working-tree.md",
      '"@tuvren/public-a": patch'
    );

    const staged = await run(
      "git",
      ["diff", "--cached", "--name-only"],
      fixture.root
    );
    const unstaged = await run("git", ["diff", "--name-only"], fixture.root);
    const untracked = await run(
      "git",
      ["ls-files", "--others", "--exclude-standard"],
      fixture.root
    );

    expect(staged.exitCode).toBe(0);
    expect(staged.stdout).toContain("packages/public-a/src.ts");
    expect(unstaged.exitCode).toBe(0);
    expect(unstaged.stdout).toContain("packages/public-a/src.ts");
    expect(untracked.exitCode).toBe(0);
    expect(untracked.stdout).toContain(".changeset/working-tree.md");

    await expect(check(fixture)).resolves.toBeUndefined();
  });

  test("requires intent for public source type changes in each Git state", async () => {
    const fixture = await createFixture();
    await fixture.publicSourceTypeChange();
    const workingTree = await run(
      "git",
      ["diff", "--name-status"],
      fixture.root
    );

    expect(workingTree.stdout).toContain("T\tpackages/public-a/src.ts");

    await expect(check(fixture)).rejects.toThrow("@tuvren/public-a");

    const stage = await run(
      "git",
      ["add", "packages/public-a/src.ts"],
      fixture.root
    );
    expect(stage.exitCode).toBe(0);
    const staged = await run(
      "git",
      ["diff", "--cached", "--name-status"],
      fixture.root
    );
    expect(staged.stdout).toContain("T\tpackages/public-a/src.ts");

    await expect(check(fixture)).rejects.toThrow("@tuvren/public-a");
    await fixture.commit("replace public source with symlink");

    await expect(check(fixture)).rejects.toThrow("@tuvren/public-a");
    await fixture.writeChangeset("type-change.md", '"@tuvren/public-a": patch');
    await fixture.commit("record intent for public source type change");

    await expect(check(fixture)).resolves.toBeUndefined();
  });

  test("accepts a consumed release only when installed Changesets reproduces it", async () => {
    const fixture = await createGeneratedReleaseFixture();

    await expect(check(fixture)).resolves.toBeUndefined();
  });

  test("replays the newest pending changeset snapshot after release-note updates", async () => {
    const fixture = await createFixture();
    await run("git", ["checkout", "master"], fixture.root);
    await fixture.writeChangeset("release.md", '"@tuvren/public-a": patch');
    await fixture.commit("record release intent");
    await run("git", ["branch", "-f", "feature", "master"], fixture.root);
    await run("git", ["checkout", "feature"], fixture.root);
    await appendFile(
      path.join(fixture.root, ".changeset/release.md"),
      "Updated release note before versioning.\n"
    );
    await fixture.commit("update release note");
    await generateRelease(fixture);

    await expect(check(fixture)).resolves.toBeUndefined();
  });

  test("rejects source changes concealed by a generated version bump", async () => {
    const fixture = await createGeneratedReleaseFixture();
    await fixture.publicChange("export const concealed = true;\n");
    await fixture.commit("conceal source change");

    await expect(check(fixture)).rejects.toThrow(
      "is not generated release output"
    );
  });

  test("rejects non-version public manifest edits concealed by a version bump", async () => {
    const fixture = await createGeneratedReleaseFixture();
    await fixture.writePublicManifest("concealed manifest edit");
    await fixture.commit("conceal manifest change");

    await expect(check(fixture)).rejects.toThrow("does not match");
  });

  test("rejects public source changes before an unrelated private intent", async () => {
    const fixture = await createFixture();
    await fixture.publicChange("export const concealed = true;\n");
    await fixture.commit("change public source before unrelated intent");
    await fixture.writeChangeset("private.md", '"@tuvren/private-a": patch');
    await fixture.commit("record unrelated private intent");
    await generateRelease(fixture);

    await expect(check(fixture)).rejects.toThrow(
      "changed before the pending-changeset snapshot"
    );
  });

  test("rejects public manifest edits before an unrelated private intent", async () => {
    const fixture = await createFixture();
    await fixture.writePublicManifest("concealed before private intent");
    await fixture.commit("change public manifest before unrelated intent");
    await fixture.writeChangeset("private.md", '"@tuvren/private-a": patch');
    await fixture.commit("record unrelated private intent");
    await generateRelease(fixture);

    await expect(check(fixture)).rejects.toThrow(
      "changed before the pending-changeset snapshot"
    );
  });

  test("wires CI to test the checker and pass the exact pull-request base SHA", async () => {
    const workflow = await readFile(
      path.join(REPO_ROOT, ".github/workflows/ci.yml"),
      "utf8"
    );

    expect(workflow).toContain(
      "bun test tools/scripts/changeset-check.test.ts"
    );
    expect(workflow).toContain("github.event.pull_request.base.sha");
    expect(workflow).toContain(
      'bun run changeset:check --base="$CHANGESET_BASE"'
    );
  });
});

async function createGeneratedReleaseFixture(): Promise<Fixture> {
  const fixture = await createFixture();
  await run("git", ["checkout", "master"], fixture.root);
  await fixture.writeChangeset("release.md", '"@tuvren/public-a": patch');
  await fixture.commit("record release intent");
  await run("git", ["branch", "-f", "feature", "master"], fixture.root);
  await run("git", ["checkout", "feature"], fixture.root);
  await generateRelease(fixture);
  return fixture;
}

async function generateRelease(fixture: Fixture): Promise<void> {
  const version = await run(
    process.execPath,
    [CHANGESET_CLI, "version"],
    fixture.root
  );
  expect(version.exitCode).toBe(0);
  await fixture.commit("generate release");
}

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), "tuvren-changeset-check-"));
  fixtureRoots.push(root);
  await writeFixtureFile(
    root,
    "package.json",
    JSON.stringify(
      { name: "fixture", private: true, workspaces: ["packages/*"] },
      null,
      2
    )
  );
  // @manypkg/tools detects Bun workspaces from the repository's lockfile.
  await writeFixtureFile(root, "bun.lock", "");
  await writeFixtureFile(
    root,
    ".changeset/config.json",
    JSON.stringify(
      {
        access: "public",
        baseBranch: "master",
        changelog: "@changesets/cli/changelog",
        commit: false,
        fixed: [["@tuvren/*"]],
        ignore: [],
        linked: [],
        privatePackages: { tag: false, version: true },
        updateInternalDependencies: "patch",
      },
      null,
      2
    )
  );
  await writeFixtureFile(root, ".changeset/README.md", "fixture metadata\n");
  await writeFixtureFile(
    root,
    "packages/public-a/package.json",
    JSON.stringify(publicManifest("initial"), null, 2)
  );
  await writeFixtureFile(
    root,
    "packages/public-a/src.ts",
    "export const initial = true;\n"
  );
  await writeFixtureFile(
    root,
    "packages/private-a/package.json",
    JSON.stringify(
      { name: "@tuvren/private-a", private: true, version: "1.0.0" },
      null,
      2
    )
  );
  await writeFixtureFile(
    root,
    "packages/private-a/src.ts",
    "export const initial = true;\n"
  );
  await run("git", ["init", "--initial-branch=master"], root);
  await run("git", ["config", "user.email", "fixture@example.test"], root);
  await run("git", ["config", "user.name", "Fixture"], root);
  await run("git", ["add", "."], root);
  await run("git", ["commit", "-m", "initial"], root);
  await run("git", ["checkout", "-b", "feature"], root);

  return {
    root,
    commit: async (message: string): Promise<void> => {
      const add = await run("git", ["add", "."], root);
      expect(add.exitCode).toBe(0);
      const commit = await run("git", ["commit", "-m", message], root);
      expect(commit.exitCode).toBe(0);
    },
    publicChange: async (content: string): Promise<void> => {
      await writeFixtureFile(root, "packages/public-a/src.ts", content);
    },
    publicSourceTypeChange: async (): Promise<void> => {
      await rm(path.join(root, "packages/public-a/src.ts"));
      await symlink(
        "../private-a/src.ts",
        path.join(root, "packages/public-a/src.ts")
      );
    },
    privateChange: async (content: string): Promise<void> => {
      await writeFixtureFile(root, "packages/private-a/src.ts", content);
    },
    writeChangeset: async (
      filename: string,
      frontmatter: string
    ): Promise<void> => {
      await writeFixtureFile(
        root,
        `.changeset/${filename}`,
        `---\n${frontmatter}\n---\n\nFixture release note.\n`
      );
    },
    writeChangesetContents: async (
      filename: string,
      contents: string
    ): Promise<void> => {
      await writeFixtureFile(root, `.changeset/${filename}`, contents);
    },
    writePublicManifest: async (
      description: string,
      isPrivate = false
    ): Promise<void> => {
      await writeFixtureFile(
        root,
        "packages/public-a/package.json",
        JSON.stringify(publicManifest(description, isPrivate), null, 2)
      );
    },
  };
}

function publicManifest(
  description: string,
  isPrivate = false
): Record<string, unknown> {
  return {
    description,
    name: "@tuvren/public-a",
    ...(isPrivate ? { private: true } : {}),
    version: "1.0.0",
  };
}

async function writeFixtureFile(
  root: string,
  relativePath: string,
  content: string
): Promise<void> {
  const filePath = path.join(root, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content);
}

function check(fixture: Fixture): Promise<void> {
  return checkChangesetCoverage({
    base: "master",
    rootDirectory: fixture.root,
  });
}

function releaseNames(value: unknown): string[] {
  if (!(isObject(value) && Array.isArray(value.releases))) {
    throw new Error("Changesets status did not produce a releases array");
  }

  const names: string[] = [];

  for (const release of value.releases) {
    if (!isObject(release) || typeof release.name !== "string") {
      throw new Error("Changesets status produced an invalid release entry");
    }

    names.push(release.name);
  }

  return names;
}

function releaseVersion(
  value: unknown,
  packageName: string
): { readonly newVersion: string; readonly oldVersion: string } {
  if (!(isObject(value) && Array.isArray(value.releases))) {
    throw new Error("Changesets status did not produce a releases array");
  }

  const release = value.releases.find(
    (entry) => isObject(entry) && entry.name === packageName
  );

  if (
    !(
      isObject(release) &&
      typeof release.oldVersion === "string" &&
      typeof release.newVersion === "string"
    )
  ) {
    throw new Error(
      `Changesets status did not produce versions for ${JSON.stringify(packageName)}`
    );
  }

  return { newVersion: release.newVersion, oldVersion: release.oldVersion };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function run(
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

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once("error", (error: Error) => {
      stderr += error.message;
    });
    child.once("close", (code) => {
      resolve({ exitCode: code ?? 1, stderr, stdout });
    });
  });
}
