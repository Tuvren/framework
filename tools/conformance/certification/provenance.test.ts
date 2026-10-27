import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  createDependencyDigestCache,
  digestWorkspaceInputs,
} from "./provenance.ts";

test("dependency links cover resolved workspace contents", async () => {
  await mkdir(path.resolve(".cache"), { recursive: true });
  const directory = await mkdtemp(path.resolve(".cache/provenance-test-"));
  try {
    const source = path.join(directory, "package");
    const modules = path.join(directory, "node_modules");
    await mkdir(source);
    await mkdir(modules);
    await writeFile(path.join(source, "index.ts"), "first");
    const link = path.join(modules, "package");
    await symlink(source, link, "dir");
    const before = await digestWorkspaceInputs([link]);
    const cachedDigest = createDependencyDigestCache(modules);
    const beforeCached = await cachedDigest();
    await writeFile(path.join(source, "index.ts"), "second");
    expect(await digestWorkspaceInputs([link])).not.toBe(before);
    expect(await cachedDigest()).not.toBe(beforeCached);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
