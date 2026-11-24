/**
 * Copyright 2026 Oscar Yáñez Cisterna (@SkrOYC)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import type { KernelRecord } from "@tuvren/core";
import type { RuntimeBackend } from "@tuvren/kernel-protocol";

import {
  decorateTransactions,
  readErrorCode,
} from "./kernel-mutant-backend.js";
import type {
  KernelMutantActivate,
  KernelMutantCodec,
  KernelMutantDefinition,
  KernelMutantKernel,
} from "./kernel-mutant-types.js";

const CBOR_UNSIGNED_ONE_BYTE_HEAD = 0x18;
const CBOR_SMALLEST_ONE_BYTE_ARGUMENT = 24;

// Accepts exactly one noncanonical encoding: a top-level unsigned integer
// whose one-byte argument head carries a value that fits in the initial byte.
const minimizeUnsignedHead = (bytes: Uint8Array): Uint8Array | undefined => {
  const [head, value] = bytes;
  return head === CBOR_UNSIGNED_ONE_BYTE_HEAD &&
    value !== undefined &&
    value < CBOR_SMALLEST_ONE_BYTE_ARGUMENT
    ? Uint8Array.of(value, ...bytes.subarray(2))
    : undefined;
};

const acceptNoncanonicalCbor = (
  codec: KernelMutantCodec,
  activate: KernelMutantActivate
): KernelMutantCodec => ({
  ...codec,
  decodeDeterministicKernelRecord(bytes): KernelRecord {
    try {
      return codec.decodeDeterministicKernelRecord(bytes);
    } catch (error: unknown) {
      const minimal = minimizeUnsignedHead(bytes);
      if (minimal === undefined) {
        throw error;
      }
      const decoded = codec.decodeDeterministicKernelRecord(minimal);
      activate();
      return decoded;
    }
  },
});

type DecodeDeviation =
  | "duplicate-map-key"
  | "float32-value"
  | "float64-value"
  | "indefinite-length-array"
  | "indefinite-length-byte-string"
  | "indefinite-length-map"
  | "indefinite-length-text-string"
  | "non-minimal-integer-head"
  | "non-minimal-length-head"
  | "tagged-value"
  | "trailing-bytes"
  | "unsafe-integer"
  | "unsorted-map-keys";

const CBOR_BREAK_BYTE = 0xff;
const CBOR_NULL_BYTE = 0xf6;
const CBOR_UINT64_ARGUMENT_HEAD = 0x1b;
const CBOR_NEGINT64_ARGUMENT_HEAD = 0x3b;
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const TRUNCATED_PAD_LIMIT = 8;
const CBOR_ARGUMENT_WIDTHS = [1, 2, 4, 8] as const;
const CBOR_MINIMAL_ARGUMENT = [24n, 0x100n, 0x10000n, 0x100000000n] as const;

class LenientReject extends Error {}

interface CborHead {
  readonly arg?: bigint;
  readonly argStart: number;
  readonly end: number;
  readonly indefinite: boolean;
  readonly info: number;
  readonly major: number;
  readonly nonMinimal: boolean;
}

const readHeadArgument = (
  bytes: Uint8Array,
  start: number,
  width: number
): bigint => {
  if (start + width > bytes.length) {
    throw new LenientReject();
  }
  let value = 0n;
  for (let index = 0; index < width; index += 1) {
    value = (value << 8n) | BigInt(bytes[start + index] ?? 0);
  }
  return value;
};

const readHead = (bytes: Uint8Array, start: number): CborHead => {
  const initial = bytes[start];
  if (initial === undefined) {
    throw new LenientReject();
  }
  const major = initial >> 5;
  const info = initial & 0x1f;
  if (info < 24) {
    return {
      arg: BigInt(info),
      argStart: start + 1,
      end: start + 1,
      indefinite: false,
      info,
      major,
      nonMinimal: false,
    };
  }
  if (info <= 27) {
    const index = info - 24;
    const width = CBOR_ARGUMENT_WIDTHS[index] ?? 8;
    const arg = readHeadArgument(bytes, start + 1, width);
    return {
      arg,
      argStart: start + 1,
      end: start + 1 + width,
      indefinite: false,
      info,
      major,
      nonMinimal: major !== 7 && arg < (CBOR_MINIMAL_ARGUMENT[index] ?? 0n),
    };
  }
  if (info === 31 && major >= 2 && major <= 5) {
    return {
      argStart: start + 1,
      end: start + 1,
      indefinite: true,
      info,
      major,
      nonMinimal: false,
    };
  }
  throw new LenientReject();
};

const pushBigEndian = (
  out: number[],
  value: bigint,
  width: number
): void => {
  for (let index = width - 1; index >= 0; index -= 1) {
    out.push(Number((value >> BigInt(index * 8)) & 0xffn));
  }
};

const emitHead = (out: number[], major: number, arg: bigint): void => {
  const base = major << 5;
  if (arg < 24n) {
    out.push(base | Number(arg));
  } else if (arg <= 0xffn) {
    out.push(base | 24, Number(arg));
  } else if (arg <= 0xffffn) {
    out.push(base | 25);
    pushBigEndian(out, arg, 2);
  } else if (arg <= 0xffffffffn) {
    out.push(base | 26);
    pushBigEndian(out, arg, 4);
  } else {
    out.push(base | 27);
    pushBigEndian(out, arg, 8);
  }
};

const compareCanonicalBytes = (
  left: readonly number[],
  right: readonly number[]
): number => {
  const shared = Math.min(left.length, right.length);
  for (let index = 0; index < shared; index += 1) {
    const delta = (left[index] ?? 0) - (right[index] ?? 0);
    if (delta !== 0) {
      return delta < 0 ? -1 : 1;
    }
  }
  if (left.length === right.length) {
    return 0;
  }
  return left.length < right.length ? -1 : 1;
};

const bytesKey = (bytes: readonly number[]): string =>
  bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("");

// Rewrites one top-level CBOR item into its canonical byte form in `out`,
// recording every canonical deviation it had to repair, and returns the
// position after the item. Throws LenientReject when the input cannot be
// re-encoded canonically (unsupported majors, non-integral floats, or a
// premature end of input).
const canonItem = (
  bytes: Uint8Array,
  start: number,
  out: number[],
  deviations: Set<DecodeDeviation>
): number => {
  const head = readHead(bytes, start);
  if (head.nonMinimal) {
    deviations.add(
      head.major >= 2 && head.major <= 5
        ? "non-minimal-length-head"
        : "non-minimal-integer-head"
    );
  }
  switch (head.major) {
    case 0:
    case 1: {
      const arg = head.arg ?? 0n;
      if (arg > MAX_SAFE_BIGINT) {
        deviations.add("unsafe-integer");
      }
      emitHead(out, head.major, arg);
      return head.end;
    }
    case 2:
    case 3: {
      if (!head.indefinite) {
        const end = head.end + Number(head.arg ?? 0n);
        if (end > bytes.length) {
          throw new LenientReject();
        }
        emitHead(out, head.major, head.arg ?? 0n);
        out.push(...bytes.subarray(head.end, end));
        return end;
      }
      deviations.add(
        head.major === 2
          ? "indefinite-length-byte-string"
          : "indefinite-length-text-string"
      );
      const content: number[] = [];
      let cursor = head.end;
      for (;;) {
        const marker = bytes[cursor];
        if (marker === undefined) {
          throw new LenientReject();
        }
        if (marker === CBOR_BREAK_BYTE) {
          break;
        }
        const chunk = readHead(bytes, cursor);
        if (chunk.major !== head.major || chunk.indefinite) {
          throw new LenientReject();
        }
        if (chunk.nonMinimal) {
          deviations.add("non-minimal-length-head");
        }
        const chunkEnd = chunk.end + Number(chunk.arg ?? 0n);
        if (chunkEnd > bytes.length) {
          throw new LenientReject();
        }
        content.push(...bytes.subarray(chunk.end, chunkEnd));
        cursor = chunkEnd;
      }
      emitHead(out, head.major, BigInt(content.length));
      out.push(...content);
      return cursor + 1;
    }
    case 4: {
      const items: number[][] = [];
      let cursor = head.end;
      if (head.indefinite) {
        deviations.add("indefinite-length-array");
        for (;;) {
          const marker = bytes[cursor];
          if (marker === undefined) {
            throw new LenientReject();
          }
          if (marker === CBOR_BREAK_BYTE) {
            cursor += 1;
            break;
          }
          const item: number[] = [];
          cursor = canonItem(bytes, cursor, item, deviations);
          items.push(item);
        }
      } else {
        for (
          let remaining = head.arg ?? 0n;
          remaining > 0n;
          remaining -= 1n
        ) {
          const item: number[] = [];
          cursor = canonItem(bytes, cursor, item, deviations);
          items.push(item);
        }
      }
      emitHead(out, head.major, BigInt(items.length));
      for (const item of items) {
        out.push(...item);
      }
      return cursor;
    }
    case 5: {
      const entries: { key: number[]; value: number[] }[] = [];
      let cursor = head.end;
      const readEntry = (): void => {
        const key: number[] = [];
        cursor = canonItem(bytes, cursor, key, deviations);
        const value: number[] = [];
        cursor = canonItem(bytes, cursor, value, deviations);
        entries.push({ key, value });
      };
      if (head.indefinite) {
        deviations.add("indefinite-length-map");
        for (;;) {
          const marker = bytes[cursor];
          if (marker === undefined) {
            throw new LenientReject();
          }
          if (marker === CBOR_BREAK_BYTE) {
            cursor += 1;
            break;
          }
          readEntry();
        }
      } else {
        for (
          let remaining = head.arg ?? 0n;
          remaining > 0n;
          remaining -= 1n
        ) {
          readEntry();
        }
      }
      for (let index = 1; index < entries.length; index += 1) {
        const order = compareCanonicalBytes(
          entries[index - 1]?.key ?? [],
          entries[index]?.key ?? []
        );
        if (order === 0) {
          deviations.add("duplicate-map-key");
        } else if (order > 0) {
          deviations.add("unsorted-map-keys");
        }
      }
      const deduplicated = new Map<
        string,
        { key: number[]; value: number[] }
      >();
      for (const entry of entries) {
        deduplicated.set(bytesKey(entry.key), entry);
      }
      const sorted = [...deduplicated.values()].sort((left, right) =>
        compareCanonicalBytes(left.key, right.key)
      );
      emitHead(out, head.major, BigInt(sorted.length));
      for (const entry of sorted) {
        out.push(...entry.key, ...entry.value);
      }
      return cursor;
    }
    case 6: {
      deviations.add("tagged-value");
      return canonItem(bytes, head.end, out, deviations);
    }
    default: {
      if (head.indefinite || head.info === 25) {
        throw new LenientReject();
      }
      if (head.info === 26 || head.info === 27) {
        deviations.add(head.info === 26 ? "float32-value" : "float64-value");
        const view = new DataView(
          bytes.buffer,
          bytes.byteOffset + head.argStart,
          head.end - head.argStart
        );
        const value =
          head.info === 26 ? view.getFloat32(0) : view.getFloat64(0);
        if (!Number.isSafeInteger(value)) {
          throw new LenientReject();
        }
        emitHead(out, value < 0 ? 1 : 0, BigInt(value < 0 ? -1 - value : value));
        return head.end;
      }
      out.push(...bytes.subarray(start, head.end));
      return head.end;
    }
  }
};

// Produces the canonical encoding of the first top-level item and the set of
// deviations the input carried. Trailing bytes after that item count as a
// deviation and are dropped from the rewrite.
const canonicalizeLenient = (
  bytes: Uint8Array
): { bytes: Uint8Array; deviations: Set<DecodeDeviation> } => {
  const deviations = new Set<DecodeDeviation>();
  const out: number[] = [];
  const end = canonItem(bytes, 0, out, deviations);
  if (end < bytes.length) {
    deviations.add("trailing-bytes");
  }
  return { bytes: Uint8Array.from(out), deviations };
};

// Accepts a noncanonical encoding only when the input's entire deviation set
// is exactly the named rule; the leniently canonicalized bytes go back through
// the reference decoder so the returned record is the canonical one.
const acceptDeviation =
  (
    deviation: DecodeDeviation
  ): ((
    codec: KernelMutantCodec,
    activate: KernelMutantActivate
  ) => KernelMutantCodec) =>
  (codec, activate) => ({
    ...codec,
    decodeDeterministicKernelRecord(bytes): KernelRecord {
      try {
        return codec.decodeDeterministicKernelRecord(bytes);
      } catch (error: unknown) {
        let canonical: ReturnType<typeof canonicalizeLenient>;
        try {
          canonical = canonicalizeLenient(bytes);
        } catch {
          throw error;
        }
        if (
          canonical.deviations.size !== 1 ||
          !canonical.deviations.has(deviation)
        ) {
          throw error;
        }
        let decoded: KernelRecord;
        try {
          decoded = codec.decodeDeterministicKernelRecord(canonical.bytes);
        } catch {
          throw error;
        }
        activate();
        return decoded;
      }
    },
  });

// Accepts a truncated stream by appending CBOR null bytes until the reference
// decoder completes a value; anything still incomplete after the pad bound
// keeps the reference rejection.
const acceptTruncatedInput = (
  codec: KernelMutantCodec,
  activate: KernelMutantActivate
): KernelMutantCodec => ({
  ...codec,
  decodeDeterministicKernelRecord(bytes): KernelRecord {
    try {
      return codec.decodeDeterministicKernelRecord(bytes);
    } catch (error: unknown) {
      for (let count = 1; count <= TRUNCATED_PAD_LIMIT; count += 1) {
        const padded = new Uint8Array(bytes.length + count);
        padded.set(bytes);
        padded.fill(CBOR_NULL_BYTE, bytes.length);
        try {
          const decoded = codec.decodeDeterministicKernelRecord(padded);
          activate();
          return decoded;
        } catch {
          // The value still does not complete at this padding length.
        }
      }
      throw error;
    }
  },
});

const unsafeIntegerArgument = (
  bytes: Uint8Array,
  head: number
): bigint | undefined => {
  if (bytes[0] !== head || bytes.length !== 9) {
    return undefined;
  }
  const arg = readHeadArgument(bytes, 1, 8);
  return arg > MAX_SAFE_BIGINT ? arg : undefined;
};

// Accepts a top-level 64-bit integer whose argument exceeds the JS
// safe-integer range by clamping it to the nearest safe bound, the way a
// decoder that silently saturates out-of-range integers would.
const acceptUnsafeIntegerHead =
  (
    negative: boolean
  ): ((
    codec: KernelMutantCodec,
    activate: KernelMutantActivate
  ) => KernelMutantCodec) =>
  (codec, activate) => ({
    ...codec,
    decodeDeterministicKernelRecord(bytes): KernelRecord {
      try {
        return codec.decodeDeterministicKernelRecord(bytes);
      } catch (error: unknown) {
        if (
          unsafeIntegerArgument(
            bytes,
            negative ? CBOR_NEGINT64_ARGUMENT_HEAD : CBOR_UINT64_ARGUMENT_HEAD
          ) === undefined
        ) {
          throw error;
        }
        activate();
        return negative ? Number.MIN_SAFE_INTEGER : Number.MAX_SAFE_INTEGER;
      }
    },
  });

const CANONICAL_CONTROL_MAP = Uint8Array.of(0xa1, 0x61, 0x61, 0x01);

const sameBytes = (left: Uint8Array, right: Uint8Array): boolean =>
  left.length === right.length &&
  left.every((value, index) => value === right[index]);

// Decodes the canonical single-entry map {"a": 1} into a record that drops
// its entry, the way a decoder that loses map entries during decode would.
const dropCanonicalMapEntry = (
  codec: KernelMutantCodec,
  activate: KernelMutantActivate
): KernelMutantCodec => ({
  ...codec,
  decodeDeterministicKernelRecord(bytes): KernelRecord {
    if (sameBytes(bytes, CANONICAL_CONTROL_MAP)) {
      activate();
      return {};
    }
    return codec.decodeDeterministicKernelRecord(bytes);
  },
});

const wrongOpaqueObjectHash = (
  codec: KernelMutantCodec,
  activate: KernelMutantActivate
): KernelMutantCodec => ({
  ...codec,
  async hashOpaqueObjectBytes(bytes) {
    activate();
    return await codec.hashOpaqueObjectBytes(Uint8Array.of(...bytes, 0));
  },
});

const noncanonicalChangedPathsOrder = (
  kernel: KernelMutantKernel,
  activate: KernelMutantActivate
): KernelMutantKernel => ({
  ...kernel,
  tree: {
    ...kernel.tree,
    async diff(treeHashA, treeHashB) {
      const changedPaths = await kernel.tree.diff(treeHashA, treeHashB);
      if (changedPaths.length < 2) {
        return changedPaths;
      }
      activate();
      return changedPaths.toReversed();
    },
  },
});

const dropUncommittedStagedResultOnRecovery = (
  kernel: KernelMutantKernel,
  activate: KernelMutantActivate
): KernelMutantKernel => ({
  ...kernel,
  run: {
    ...kernel.run,
    async recover(runId) {
      const recovery = await kernel.run.recover(runId);
      if (recovery.uncommittedStagedResults.length === 0) {
        return recovery;
      }
      activate();
      return {
        ...recovery,
        uncommittedStagedResults: recovery.uncommittedStagedResults.slice(
          0,
          -1
        ),
      };
    },
  },
});

// Corrupts only the observable roundtrip: schema.register stores the real
// record, and the wrapped schema.get hands it back with an altered schemaId,
// the way a read-back path that rewrites the record's identity field would.
// Registration and the backend-internal schema reads stay untouched.
const corruptSchemaRoundtrip = (
  kernel: KernelMutantKernel,
  activate: KernelMutantActivate
): KernelMutantKernel => ({
  ...kernel,
  schema: {
    ...kernel.schema,
    async get(schemaId) {
      const schema = await kernel.schema.get(schemaId);
      if (schema === null) {
        return schema;
      }
      activate();
      return { ...schema, schemaId: `${schema.schemaId}-mutant` };
    },
  },
});

const LEASE_HORIZON_MS = Number.MAX_SAFE_INTEGER;

// Corrupt the expiry listing at the transaction seam: shared-lease-clock
// backends clamp the caller's nowMs to their own transaction clock inside
// runtime-kernel-runs listExpired, so a kernel-facade wrap cannot reach them.
// On shared-lease-clock backends the listing seam is the operative corruption
// because the retained kernel-seam preemptExpired retry is clamped to the
// transaction clock in runtime-kernel-runs.
const leaseTakeoverBeforeExpiry = (
  backend: RuntimeBackend,
  activate: KernelMutantActivate
): RuntimeBackend =>
  decorateTransactions(backend, (tx) => ({
    ...tx,
    runs: {
      ...tx.runs,
      async listExpired(nowMs) {
        const requested = await tx.runs.listExpired(nowMs);
        const horizon = await tx.runs.listExpired(LEASE_HORIZON_MS);
        if (horizon.length > requested.length) {
          activate();
        }
        return horizon;
      },
    },
  }));

const leaseTakeoverBeforeExpiryKernel = (
  kernel: KernelMutantKernel,
  activate: KernelMutantActivate
): KernelMutantKernel => ({
  ...kernel,
  runLiveness: {
    ...kernel.runLiveness,
    async preemptExpired(runId, preemptingOwnerId, nowMs, reason) {
      try {
        return await kernel.runLiveness.preemptExpired(
          runId,
          preemptingOwnerId,
          nowMs,
          reason
        );
      } catch (error: unknown) {
        if (readErrorCode(error) !== "kernel_runtime_run_lease_not_expired") {
          throw error;
        }
        const preempted = await kernel.runLiveness.preemptExpired(
          runId,
          preemptingOwnerId,
          LEASE_HORIZON_MS,
          reason
        );
        activate();
        return preempted;
      }
    },
  },
});

const FENCING_FAILURES = new Set([
  "run_lease_owner_mismatch",
  "run_lease_token_mismatch",
]);

// Fencing is not enforced: a superseded owner or token renews by borrowing
// the current owner/token pair from storage.
const acceptStaleOwnerAfterTakeover = (
  kernel: KernelMutantKernel,
  backend: RuntimeBackend,
  activate: KernelMutantActivate
): KernelMutantKernel => ({
  ...kernel,
  runLiveness: {
    ...kernel.runLiveness,
    async renewLease(
      runId,
      executionOwnerId,
      fencingToken,
      nextLeaseExpiresAtMs
    ) {
      try {
        return await kernel.runLiveness.renewLease(
          runId,
          executionOwnerId,
          fencingToken,
          nextLeaseExpiresAtMs
        );
      } catch (error: unknown) {
        const stored = FENCING_FAILURES.has(readErrorCode(error) ?? "")
          ? await backend.transact(async (tx) => await tx.runs.get(runId))
          : null;
        if (
          stored?.executionOwnerId === undefined ||
          stored.fencingToken === undefined
        ) {
          throw error;
        }
        activate();
        return await kernel.runLiveness.renewLease(
          runId,
          stored.executionOwnerId,
          stored.fencingToken,
          nextLeaseExpiresAtMs
        );
      }
    },
  },
});

export const PROTOCOL_KERNEL_MUTANTS: readonly KernelMutantDefinition[] = [
  {
    createSeams: () => ({ codec: acceptDeviation("duplicate-map-key") }),
    kind: "implementation",
    mutantId: "kernel.accept-duplicate-map-key",
    signal: "mutant.accept-duplicate-map-key.entered",
  },
  {
    createSeams: () => ({ codec: acceptDeviation("float64-value") }),
    kind: "implementation",
    mutantId: "kernel.accept-float64-value",
    signal: "mutant.accept-float64-value.entered",
  },
  {
    createSeams: () => ({
      codec: acceptDeviation("indefinite-length-array"),
    }),
    kind: "implementation",
    mutantId: "kernel.accept-indefinite-length-array",
    signal: "mutant.accept-indefinite-length-array.entered",
  },
  {
    createSeams: () => ({ codec: acceptDeviation("indefinite-length-map") }),
    kind: "implementation",
    mutantId: "kernel.accept-indefinite-length-map",
    signal: "mutant.accept-indefinite-length-map.entered",
  },
  {
    createSeams: () => ({
      codec: acceptDeviation("indefinite-length-text-string"),
    }),
    kind: "implementation",
    mutantId: "kernel.accept-indefinite-length-text-string",
    signal: "mutant.accept-indefinite-length-text-string.entered",
  },
  {
    createSeams: () => ({
      codec: acceptDeviation("non-minimal-length-head"),
    }),
    kind: "implementation",
    mutantId: "kernel.accept-non-minimal-length-head",
    signal: "mutant.accept-non-minimal-length-head.entered",
  },
  {
    createSeams: () => ({ codec: acceptNoncanonicalCbor }),
    kind: "implementation",
    mutantId: "kernel.accept-noncanonical-cbor",
    signal: "mutant.accept-noncanonical-cbor.entered",
  },
  {
    createSeams: () => ({ kernel: acceptStaleOwnerAfterTakeover }),
    kind: "implementation",
    mutantId: "kernel.accept-stale-owner-after-takeover",
    signal: "mutant.accept-stale-owner-after-takeover.entered",
  },
  {
    createSeams: () => ({ codec: acceptDeviation("tagged-value") }),
    kind: "implementation",
    mutantId: "kernel.accept-tagged-value",
    signal: "mutant.accept-tagged-value.entered",
  },
  {
    createSeams: () => ({ codec: acceptDeviation("trailing-bytes") }),
    kind: "implementation",
    mutantId: "kernel.accept-trailing-bytes",
    signal: "mutant.accept-trailing-bytes.entered",
  },
  {
    createSeams: () => ({ codec: acceptTruncatedInput }),
    kind: "implementation",
    mutantId: "kernel.accept-truncated-input",
    signal: "mutant.accept-truncated-input.entered",
  },
  {
    createSeams: () => ({ codec: acceptUnsafeIntegerHead(true) }),
    kind: "implementation",
    mutantId: "kernel.accept-unsafe-negint",
    signal: "mutant.accept-unsafe-negint.entered",
  },
  {
    createSeams: () => ({ codec: acceptUnsafeIntegerHead(false) }),
    kind: "implementation",
    mutantId: "kernel.accept-unsafe-uint",
    signal: "mutant.accept-unsafe-uint.entered",
  },
  {
    createSeams: () => ({ codec: acceptDeviation("unsorted-map-keys") }),
    kind: "implementation",
    mutantId: "kernel.accept-unsorted-map-keys",
    signal: "mutant.accept-unsorted-map-keys.entered",
  },
  {
    createSeams: () => ({
      kernel: (kernel, _backend, activate) =>
        corruptSchemaRoundtrip(kernel, activate),
    }),
    kind: "implementation",
    mutantId: "kernel.corrupt-schema-roundtrip",
    signal: "mutant.corrupt-schema-roundtrip.entered",
  },
  {
    createSeams: () => ({
      kernel: (kernel, _backend, activate) =>
        dropUncommittedStagedResultOnRecovery(kernel, activate),
    }),
    kind: "implementation",
    mutantId: "kernel.drop-uncommitted-staged-result-on-recovery",
    signal: "mutant.drop-uncommitted-staged-result-on-recovery.entered",
  },
  {
    createSeams: () => ({
      backend: (backend, _context, activate) =>
        leaseTakeoverBeforeExpiry(backend, activate),
      kernel: (kernel, _backend, activate) =>
        leaseTakeoverBeforeExpiryKernel(kernel, activate),
    }),
    kind: "implementation",
    mutantId: "kernel.lease-takeover-before-expiry",
    signal: "mutant.lease-takeover-before-expiry.entered",
  },
  {
    createSeams: () => ({
      kernel: (kernel, _backend, activate) =>
        noncanonicalChangedPathsOrder(kernel, activate),
    }),
    kind: "implementation",
    mutantId: "kernel.noncanonical-changed-paths-order",
    signal: "mutant.noncanonical-changed-paths-order.entered",
  },
  {
    createSeams: () => ({ codec: dropCanonicalMapEntry }),
    kind: "implementation",
    mutantId: "kernel.drop-canonical-map-entry",
    signal: "mutant.drop-canonical-map-entry.entered",
  },
  {
    createSeams: () => ({
      codec: wrongOpaqueObjectHash,
      kernel: (kernel, _backend, activate) => ({
        ...kernel,
        store: {
          ...kernel.store,
          async put(bytes, mediaType) {
            activate();
            return await kernel.store.put(
              Uint8Array.of(...bytes, 0),
              mediaType
            );
          },
        },
      }),
    }),
    kind: "implementation",
    mutantId: "kernel.wrong-opaque-object-hash",
    signal: "mutant.wrong-opaque-object-hash.entered",
  },
];
