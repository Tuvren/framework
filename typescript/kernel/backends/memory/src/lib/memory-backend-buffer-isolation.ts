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

// Buffer ownership for the in-memory backend (ADR-0074). The deterministic
// CBOR decoder (`cbor-x`) attaches a `dataView` own property to the buffer it
// decodes, so every buffer a decoder or an identity validator reads must be
// detached from its owner first: on the way in, the caller still owns the
// record the repository write is validating; on the way through, the committed
// state owns the stored record an internal lineage or turn-tree helper decodes.
// Only the buffer identity is isolated here — bytes are never re-encoded — so
// content addressing and every stored encoding stay exactly as they were.
import type { KernelRecord } from "@tuvren/core";
import { decodeDeterministicKernelRecord } from "@tuvren/kernel-protocol";

/**
 * Copies `bytes` into a fresh buffer, so a decoder that decorates the buffer it
 * reads (the `dataView` marker `cbor-x` attaches) cannot reach the original.
 */
export function isolateBytes(bytes: Uint8Array): Uint8Array {
  return Uint8Array.from(bytes);
}

/**
 * Returns a record whose `Uint8Array` fields are fresh copies and whose other
 * fields are carried over unchanged.
 *
 * Every record the caller hands to a repository write goes through a protocol
 * assertion or identity validator that decodes the record's CBOR fields in
 * place. Isolating the byte fields first keeps that decode off the caller's
 * buffers while leaving the record otherwise identical, so validation still
 * sees the caller's real shape — including keys the writer will reject.
 *
 * A value that is not already a plain data object (the only shape the protocol
 * assertions accept) is returned untouched, so the assertion reports its own
 * error instead of one describing a copy.
 */
export function isolateRecordBuffers(record: unknown): unknown {
  if (!isDataRecord(record)) {
    return record;
  }

  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [
      key,
      value instanceof Uint8Array ? isolateBytes(value) : value,
    ])
  );
}

/**
 * Decodes canonical deterministic CBOR from a detached copy of `bytes`.
 *
 * Internal lineage and turn-tree helpers decode the stored records of the
 * committed and draft state; decoding through a copy keeps the `dataView`
 * marker off the stored bytes, so a stored record never carries decoder
 * metadata a read would have to explain away.
 */
export function decodeDetachedKernelRecord(bytes: Uint8Array): KernelRecord {
  return decodeDeterministicKernelRecord(isolateBytes(bytes));
}

/**
 * True when `record` has the shape the protocol's `assertPlainObject` accepts:
 * a non-array object with an `Object.prototype` or `null` prototype, no own
 * symbol keys, and only enumerable own data properties.
 */
function isDataRecord(record: unknown): record is Record<string, unknown> {
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    return false;
  }

  const prototype: unknown = Object.getPrototypeOf(record);

  if (prototype !== Object.prototype && prototype !== null) {
    return false;
  }

  if (Object.getOwnPropertySymbols(record).length > 0) {
    return false;
  }

  for (const descriptor of Object.values(
    Object.getOwnPropertyDescriptors(record)
  )) {
    if (!(descriptor.enumerable && Object.hasOwn(descriptor, "value"))) {
      return false;
    }
  }

  return true;
}
