use std::collections::BTreeMap;
use std::fmt;

use serde::de::{self, MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Deserializer};
use serde_json::value::RawValue;
use serde_json::{Map, Value, json};
use tuvren_kernel_rust::KernelRecord;

use crate::{AdapterErrorEnvelope, adapter_error};

pub(crate) const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;
pub(crate) type EncodingResult<T> = Result<T, AdapterErrorEnvelope>;

pub(crate) fn invalid(message: &str) -> AdapterErrorEnvelope {
    adapter_error("adapter_invalid_encoding", message, None)
}

pub(crate) fn integer(value: i64) -> EncodingResult<Value> {
    if !(-MAX_SAFE_INTEGER..=MAX_SAFE_INTEGER).contains(&value) {
        return Err(invalid(
            "integer exceeds the observation safe-integer domain",
        ));
    }
    Ok(json!(value))
}

pub(crate) fn bytes(value: &[u8]) -> Value {
    json!({"$bytes": value.iter().map(|byte| format!("{byte:02x}")).collect::<String>()})
}

pub(crate) fn decode_bytes(value: &Value) -> EncodingResult<Vec<u8>> {
    let object = value
        .as_object()
        .ok_or_else(|| invalid("expected byte tag"))?;
    let text = object
        .get("$bytes")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("expected hexadecimal bytes"))?;
    if object.len() != 1
        || text.len() % 2 != 0
        || !text
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(invalid("invalid byte tag"));
    }
    text.as_bytes()
        .chunks_exact(2)
        .map(|pair| {
            let digit = |b: u8| if b <= b'9' { b - b'0' } else { b - b'a' + 10 };
            Ok(digit(pair[0]) * 16 + digit(pair[1]))
        })
        .collect()
}

pub(crate) fn encode_record(value: &KernelRecord) -> EncodingResult<Value> {
    Ok(match value {
        KernelRecord::Null => Value::Null,
        KernelRecord::Bool(v) => json!(v),
        KernelRecord::Integer(v) => integer(*v)?,
        KernelRecord::Text(v) => json!(v),
        KernelRecord::Bytes(v) => bytes(v),
        KernelRecord::Array(v) => {
            Value::Array(v.iter().map(encode_record).collect::<EncodingResult<_>>()?)
        }
        KernelRecord::Map(v) => {
            json!({"$map": v.iter().map(|(k,v)| Ok(json!([k,encode_record(v)?]))).collect::<EncodingResult<Vec<_>>>()?})
        }
    })
}

pub(crate) fn decode_record(value: &Value) -> EncodingResult<KernelRecord> {
    Ok(match value {
        Value::Null => KernelRecord::Null,
        Value::Bool(v) => KernelRecord::Bool(*v),
        Value::String(v) => KernelRecord::Text(v.clone()),
        Value::Number(v) => {
            let v = v
                .as_i64()
                .ok_or_else(|| invalid("expected safe integer without negative zero"))?;
            integer(v)?;
            KernelRecord::Integer(v)
        }
        Value::Array(v) => {
            KernelRecord::Array(v.iter().map(decode_record).collect::<EncodingResult<_>>()?)
        }
        Value::Object(v) => {
            if v.contains_key("$bytes") {
                return decode_bytes(value).map(KernelRecord::Bytes);
            }
            let mut entries = BTreeMap::new();
            if let Some(tag) = v.get("$map") {
                if v.len() != 1 {
                    return Err(invalid("map tag cannot contain extra fields"));
                }
                for entry in tag
                    .as_array()
                    .ok_or_else(|| invalid("expected map entries"))?
                {
                    let pair = entry
                        .as_array()
                        .filter(|pair| pair.len() == 2)
                        .ok_or_else(|| invalid("expected map key/value pair"))?;
                    let key = pair[0]
                        .as_str()
                        .ok_or_else(|| invalid("map keys must be text"))?;
                    if entries
                        .insert(key.into(), decode_record(&pair[1])?)
                        .is_some()
                    {
                        return Err(invalid("duplicate map key"));
                    }
                }
            } else {
                for (key, value) in v {
                    entries.insert(key.clone(), decode_record(value)?);
                }
            }
            KernelRecord::Map(entries)
        }
    })
}

pub(crate) fn parse_frame(text: &str) -> Result<Value, serde_json::Error> {
    serde_json::from_str::<UniqueValue>(text).map(|value| value.0)
}

struct UniqueValue(Value);
impl<'de> Deserialize<'de> for UniqueValue {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = Box::<RawValue>::deserialize(deserializer)?;
        let text = raw.get();
        match text.as_bytes()[0] {
            b'{' | b'[' => serde::Deserializer::deserialize_any(
                &mut serde_json::Deserializer::from_str(text),
                UniqueVisitor,
            )
            .map_err(de::Error::custom),
            b'-' | b'0'..=b'9' => parse_integer_token(text)
                .map(UniqueValue)
                .map_err(|e| de::Error::custom(e.message)),
            _ => serde_json::from_str(text)
                .map(UniqueValue)
                .map_err(de::Error::custom),
        }
    }
}

fn parse_integer_token(text: &str) -> EncodingResult<Value> {
    let negative = text.starts_with('-');
    let unsigned = text.trim_start_matches('-');
    let (mantissa, exponent) = unsigned.split_once(['e', 'E']).unwrap_or((unsigned, "0"));
    let fractional_digits = mantissa
        .split_once('.')
        .map_or(0, |(_, fraction)| fraction.len());
    let digits = mantissa.replace('.', "");
    let digits = digits.trim_start_matches('0');
    if digits.is_empty() {
        return if negative {
            Err(invalid("negative zero is not a kernel integer"))
        } else {
            integer(0)
        };
    }
    let significant = digits.trim_end_matches('0');
    let trailing_zeros = digits.len() - significant.len();
    let scale = exponent
        .parse::<i64>()
        .ok()
        .and_then(|exponent| exponent.checked_sub(i64::try_from(fractional_digits).ok()?))
        .and_then(|exponent| exponent.checked_add(i64::try_from(trailing_zeros).ok()?))
        .filter(|scale| *scale >= 0)
        .and_then(|scale| usize::try_from(scale).ok())
        .filter(|scale| significant.len().saturating_add(*scale) <= 16)
        .ok_or_else(|| invalid("expected a safe integer"))?;
    let scale = u32::try_from(scale).map_err(|_| invalid("invalid integer scale"))?;
    let magnitude = significant
        .parse::<i64>()
        .map_err(|_| invalid("invalid integer"))?
        * 10_i64.pow(scale);
    integer(if negative { -magnitude } else { magnitude })
}
struct UniqueVisitor;
impl<'de> Visitor<'de> for UniqueVisitor {
    type Value = UniqueValue;
    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("lossless JSON without duplicate object keys")
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
        let mut entries = Vec::new();
        while let Some(value) = seq.next_element::<UniqueValue>()? {
            entries.push(value.0);
        }
        Ok(UniqueValue(Value::Array(entries)))
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
        let mut entries = Map::new();
        while let Some(key) = map.next_key::<String>()? {
            if entries.contains_key(&key) {
                return Err(de::Error::custom("duplicate JSON object key"));
            }
            entries.insert(key, map.next_value::<UniqueValue>()?.0);
        }
        Ok(UniqueValue(Value::Object(entries)))
    }
}
