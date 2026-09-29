import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { Glob } from "bun";

const baseline = "5616aa60faf5029354a4d9aedae2fe7a4a4f6d2d";
const readJson = (filename) => JSON.parse(readFileSync(filename, "utf8"));
const atBaseline = (filename) =>
  JSON.parse(
    execFileSync("git", ["show", `${baseline}:${filename}`], {
      encoding: "utf8",
    })
  );
const before = atBaseline("package.json");
before.devDependencies["@changesets/cli"] = "3.0.3";
const root = readJson("package.json");
assert.deepEqual(root, before, "Only the declared CLI dev-tool pin may change");
assert.equal(
  readJson("node_modules/@changesets/cli/package.json").version,
  "3.0.3"
);
const expectedConfig = atBaseline(".changeset/config.json");
expectedConfig.$schema =
  "https://unpkg.com/@changesets/config@4.0.1/schema.json";
assert.deepEqual(readJson(".changeset/config.json"), expectedConfig);

const manifests = [];
for (const workspace of root.workspaces) {
  for (const filename of new Glob(`${workspace}/package.json`).scanSync({
    cwd: process.cwd(),
  })) {
    const manifest = readJson(filename);
    if (manifest.name?.startsWith("@tuvren/")) {
      manifests.push(manifest);
    }
  }
}
const publicNames = new Set(
  manifests.filter((m) => m.private !== true).map((m) => m.name)
);
assert.equal(publicNames.size, 19);
for (const manifest of manifests.filter((m) => publicNames.has(m.name))) {
  for (const dependencies of [
    manifest.dependencies,
    manifest.optionalDependencies,
    manifest.peerDependencies,
  ]) {
    for (const name of Object.keys(dependencies ?? {})) {
      if (name.startsWith("@tuvren/")) {
        assert.ok(
          publicNames.has(name),
          `${manifest.name} has a private runtime dependency ${name}`
        );
      }
    }
  }
}
const plan = readJson(
  ".constitution/evidence/KRT-BN005/tooling-native-plan.json.txt"
);
assert.equal(plan.releases.length, 30);
assert.ok(
  plan.releases.every(
    (r) =>
      r.type === "minor" && r.oldVersion === "0.1.0" && r.newVersion === "0.2.0"
  )
);
assert.deepEqual(
  plan.releases
    .filter((r) => publicNames.has(r.name))
    .map((r) => r.name)
    .sort(),
  [...publicNames].sort()
);
const intents = plan.changesets.flatMap((c) => c.releases);
assert.equal(intents.length, 19);
assert.deepEqual(
  intents.filter((r) => r.type === "minor").map((r) => r.name),
  ["@tuvren/backend-postgres"]
);
assert.equal(intents.filter((r) => r.type === "patch").length, 18);
console.log(
  "Tooling contract: exact CLI3 pin/config, 30 native minor0.2.0 releases, 19 public, valid direct classes and runtime closure"
);
