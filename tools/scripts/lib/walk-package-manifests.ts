/**
 * Shared workspace-manifest walker for tools/scripts.
 *
 * One owner for the skip policy: build output (`dist`), dependency trees
 * (`node_modules`), and dot-directories are never descended into, so every
 * caller sees the same notion of "the workspace's package manifests".
 */
import { readdir } from "node:fs/promises";
import path from "node:path";

const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist"]);

/**
 * Recursively find `package.json` manifests under `rootDir` (an absolute
 * path). Returns absolute manifest paths; callers needing repo-relative
 * paths map the result through `path.relative`.
 */
export async function walkPackageManifests(rootDir: string): Promise<string[]> {
  const found: string[] = [];
  const entries = await readdir(rootDir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isFile() && entry.name === "package.json") {
      found.push(path.join(rootDir, entry.name));
    } else if (
      entry.isDirectory() &&
      !(SKIPPED_DIRECTORIES.has(entry.name) || entry.name.startsWith("."))
    ) {
      found.push(
        ...(await walkPackageManifests(path.join(rootDir, entry.name)))
      );
    }
  }

  return found;
}
