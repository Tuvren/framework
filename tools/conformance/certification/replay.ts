import nodePath from "node:path";
import process from "node:process";

import { spawn } from "bun";

import {
  CERTIFICATION_MANIFEST_PATH,
  readCertificationManifest,
} from "./certification-manifest.js";

const root = nodePath.resolve(import.meta.dirname, "../../..");
const args = process.argv.slice(2);
if (
  args[0] !== "--project" ||
  args[1] === undefined ||
  args[1].startsWith("--")
) {
  throw new Error("replay requires --project <certification-project>");
}
const project = args[1];
const manifest = await readCertificationManifest(
  nodePath.resolve(root, CERTIFICATION_MANIFEST_PATH)
);
const entry = manifest.inventory.find(
  (candidate) => candidate.project === project
);
if (entry === undefined) {
  throw new Error(`unknown certification project ${project}`);
}
const child = spawn(
  [
    "bun",
    "tools/conformance/harness/run.ts",
    "--adapter",
    entry.adapter,
    ...args.slice(2),
  ],
  { cwd: root, stdin: "inherit", stdout: "inherit", stderr: "inherit" }
);
process.exitCode = await child.exited;
