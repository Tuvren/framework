// Copyright 2026 Oscar Yáñez Cisterna (@SkrOYC)
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

use std::collections::BTreeMap;
use std::io::Cursor;

use ciborium::value::{Integer, Value};
use serde_json::Value as JsonValue;

use crate::types::{KernelError, KernelRecord, KernelResult};

const MIN_SAFE_KERNEL_INTEGER: i64 = -9_007_199_254_740_991;
const MAX_SAFE_KERNEL_INTEGER: i64 = 9_007_199_254_740_991;

pub fn encode_deterministic_kernel_record(record: &KernelRecord) -> KernelResult<Vec<u8>> {
    let value = to_cbor_value(record)?;
    let mut bytes = Vec::new();
    ciborium::ser::into_writer(&value, &mut bytes).map_err(|error| {
        KernelError::new(
            "kernel_record_encode_failed",
            format!("failed to encode deterministic kernel record: {error}"),
            None,
        )
    })?;
    Ok(bytes)
}

pub fn decode_deterministic_kernel_record(bytes: &[u8]) -> KernelResult<KernelRecord> {
    let value: Value = ciborium::de::from_reader(Cursor::new(bytes)).map_err(|error| {
        KernelError::new(
            "invalid_decoded_kernel_record",
            format!("decoded kernel record bytes must contain valid CBOR: {error}"),
            None,
        )
    })?;
    let record = from_cbor_value(value)?;
    let canonical = encode_deterministic_kernel_record(&record)?;

    // Reject permissive CBOR decodes here; identity bytes are a protocol
    // contract, so callers must supply the canonical form they intend to hash.
    if canonical != bytes {
        return Err(KernelError::new(
            "non_canonical_kernel_record_encoding",
            "decoded kernel record must already use canonical deterministic CBOR",
            None,
        ));
    }

    Ok(record)
}

pub fn kernel_record_from_json(value: &JsonValue) -> KernelResult<KernelRecord> {
    match value {
        JsonValue::Null => Ok(KernelRecord::Null),
        JsonValue::Bool(value) => Ok(KernelRecord::Bool(*value)),
        JsonValue::Number(value) => {
            let integer = value.as_i64().ok_or_else(|| {
                KernelError::new(
                    "invalid_json_kernel_record_number",
                    "kernel record JSON numbers must be signed integers",
                    None,
                )
            })?;
            validate_kernel_integer(integer)?;
            Ok(KernelRecord::Integer(integer))
        }
        JsonValue::String(value) => Ok(KernelRecord::Text(value.clone())),
        JsonValue::Array(values) => values
            .iter()
            .map(kernel_record_from_json)
            .collect::<KernelResult<Vec<_>>>()
            .map(KernelRecord::Array),
        JsonValue::Object(values) => values
            .iter()
            .map(|(key, value)| Ok((key.clone(), kernel_record_from_json(value)?)))
            .collect::<KernelResult<BTreeMap<_, _>>>()
            .map(KernelRecord::Map),
    }
}

fn to_cbor_value(record: &KernelRecord) -> KernelResult<Value> {
    match record {
        KernelRecord::Null => Ok(Value::Null),
        KernelRecord::Bool(value) => Ok(Value::Bool(*value)),
        KernelRecord::Integer(value) => {
            validate_kernel_integer(*value)?;
            Ok(Value::Integer(Integer::from(*value)))
        }
        KernelRecord::Text(value) => Ok(Value::Text(value.clone())),
        KernelRecord::Bytes(value) => Ok(Value::Bytes(value.clone())),
        KernelRecord::Array(values) => values
            .iter()
            .map(to_cbor_value)
            .collect::<KernelResult<Vec<_>>>()
            .map(Value::Array),
        KernelRecord::Map(values) => {
            let mut entries = values
                .iter()
                .map(|(key, value)| {
                    let key_value = Value::Text(key.clone());
                    let key_bytes = encode_cbor_value(&key_value)?;
                    Ok((key_bytes, key_value, to_cbor_value(value)?))
                })
                .collect::<KernelResult<Vec<_>>>()?;
            // Canonical ordering is by encoded key bytes, not Rust's string
            // ordering. Keep this explicit so identity hashes stay portable.
            entries.sort_by(|left, right| left.0.cmp(&right.0));
            Ok(Value::Map(
                entries
                    .into_iter()
                    .map(|(_, key, value)| (key, value))
                    .collect(),
            ))
        }
    }
}

fn encode_cbor_value(value: &Value) -> KernelResult<Vec<u8>> {
    let mut bytes = Vec::new();
    ciborium::ser::into_writer(value, &mut bytes).map_err(|error| {
        KernelError::new(
            "kernel_record_key_encode_failed",
            format!("failed to encode deterministic kernel record key: {error}"),
            None,
        )
    })?;
    Ok(bytes)
}

fn from_cbor_value(value: Value) -> KernelResult<KernelRecord> {
    match value {
        Value::Null => Ok(KernelRecord::Null),
        Value::Bool(value) => Ok(KernelRecord::Bool(value)),
        Value::Integer(value) => {
            let integer = i64::try_from(value).map_err(|_| {
                KernelError::new(
                    "invalid_kernel_record_integer",
                    "kernel record integers must fit in signed 64-bit range",
                    None,
                )
            })?;
            validate_kernel_integer(integer)?;
            Ok(KernelRecord::Integer(integer))
        }
        Value::Text(value) => Ok(KernelRecord::Text(value)),
        Value::Bytes(value) => Ok(KernelRecord::Bytes(value)),
        Value::Array(values) => values
            .into_iter()
            .map(from_cbor_value)
            .collect::<KernelResult<Vec<_>>>()
            .map(KernelRecord::Array),
        Value::Map(entries) => {
            let mut values = BTreeMap::new();

            for (key, value) in entries {
                let Value::Text(key) = key else {
                    return Err(KernelError::new(
                        "invalid_kernel_record_map_key",
                        "kernel record map keys must be text strings",
                        None,
                    ));
                };
                values.insert(key, from_cbor_value(value)?);
            }

            Ok(KernelRecord::Map(values))
        }
        Value::Float(_) | Value::Tag(_, _) => Err(KernelError::new(
            "invalid_kernel_record_value",
            "kernel records must not use CBOR floats or tags",
            None,
        )),
        _ => Err(KernelError::new(
            "unsupported_kernel_record_value",
            "kernel record contains an unsupported CBOR value",
            None,
        )),
    }
}

fn validate_kernel_integer(value: i64) -> KernelResult<()> {
    if (MIN_SAFE_KERNEL_INTEGER..=MAX_SAFE_KERNEL_INTEGER).contains(&value) {
        Ok(())
    } else {
        Err(KernelError::new(
            "invalid_kernel_record_integer",
            "kernel record integers must be JavaScript-safe integers",
            None,
        ))
    }
}
