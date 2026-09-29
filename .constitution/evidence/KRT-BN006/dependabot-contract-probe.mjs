import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseDocument } from "yaml";

const configPath = resolve(process.argv[2] ?? ".github/dependabot.yml");
const source = await readFile(configPath, "utf8");
const document = parseDocument(source, { uniqueKeys: true });

assert.equal(
  document.errors.length,
  0,
  `Dependabot YAML must parse without errors: ${document.errors.map(String).join("; ")}`
);

const expectedUpdate = (ecosystem) => ({
  "package-ecosystem": ecosystem,
  directory: "/",
  schedule: { interval: "weekly" },
  groups: {
    "minor-and-patch": {
      patterns: ["*"],
      "update-types": ["minor", "patch"],
    },
  },
  ignore: [
    {
      "dependency-name": "*",
      "update-types": ["version-update:semver-major"],
    },
  ],
});

assert.deepEqual(document.toJS(), {
  version: 2,
  updates: [
    expectedUpdate("bun"),
    expectedUpdate("cargo"),
    expectedUpdate("github-actions"),
  ],
});

console.log(`Dependabot contract passed: ${configPath}`);
console.log("ecosystems=bun,cargo,github-actions; omitted=gomod,pip,pub");
