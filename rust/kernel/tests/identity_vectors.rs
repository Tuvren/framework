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

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{Value, json};
use tuvren_kernel_rust::identity::hash_turn_tree_identity;
use tuvren_kernel_rust::{
    KernelRecord, PathValue, StagedResult, StagedResultStatus, TurnNode,
    decode_deterministic_kernel_record, encode_deterministic_kernel_record, hash_bytes_to_hex,
    hash_kernel_record, hash_turn_node_identity, kernel_record_from_json,
};

fn kernel_authority() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../spec/conformance/kernel")
}

fn read_json(path: &Path) -> Value {
    serde_json::from_slice(&fs::read(path).expect("authority file is readable"))
        .unwrap_or_else(|error| panic!("{}: {error}", path.display()))
}

#[derive(Debug, Default, PartialEq)]
struct Coverage {
    digests: usize,
    cbor_hex: usize,
    cbor_bytes: usize,
    decoder_cases: usize,
    node_identities: usize,
    tree_identities: usize,
}

fn bytes(value: &Value) -> Vec<u8> {
    if let Some(values) = value.as_array() {
        values
            .iter()
            .map(|value| {
                u8::try_from(value.as_u64().expect("unsigned byte")).expect("byte fits u8")
            })
            .collect()
    } else {
        assert_eq!(value.as_object().expect("byte wrapper").len(), 1);
        hex::decode(value["$bytes"].as_str().expect("hex bytes")).expect("valid hex bytes")
    }
}

fn record(value: &Value, tagged: bool) -> KernelRecord {
    match value {
        Value::Object(fields) if fields.contains_key("$bytes") => KernelRecord::Bytes(bytes(value)),
        Value::Object(fields) if tagged && fields.contains_key("$map") => {
            assert_eq!(fields.len(), 1, "exact map wrapper");
            let mut map = BTreeMap::new();
            for entry in fields["$map"].as_array().expect("map entries") {
                let pair = entry.as_array().expect("map entry");
                assert_eq!(pair.len(), 2);
                let key = pair[0].as_str().expect("text map key").to_owned();
                assert!(
                    map.insert(key, record(&pair[1], tagged)).is_none(),
                    "unique map keys"
                );
            }
            KernelRecord::Map(map)
        }
        Value::Object(fields) => KernelRecord::Map(
            fields
                .iter()
                .map(|(key, value)| (key.clone(), record(value, tagged)))
                .collect(),
        ),
        Value::Array(values) => {
            KernelRecord::Array(values.iter().map(|value| record(value, tagged)).collect())
        }
        _ => kernel_record_from_json(value).expect("kernel scalar"),
    }
}

fn project(value: &KernelRecord, projection: &Value) -> KernelRecord {
    let KernelRecord::Map(source) = value else {
        panic!("identity source is a map")
    };
    let optional = projection["optionalFields"].as_array();
    let mut result = BTreeMap::new();
    for field in projection["fields"].as_array().expect("projection fields") {
        let name = field.as_str().expect("field name");
        let Some(value) = source.get(name) else {
            assert!(
                optional.is_some_and(|fields| fields.contains(field)),
                "missing required identity field {name}"
            );
            continue;
        };
        let value = if name == "consumedStagedResults" {
            let KernelRecord::Array(values) = value else {
                panic!("staged results are an array")
            };
            KernelRecord::Array(
                values
                    .iter()
                    .map(|value| project(value, &projection["stagedResultProjection"]))
                    .collect(),
            )
        } else {
            value.clone()
        };
        result.insert(name.to_owned(), value);
    }
    KernelRecord::Map(result)
}

fn node(value: &Value, tagged: bool) -> TurnNode {
    TurnNode {
        consumed_staged_results: value["consumedStagedResults"]
            .as_array()
            .expect("staged results")
            .iter()
            .map(|value| StagedResult {
                interrupt_payload: value
                    .get("interruptPayload")
                    .map(|value| record(value, tagged)),
                object_hash: value["objectHash"]
                    .as_str()
                    .expect("object hash")
                    .to_owned(),
                object_type: value["objectType"]
                    .as_str()
                    .expect("object type")
                    .to_owned(),
                status: match value["status"].as_str().expect("status") {
                    "completed" => StagedResultStatus::Completed,
                    "failed" => StagedResultStatus::Failed,
                    "interrupted" => StagedResultStatus::Interrupted,
                    status => panic!("unknown staged result status {status}"),
                },
                task_id: value["taskId"].as_str().expect("task ID").to_owned(),
                timestamp_ms: value["timestamp"].as_i64().expect("timestamp"),
            })
            .collect(),
        created_at_ms: 0,
        event_hash: value["eventHash"].as_str().map(str::to_owned),
        hash: value["hash"].as_str().unwrap_or("").to_owned(),
        previous_turn_node_hash: value["previousTurnNodeHash"].as_str().map(str::to_owned),
        schema_id: value["schemaId"].as_str().expect("schema ID").to_owned(),
        turn_tree_hash: value["turnTreeHash"]
            .as_str()
            .expect("tree hash")
            .to_owned(),
    }
}

fn manifest(value: &Value, tagged: bool) -> BTreeMap<String, PathValue> {
    let KernelRecord::Map(fields) = record(value, tagged) else {
        panic!("manifest is a map")
    };
    fields
        .into_iter()
        .map(|(key, value)| {
            let value = match value {
                KernelRecord::Null => PathValue::Null,
                KernelRecord::Text(value) => PathValue::Single(value),
                KernelRecord::Array(values) => PathValue::Ordered(
                    values
                        .into_iter()
                        .map(|value| {
                            let KernelRecord::Text(value) = value else {
                                panic!("ordered path contains hashes")
                            };
                            value
                        })
                        .collect(),
                ),
                _ => panic!("invalid path value"),
            };
            (key, value)
        })
        .collect()
}

fn validate_recipes(recipes: &Value) {
    let profile = json!({
        "encoding": "deterministic-cbor",
        "mapKeyOrder": "unsigned-bytewise-lexicographic-deterministic-cbor-encoded-text-keys",
        "integerEncoding": "major-type-0-for-n>=0; major-type-1-with-argument=-1-n-for-n<0; shortest-argument-width; no-floats",
        "lengthEncoding": "shortest-definite-length; text-length-is-utf8-byte-count; map-length-is-entry-count",
        "integerDomain": [-9007199254740991_i64, 9007199254740991_i64],
        "textEncoding": "utf-8-without-normalization",
        "bytesEncoding": "untagged-major-type-2",
        "arrayOrder": "preserve", "tags": false, "negativeZero": false,
        "argumentEncoding": "0..23-inline; 24..255-uint8; 256..65535-uint16; 65536..4294967295-uint32; larger-uint64; big-endian"
    });
    let mut types = BTreeSet::new();
    for recipe in recipes["recipes"].as_array().expect("identity recipes") {
        let kind = recipe["recordType"].as_str().expect("recipe type");
        assert!(types.insert(kind), "unique recipe type");
        assert_eq!(recipe["hash"], "sha256");
        if kind == "opaque-object" {
            assert_eq!(recipe["projection"], json!({"source": "bytes"}));
            assert_eq!(recipe["cborProfile"], json!({"encoding": "raw-bytes"}));
        } else {
            assert_eq!(
                recipe["cborProfile"], profile,
                "unsupported CBOR profile for {kind}"
            );
        }
    }
    assert_eq!(
        types,
        BTreeSet::from(["opaque-object", "schema", "turn-node", "turn-tree"])
    );
}

fn equal_hex(field: &str, actual: &str, expected: &Value) -> Result<(), String> {
    let expected = expected
        .as_str()
        .ok_or_else(|| format!("missing {field}"))?;
    if actual != expected {
        return Err(format!("{field}: committed={expected}; Rust={actual}"));
    }
    Ok(())
}

fn verify_fixture(fixture: &Value, recipes: &Value) -> Result<Coverage, String> {
    let tagged = fixture.get("input").is_some();
    let (input, expected) = if tagged {
        (&fixture["input"], &fixture["expected"])
    } else {
        (fixture, fixture)
    };
    let mut coverage = Coverage::default();
    let mut checked = BTreeSet::new();
    for (field, kind) in [
        ("rawOpaqueBytes", "opaque-object"),
        ("turnNodeIdentityRecord", "turn-node"),
        ("turnTreeIdentityRecord", "turn-tree"),
        ("turnTreeSchemaRecord", "schema"),
    ] {
        let Some(value) = input.get(field) else {
            continue;
        };
        let recipe = recipes["recipes"]
            .as_array()
            .expect("recipes")
            .iter()
            .find(|recipe| recipe["recordType"] == kind)
            .expect("recipe exists");
        let (encoded, digest) = if kind == "opaque-object" {
            let encoded = bytes(value);
            let digest = hash_bytes_to_hex(&encoded);
            (encoded, digest)
        } else {
            let projected = project(&record(value, tagged), &recipe["projection"]);
            let encoded = encode_deterministic_kernel_record(&projected)
                .map_err(|error| format!("{field}: {error}"))?;
            let digest =
                hash_kernel_record(&projected).map_err(|error| format!("{field}: {error}"))?;
            assert_eq!(hash_bytes_to_hex(&encoded), digest);
            let key = format!("{field}CborHex");
            equal_hex(&key, &hex::encode(&encoded), &expected[&key])?;
            checked.insert(key);
            coverage.cbor_hex += 1;
            if tagged {
                let key = format!("{field}CborBytes");
                equal_hex(&key, &hex::encode(&encoded), &expected[&key]["$bytes"])?;
                assert_eq!(bytes(&expected[&key]), encoded);
                checked.insert(key);
                coverage.cbor_bytes += 1;
            }
            (encoded, digest)
        };
        let key = format!("{field}Sha256Hex");
        equal_hex(&key, &digest, &expected[&key])?;
        let native_digest = match kind {
            "turn-node" => {
                coverage.node_identities += 1;
                Some(hash_turn_node_identity(&node(value, tagged)))
            }
            "turn-tree" => {
                coverage.tree_identities += 1;
                Some(hash_turn_tree_identity(
                    value["schemaId"].as_str().expect("schema ID"),
                    &manifest(&value["manifest"], tagged),
                ))
            }
            _ => None,
        };
        if let Some(native_digest) = native_digest {
            let native_digest = native_digest.map_err(|error| format!("{field}: {error}"))?;
            equal_hex(&key, &native_digest, &expected[&key])?;
        }
        checked.insert(key);
        coverage.digests += 1;
        if kind != "opaque-object" {
            decode_deterministic_kernel_record(&encoded)
                .map_err(|error| format!("{field}: {error}"))?;
        }
    }
    for key in expected.as_object().expect("fixture expectations").keys() {
        if key.ends_with("Sha256Hex") || key.ends_with("CborHex") || key.ends_with("CborBytes") {
            assert!(
                checked.contains(key),
                "unhandled committed expectation {key}"
            );
        }
    }
    if let Some(cases) = input["cases"].as_object() {
        for (name, case) in cases {
            if let Some(value) = case.get("cborBytes") {
                let encoded = bytes(value);
                let decoded = decode_deterministic_kernel_record(&encoded);
                if name == "control-canonical-map" {
                    let canonical =
                        kernel_record_from_json(&json!({"a": 1})).expect("control record");
                    assert_eq!(decoded.expect("canonical control decodes"), canonical);
                    assert_eq!(
                        encode_deterministic_kernel_record(&canonical).expect("control encodes"),
                        encoded
                    );
                } else {
                    assert!(
                        decoded.is_err(),
                        "adversarial case {name} must be rejected; committed={}",
                        hex::encode(&encoded)
                    );
                }
                coverage.decoder_cases += 1;
            }
        }
    }
    if coverage.digests == 0 {
        for value in [input, expected] {
            let original = record(value, tagged);
            let encoded = encode_deterministic_kernel_record(&original)
                .expect("non-identity fixture encodes");
            assert_eq!(
                decode_deterministic_kernel_record(&encoded).expect("non-identity fixture decodes"),
                original
            );
        }
    }
    Ok(coverage)
}

#[test]
fn every_committed_vector_matches_the_rust_encoder_and_identity_recipes() {
    let root = kernel_authority();
    let recipes = read_json(&root.join("identity-recipes.json"));
    validate_recipes(&recipes);
    let mut paths = fs::read_dir(root.join("fixtures"))
        .expect("fixture directory is readable")
        .map(|entry| entry.expect("fixture entry is readable").path())
        .filter(|path| {
            path.extension()
                .is_some_and(|extension| extension == "json")
        })
        .collect::<Vec<_>>();
    paths.sort();
    assert_eq!(
        paths.len(),
        54,
        "all legacy and lossless fixtures are covered"
    );
    let mut total = Coverage::default();
    for path in paths {
        let coverage = verify_fixture(&read_json(&path), &recipes)
            .unwrap_or_else(|error| panic!("{}: {error}", path.display()));
        total.digests += coverage.digests;
        total.cbor_hex += coverage.cbor_hex;
        total.cbor_bytes += coverage.cbor_bytes;
        total.decoder_cases += coverage.decoder_cases;
        total.node_identities += coverage.node_identities;
        total.tree_identities += coverage.tree_identities;
    }
    assert_eq!(
        total,
        Coverage {
            digests: 120,
            cbor_hex: 84,
            cbor_bytes: 42,
            decoder_cases: 28,
            node_identities: 44,
            tree_identities: 4,
        }
    );
}

#[test]
fn altered_vector_is_rejected_without_changing_committed_files() {
    let root = kernel_authority();
    let recipes = read_json(&root.join("identity-recipes.json"));
    for name in [
        "kernel-protocol-deterministic.json",
        "kernel-protocol-deterministic.bytes.json",
    ] {
        let original = read_json(&root.join("fixtures").join(name));
        verify_fixture(&original, &recipes).expect("unmodified control passes");
        for field in [
            "rawOpaqueBytesSha256Hex",
            "turnNodeIdentityRecordCborHex",
            "turnTreeSchemaRecordSha256Hex",
        ] {
            let mut altered = original.clone();
            let expected = if altered.get("expected").is_some() {
                &mut altered["expected"]
            } else {
                &mut altered
            };
            let hex = expected[field].as_str().expect("committed hex");
            expected[field] = json!(format!(
                "{}{}",
                if hex.starts_with("00") { "01" } else { "00" },
                &hex[2..]
            ));
            let error = verify_fixture(&altered, &recipes).expect_err("corrupted vector must fail");
            assert!(error.contains(field), "{name}: {error}");
        }
        let mut altered = original.clone();
        let input = if altered.get("input").is_some() {
            &mut altered["input"]
        } else {
            &mut altered
        };
        input["turnNodeIdentityRecord"]["schemaId"] = json!("schema_altered");
        let error = verify_fixture(&altered, &recipes).expect_err("altered input must fail");
        assert!(
            error.contains("turnNodeIdentityRecordCborHex"),
            "{name}: {error}"
        );

        let mut altered_recipes = recipes.clone();
        let recipe = altered_recipes["recipes"]
            .as_array_mut()
            .expect("recipes")
            .iter_mut()
            .find(|recipe| recipe["recordType"] == "turn-node")
            .expect("node recipe");
        recipe["projection"]["fields"]
            .as_array_mut()
            .expect("projection fields")
            .retain(|field| field != "schemaId");
        let error = verify_fixture(&original, &altered_recipes)
            .expect_err("recipe dropping an identity field must fail");
        assert!(
            error.contains("turnNodeIdentityRecordCborHex"),
            "{name}: {error}"
        );
        assert_eq!(read_json(&root.join("fixtures").join(name)), original);
        assert_eq!(read_json(&root.join("identity-recipes.json")), recipes);
    }
}
