use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{Value, json};
use tuvren_kernel_rust::{
    KernelRecord, decode_deterministic_kernel_record, encode_deterministic_kernel_record,
    hash_bytes_to_hex, hash_kernel_record, kernel_record_from_json,
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
        Value::Object(fields) if tagged && fields.contains_key("$bytes") => {
            KernelRecord::Bytes(bytes(value))
        }
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
        46,
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
    }
    assert_eq!(
        total,
        Coverage {
            digests: 110,
            cbor_hex: 74,
            cbor_bytes: 37,
            decoder_cases: 28,
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
        assert_eq!(read_json(&root.join("fixtures").join(name)), original);
    }
}
