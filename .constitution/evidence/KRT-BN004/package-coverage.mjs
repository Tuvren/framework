import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const baseline = "b2244918fbc3cef0ed81cec78fddd686ac0a0427";
const expected = new Map([
  ["@tuvren/core", "patch"],
  ["@tuvren/sdk", "patch"],
  ["@tuvren/backend-memory", "patch"],
  ["@tuvren/backend-postgres", "minor"],
  ["@tuvren/backend-shared", "patch"],
  ["@tuvren/backend-sqlite", "patch"],
  ["@tuvren/kernel-grpc-client", "patch"],
  ["@tuvren/kernel-protocol", "patch"],
  ["@tuvren/kernel-runtime", "patch"],
  ["@tuvren/provider-api", "patch"],
  ["@tuvren/provider-bridge-ai-sdk", "patch"],
  ["@tuvren/runner-react", "patch"],
  ["@tuvren/runtime", "patch"],
  ["@tuvren/stream-agui", "patch"],
  ["@tuvren/stream-core", "patch"],
  ["@tuvren/stream-sse", "patch"],
  ["@tuvren/telemetry-otel", "patch"],
  ["@tuvren/telemetry-semconv", "patch"],
  ["@tuvren/mcp-client", "patch"],
]);

const run = (...args) =>
  execFileSync(args[0], args.slice(1), { cwd: root, encoding: "utf8" });
const changedPaths = run("git", "diff", "--name-only", `${baseline}..HEAD`)
  .trim()
  .split("\n");

function manifests(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules" || entry.name === ".git") {
      return [];
    }
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return manifests(entryPath);
    }
    return entry.name === "package.json" ? [entryPath] : [];
  });
}

const changedPublic = manifests(path.join(root, "typescript"))
  .map((manifestPath) => ({
    directory: path
      .relative(root, path.dirname(manifestPath))
      .split(path.sep)
      .join("/"),
    ...JSON.parse(readFileSync(manifestPath, "utf8")),
  }))
  .filter(
    (manifest) => !manifest.private && manifest.name.startsWith("@tuvren/")
  )
  .filter((manifest) =>
    changedPaths.some((changedPath) =>
      changedPath.startsWith(`${manifest.directory}/`)
    )
  )
  .map((manifest) => manifest.name)
  .sort();

const pending = readdirSync(path.join(root, ".changeset"))
  .filter((name) => name.endsWith(".md") && name !== "README.md")
  .flatMap((name) => [
    ...readFileSync(path.join(root, ".changeset", name), "utf8").matchAll(
      /^"(@tuvren\/[^"]+)": (patch|minor|major|none)$/gm
    ),
  ])
  .reduce((entries, match) => entries.set(match[1], match[2]), new Map());

const expectedNames = [...expected.keys()].sort();
if (JSON.stringify(changedPublic) !== JSON.stringify(expectedNames)) {
  throw new Error(
    `history package set differs: ${JSON.stringify(changedPublic)}`
  );
}
if (pending.size !== expected.size) {
  throw new Error(
    `pending entry count is ${pending.size}, expected ${expected.size}`
  );
}
for (const [name, releaseType] of expected) {
  if (pending.get(name) !== releaseType) {
    throw new Error(
      `${name} is ${pending.get(name) ?? "missing"}, expected ${releaseType}`
    );
  }
}
console.log(
  `package coverage: ${expected.size} public packages, direct classes verified`
);
