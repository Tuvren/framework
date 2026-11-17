import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat,
  readdir,
  readFile,
  readlink,
  realpath,
  stat,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";

import type { AdapterManifest } from "../harness/adapter-client.js";
import { readUndetectedRegisterReferences } from "./profile.js";

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

export interface SourceCertificateDigests extends Omit<
  VerifierDigests,
  "harness"
> {
  adapterManifest: string;
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

const expandWorkspaceInputs = async (
  files: readonly string[],
  workspaceRoot: string
): Promise<Set<string>> => {
  const expanded = new Set(files);
  const targets = new Set<string>();
  for (const file of expanded) {
    if (!(await lstat(file)).isSymbolicLink()) {
      continue;
    }
    const target = await realpath(file);
    if (!target.startsWith(`${workspaceRoot}${path.sep}`)) {
      throw new Error(
        `certificate input link leaves the worktree: ${path.relative(workspaceRoot, file)}`
      );
    }
    if (!target.split(path.sep).includes("node_modules")) {
      if (targets.has(target)) {
        continue;
      }
      targets.add(target);
      if ((await stat(target)).isDirectory()) {
        for (const child of await filesUnder(target)) {
          expanded.add(child);
        }
      } else {
        expanded.add(target);
      }
    }
  }
  return expanded;
};

export const digestWorkspaceInputs = async (
  files: readonly string[],
  workspaceRoot = ROOT
): Promise<string> => {
  const expanded = await expandWorkspaceInputs(files, workspaceRoot);
  const hash = createHash("sha256");
  for (const file of [...expanded].toSorted()) {
    const stat = await lstat(file);
    let bytes: Buffer;
    if (stat.isSymbolicLink()) {
      const target = await realpath(file);
      if (!target.startsWith(`${workspaceRoot}${path.sep}`)) {
        throw new Error(
          `certificate input link leaves the worktree: ${path.relative(workspaceRoot, file)}`
        );
      }
      bytes = Buffer.from(`symlink:${await readlink(file)}`);
    } else {
      bytes = await readFile(file);
    }
    const label = path.relative(workspaceRoot, file).replaceAll(path.sep, "/");
    hash.update(`${Buffer.byteLength(label)}:${label}:${bytes.length}:`);
    hash.update(bytes);
  }
  return hash.digest("hex");
};

export const digestVerifierAuthority = async (
  authorityInputs: readonly string[],
  registerInputs: readonly string[]
): Promise<string> =>
  await digestWorkspaceInputs([...authorityInputs, ...registerInputs]);

export const createDependencyDigestCache = (
  directory: string,
  workspaceRoot = ROOT
) => {
  let cached: Promise<{ digest: string; links: string[] }> | undefined;
  const initialize = async () => {
    const files = await filesUnder(directory, true);
    const links: string[] = [];
    for (const file of files) {
      if ((await lstat(file)).isSymbolicLink()) {
        links.push(file);
      }
    }
    return { digest: await digestWorkspaceInputs(files, workspaceRoot), links };
  };
  return async (): Promise<string> => {
    cached ??= initialize();
    let value: { digest: string; links: string[] };
    try {
      value = await cached;
    } catch (error: unknown) {
      cached = undefined;
      throw error;
    }
    return createHash("sha256")
      .update(value.digest)
      .update(await digestWorkspaceInputs(value.links, workspaceRoot))
      .digest("hex");
  };
};

const nodeModulesDigest = createDependencyDigestCache(
  path.join(ROOT, "node_modules")
);

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

export const collectSourceVerifierInputs = async (
  packetPaths: readonly string[]
) => {
  const packets = packetPaths.map((packet) => path.resolve(ROOT, packet));
  const plans: string[] = [];
  const catalogs: string[] = [];
  const profiles: string[] = [];
  const controls: string[] = [];
  const registers: string[] = [];
  for (const packetPath of packets) {
    const packet = await readJson(packetPath);
    registers.push(
      ...[...(await readUndetectedRegisterReferences(packetPath)).values()].map(
        (file) => path.resolve(ROOT, file)
      )
    );
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
  const { stdout } = await promisify(execFile)(
    "git",
    [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
      "--",
      "spec",
      "tools/schemas",
      "tools/conformance/adapter-protocol/*.schema.json",
      "tools/conformance/certification/certified-projects.json",
    ],
    { cwd: ROOT, maxBuffer: 16 * 1024 * 1024 }
  );
  const authority = stdout
    .split("\0")
    .filter(Boolean)
    .map((file) => path.join(ROOT, file));
  return {
    authority,
    packets,
    plans,
    catalogs,
    profiles,
    controls,
    fixtures,
    registers,
  };
};

export const computeSourceVerifierDigests = async (
  packetPaths: readonly string[]
): Promise<Omit<VerifierDigests, "harness">> => {
  const {
    authority,
    packets,
    plans,
    catalogs,
    profiles,
    controls,
    fixtures,
    registers,
  } = await collectSourceVerifierInputs(packetPaths);
  return {
    packet: await digestWorkspaceInputs(packets),
    plans: await digestWorkspaceInputs(plans),
    catalogs: await digestWorkspaceInputs(catalogs),
    fixtures: await digestWorkspaceInputs(fixtures),
    profiles: await digestWorkspaceInputs(profiles),
    controls: await digestWorkspaceInputs(controls),
    verifierAuthority: await digestVerifierAuthority(
      [
        ...authority,
        ...packets,
        ...plans,
        ...catalogs,
        ...profiles,
        ...controls,
        ...fixtures,
      ],
      registers
    ),
  };
};

export const computeVerifierDigests = async (
  packetPaths: readonly string[]
): Promise<VerifierDigests> => {
  const harness = [
    ...(await filesUnder(path.join(ROOT, "tools/conformance"))).filter((file) =>
      HARNESS_FILE.test(file)
    ),
    ...(await filesUnder(path.join(ROOT, "tools/scripts"))).filter((file) =>
      HARNESS_FILE.test(file)
    ),
    path.join(ROOT, "package.json"),
    path.join(ROOT, "bun.lock"),
    path.join(ROOT, "tsconfig.base.json"),
    path.join(ROOT, "tsconfig.json"),
    ...(await filesUnder(path.join(ROOT, "typescript"))),
  ];
  return {
    harness: createHash("sha256")
      .update(await digestWorkspaceInputs(harness))
      .update(await nodeModulesDigest())
      .update(await readFile(process.execPath))
      .digest("hex"),
    ...(await computeSourceVerifierDigests(packetPaths)),
  };
};

export const typescriptImplementationInputs = async (
  storage: AdapterManifest["storage"]
): Promise<string[]> => {
  const files = [
    ...(await filesUnder(path.join(ROOT, "typescript"), true)),
    path.join(ROOT, "bun.lock"),
  ];
  let backend: string | undefined;
  if (storage === "sqlite-directory") {
    backend = "sqlite";
  } else if (storage === "postgres-database") {
    backend = "postgres";
  }
  if (backend !== undefined) {
    const artifact = path.join(
      ROOT,
      "typescript/kernel/backends",
      backend,
      "dist/index.js"
    );
    if (!files.includes(artifact)) {
      throw new Error(`missing built ${backend} backend artifact: ${artifact}`);
    }
  }
  return files;
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
    return createHash("sha256")
      .update(
        await digestWorkspaceInputs(
          await typescriptImplementationInputs(manifest.storage)
        )
      )
      .update(await nodeModulesDigest())
      .digest("hex");
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

export const computeSourceCertificateDigests = async (
  manifest: AdapterManifest,
  manifestPath: string
): Promise<SourceCertificateDigests> => ({
  ...(await computeSourceVerifierDigests(manifest.authorityPackets)),
  adapterManifest: await digestAdapterManifest(manifestPath),
});
