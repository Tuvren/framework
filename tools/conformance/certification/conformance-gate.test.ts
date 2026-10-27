import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

test("the conformance lane fails when the negative-control gate fails", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "tuvren-gate-exit-"));
  try {
    const manifestDir = path.join(directory, "tools/conformance/certification");
    await mkdir(manifestDir, { recursive: true });
    await writeFile(
      path.join(manifestDir, "certified-projects.json"),
      JSON.stringify({ projects: ["fixture"] })
    );
    const fakeBun = path.join(directory, "bun");
    await writeFile(
      fakeBun,
      `#!/bin/sh
case "$1" in
  tools/conformance/meta-conformance/negative-controls.ts) exit 23 ;;
  *) exit 0 ;;
esac
`
    );
    await chmod(fakeBun, 0o755);
    const result = spawnSync(
      process.execPath,
      [path.resolve(import.meta.dirname, "../../scripts/conformance.ts")],
      {
        cwd: directory,
        env: { ...process.env, PATH: `${directory}:${process.env.PATH ?? ""}` },
        encoding: "utf8",
      }
    );
    expect(result.status).toBe(23);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the conformance lane propagates a required profile harness failure", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "tuvren-certificate-exit-")
  );
  try {
    const manifestDir = path.join(directory, "tools/conformance/certification");
    await mkdir(manifestDir, { recursive: true });
    await writeFile(
      path.join(manifestDir, "certified-projects.json"),
      JSON.stringify({
        projects: ["fixture"],
        inventory: [
          {
            project: "fixture",
            adapter: "fixture/adapter.json",
            state: "pass",
          },
        ],
        certified: [{ project: "fixture", profile: "fixture.memory" }],
      })
    );
    const fixtureDirectory = path.join(directory, "fixture");
    await mkdir(fixtureDirectory);
    const packetPath = path.join(fixtureDirectory, "packet.json");
    const profilesPath = path.join(fixtureDirectory, "profiles.json");
    await writeFile(
      profilesPath,
      JSON.stringify({
        profiles: [
          {
            profileId: "fixture.memory",
            requiredCapabilities: ["fixture.store"],
            claimIds: ["fixture.claim"],
            faultPoints: [],
            negativeControls: [],
            requiredEvidence: [],
          },
        ],
      })
    );
    await writeFile(
      packetPath,
      JSON.stringify({ certificationProfiles: profilesPath })
    );
    await writeFile(
      path.join(fixtureDirectory, "adapter.json"),
      JSON.stringify({
        adapterId: "fixture",
        implementationId: "fixture",
        language: "typescript",
        boundary: "kernel",
        protocol: {
          name: "tuvren.conformance-adapter",
          version: "0.2.0",
          transport: "json-rpc-2.0-stdio",
        },
        command: ["bun"],
        capabilities: ["fixture.store"],
        authorityPackets: [packetPath],
        profiles: ["fixture.memory"],
        suiteId: "fixture.suite",
        suiteVersion: "0.1.0",
      })
    );
    const fakeBun = path.join(directory, "bun");
    await writeFile(
      fakeBun,
      `#!/bin/sh
case "$1" in
  tools/conformance/harness/run.ts) exit 27 ;;
  *) exit 0 ;;
esac
`
    );
    await chmod(fakeBun, 0o755);
    const result = spawnSync(
      process.execPath,
      [path.resolve(import.meta.dirname, "../../scripts/conformance.ts")],
      {
        cwd: directory,
        env: { ...process.env, PATH: `${directory}:${process.env.PATH ?? ""}` },
        encoding: "utf8",
      }
    );
    expect(result.status).toBe(27);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
