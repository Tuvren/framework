import type {
  ConformancePlanAssertion,
  ConformancePlanReference,
} from "../../plan-compiler/index.js";
import {
  computeIdentity,
  digestBytes,
  encodeIdentity,
  observationBytes,
} from "../kernel-integrity.js";
import { UnresolvedOperandError } from "./operand-error.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const relative = (value: unknown, path: string): unknown => {
  if (path === "$") {
    return value;
  }
  if (!path.startsWith("$.")) {
    throw new Error(`unsupported reference path ${path}`);
  }
  let current = value;
  for (const key of path.slice(2).split(".")) {
    if (Array.isArray(current)) {
      current = current[Number(key)];
    } else if (isRecord(current) && Object.hasOwn(current, key)) {
      current = current[key];
    } else {
      throw new UnresolvedOperandError(`unresolved reference path ${path}`);
    }
  }
  if (current === undefined) {
    throw new UnresolvedOperandError(`unresolved reference path ${path}`);
  }
  return current;
};
const referencesAt = (value: unknown, path: string): unknown[] => {
  const star = path.indexOf(".*");
  if (star === -1) {
    const resolved = relative(value, path);
    return Array.isArray(resolved) ? resolved : [resolved];
  }
  const collection = relative(value, path.slice(0, star));
  let entries: unknown[] | undefined;
  if (Array.isArray(collection)) {
    entries = collection;
  } else if (isRecord(collection)) {
    entries = Object.values(collection);
  }
  if (entries === undefined) {
    throw new Error(`reference wildcard requires a collection: ${path}`);
  }
  return entries.flatMap((entry: unknown) =>
    referencesAt(entry, `$${path.slice(star + 2)}`)
  );
};

const verifyReferences = (
  value: unknown,
  reference: ConformancePlanReference,
  resolve: (path: string) => unknown
): boolean => {
  const observed = resolve(reference.targetPath);
  const targets: unknown[] = Array.isArray(observed) ? observed : [observed];
  const byHash = new Map<string, unknown>();
  for (const target of targets) {
    const computed = computeIdentity(
      reference.recordType,
      relative(target, reference.valuePath ?? "$")
    );
    let hash: unknown = computed;
    if (reference.hashPath !== undefined) {
      hash = relative(target, reference.hashPath);
    } else if (isRecord(target) && Object.hasOwn(target, "hash")) {
      ({ hash } = target);
    }
    if (typeof hash !== "string" || byHash.has(hash)) {
      throw new Error("reference targets require unique hashes");
    }
    if (hash !== computed) {
      return false;
    }
    byHash.set(hash, target);
  }
  const hashes = referencesAt(value, reference.path);
  const collection =
    reference.path.includes(".*") ||
    Array.isArray(relative(value, reference.path));
  if (collection && reference.length === undefined) {
    throw new Error("reference collections require explicit length");
  }
  if (reference.length !== undefined) {
    const length =
      typeof reference.length === "string"
        ? resolve(reference.length)
        : reference.length;
    if (length !== hashes.length) {
      return false;
    }
  }
  for (const hash of hashes) {
    if (hash === null) {
      continue;
    }
    if (typeof hash !== "string") {
      throw new TypeError("reference must be a hash or null");
    }
    if (!byHash.has(hash)) {
      return false;
    }
  }
  return true;
};

export const evaluateIntegrity = (
  assertion: ConformancePlanAssertion,
  resolve: (path: string) => unknown
): boolean => {
  if (assertion.path === undefined) {
    throw new Error("integrity assertion requires path");
  }
  const value = resolve(assertion.path);
  if (assertion.kind === "referenceWalk") {
    if (
      assertion.references === undefined ||
      assertion.references.length === 0
    ) {
      throw new Error("referenceWalk requires declared references");
    }
    const outcomes = assertion.references.map((reference) =>
      verifyReferences(value, reference, resolve)
    );
    return outcomes.every(Boolean);
  }
  if (assertion.equalsPath === undefined) {
    throw new Error("integrity assertion requires equalsPath");
  }
  const expected = resolve(assertion.equalsPath);
  if (assertion.kind === "digest") {
    return digestBytes(value) === expected;
  }
  if (assertion.recordType === undefined) {
    throw new Error("integrity assertion requires recordType");
  }
  if (assertion.kind === "identity") {
    return computeIdentity(assertion.recordType, value) === expected;
  }
  if (assertion.kind === "canonicalCbor") {
    return (
      Buffer.compare(
        encodeIdentity(assertion.recordType, value),
        observationBytes(expected)
      ) === 0
    );
  }
  throw new Error(`unsupported integrity assertion ${assertion.kind}`);
};
