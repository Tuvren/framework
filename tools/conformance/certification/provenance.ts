import { createHash } from "node:crypto";
import { lstat, readdir, readFile, readlink, realpath } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import type { AdapterManifest } from "../harness/adapter-client.js";

export interface VerifierDigests {
  harness: string;
  packet: string;
  plans: string;
  catalogs: string;
  fixtures: string;
  profiles: string;
  controls: string;
  verifierAuthority: string;
}

export interface CertificateDigests extends VerifierDigests {
  implementation: string;
  adapterManifest: string;
}

const ROOT = path.resolve(import.meta.dirname, "../../..");
const HARNESS_FILE = /\.(?:ts|js|json)$/u;
const ignoredDirectories = new Set(["node_modules", ".cache", ".git"]);

const filesUnder = async (
  directory: string,
  includeDependencies = false
): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const name = path.join(directory, entry.name);
    if (
      entry.isDirectory() &&
      (!ignoredDirectories.has(entry.name) ||
        (includeDependencies && entry.name === "node_modules"))
    ) {
      files.push(...(await filesUnder(name, includeDependencies)));
    } else if (
      (entry.isFile() || entry.isSymbolicLink()) &&
      !entry.name.endsWith(".tsbuildinfo")
    ) {
      files.push(name);
    }
  }
  return files;
};

const digestFiles = async (files: readonly string[]): Promise<string> => {
  const hash = createHash("sha256");
  for (const file of [...new Set(files)].toSorted()) {
    const stat = await lstat(file);
    let bytes: Buffer;
    if (stat.isSymbolicLink()) {
      const target = await realpath(file);
      if (!target.startsWith(`${ROOT}${path.sep}`)) {
        throw new Error(
          `certificate input link leaves the worktree: ${path.relative(ROOT, file)}`
        );
      }
      bytes = Buffer.from(`symlink:${await readlink(file)}`);
    } else {
      bytes = await readFile(file);
    }
    const label = path.relative(ROOT, file).replaceAll(path.sep, "/");
    hash.update(`${Buffer.byteLength(label)}:${label}:${bytes.length}:`);
    hash.update(bytes);
  }
  return hash.digest("hex");
};

const object = (value: unknown, label: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return Object.fromEntries(Object.entries(value));
};

const readJson = async (file: string): Promise<Record<string, unknown>> =>
  object(JSON.parse(await readFile(file, "utf8")) as unknown, file);

const reference = (value: unknown, label: string): string => {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a file path`);
  }
  return path.resolve(ROOT, value);
};

export const computeVerifierDigests = async (
  packetPaths: readonly string[]
): Promise<VerifierDigests> => {
  const packets = packetPaths.map((packet) => path.resolve(ROOT, packet));
  const plans: string[] = [];
  const catalogs: string[] = [];
  const profiles: string[] = [];
  const controls: string[] = [];
  for (const packetPath of packets) {
    const packet = await readJson(packetPath);
    if (!Array.isArray(packet.conformancePlans)) {
      throw new TypeError(`${packetPath} has no conformance plans`);
    }
    for (const item of packet.conformancePlans) {
      const plan = object(item, packetPath);
      plans.push(reference(plan.path, "plan path"));
    }
    catalogs.push(reference(packet.operationCatalog, "operation catalog"));
    profiles.push(reference(packet.certificationProfiles, "profiles"));
    controls.push(
      reference(packet.negativeControlManifest, "negative controls")
    );
  }
  const fixtures: string[] = [];
  for (const planPath of new Set(plans)) {
    const plan = await readJson(planPath);
    for (const value of [plan.fixtures, plan.scenarios]) {
      if (value === undefined) {
        continue;
      }
      for (const item of Object.values(object(value, planPath))) {
        if (typeof item !== "string") {
          throw new TypeError(`${planPath} contains an invalid fixture path`);
        }
        fixtures.push(path.resolve(path.dirname(planPath), item));
      }
    }
  }
  const authority = [
    ...(await filesUnder(path.join(ROOT, "spec"))),
    ...(await filesUnder(path.join(ROOT, "tools/schemas"))),
    path.join(ROOT, "tools/conformance/certification/certified-projects.json"),
    path.join(
      ROOT,
      "tools/conformance/meta-conformance/kernel-memory-undetected.json"
    ),
    ...(
      await filesUnder(path.join(ROOT, "tools/conformance/adapter-protocol"))
    ).filter((file) => file.endsWith(".schema.json")),
  ];
  const harness = [
    ...(await filesUnder(path.join(ROOT, "tools/conformance"))).filter((file) =>
      HARNESS_FILE.test(file)
    ),
    ...(await filesUnder(path.join(ROOT, "tools/scripts"))).filter((file) =>
      HARNESS_FILE.test(file)
    ),
    path.join(ROOT, "package.json"),
    path.join(ROOT, "bun.lock"),
    ...(await filesUnder(path.join(ROOT, "node_modules"), true)),
  ];
  return {
    harness: createHash("sha256")
      .update(await digestFiles(harness))
      .update(await readFile(process.execPath))
      .digest("hex"),
    packet: await digestFiles(packets),
    plans: await digestFiles(plans),
    catalogs: await digestFiles(catalogs),
    fixtures: await digestFiles(fixtures),
    profiles: await digestFiles(profiles),
    controls: await digestFiles(controls),
    verifierAuthority: await digestFiles([
      ...authority,
      ...packets,
      ...plans,
      ...catalogs,
      ...profiles,
      ...controls,
      ...fixtures,
    ]),
  };
};

export const computeImplementationDigest = async (
  manifest: AdapterManifest
): Promise<string> => {
  if (manifest.language === "rust") {
    if (manifest.executable === undefined) {
      throw new Error(
        "Rust certification requires a directly supervised executable"
      );
    }
    return createHash("sha256")
      .update(await readFile(path.resolve(ROOT, manifest.executable)))
      .digest("hex");
  }
  if (manifest.language === "typescript") {
    return await digestFiles([
      ...(await filesUnder(path.join(ROOT, "typescript"), true)),
      ...(await filesUnder(path.join(ROOT, "node_modules"), true)),
      path.join(ROOT, "bun.lock"),
    ]);
  }
  throw new Error(
    `unsupported certificate implementation ${manifest.language}`
  );
};

export const computeCertificateDigests = async (
  manifest: AdapterManifest,
  manifestPath: string
): Promise<CertificateDigests> => ({
  ...(await computeVerifierDigests(manifest.authorityPackets)),
  implementation: await computeImplementationDigest(manifest),
  adapterManifest: await digestAdapterManifest(manifestPath),
});

export const digestAdapterManifest = async (
  manifestPath: string
): Promise<string> =>
  createHash("sha256")
    .update(await readFile(path.resolve(ROOT, manifestPath)))
    .digest("hex");
