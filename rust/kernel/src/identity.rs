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

use sha2::{Digest, Sha256};

use crate::cbor::encode_deterministic_kernel_record;
use crate::types::{
    HashString, KernelRecord, KernelResult, PathValue, StagedResult, StagedResultStatus, TurnNode,
    TurnTreeManifest,
};

pub fn hash_bytes_to_hex(bytes: &[u8]) -> HashString {
    hex::encode(Sha256::digest(bytes))
}

pub fn hash_kernel_record(record: &KernelRecord) -> KernelResult<HashString> {
    Ok(hash_bytes_to_hex(&encode_deterministic_kernel_record(
        record,
    )?))
}

pub fn hash_turn_tree_identity(
    schema_id: &str,
    manifest: &TurnTreeManifest,
) -> KernelResult<HashString> {
    let mut record = BTreeMap::new();
    record.insert(
        "manifest".to_string(),
        KernelRecord::Map(
            manifest
                .iter()
                .map(|(path, value)| (path.clone(), path_value_to_record(value)))
                .collect(),
        ),
    );
    record.insert(
        "schemaId".to_string(),
        KernelRecord::Text(schema_id.to_string()),
    );
    hash_kernel_record(&KernelRecord::Map(record))
}

pub fn hash_turn_node_identity(node: &TurnNode) -> KernelResult<HashString> {
    let mut record = BTreeMap::new();
    record.insert(
        "consumedStagedResults".to_string(),
        KernelRecord::Array(
            node.consumed_staged_results
                .iter()
                .map(staged_result_to_record)
                .collect(),
        ),
    );
    record.insert(
        "eventHash".to_string(),
        optional_text_record(node.event_hash.as_ref()),
    );
    record.insert(
        "previousTurnNodeHash".to_string(),
        optional_text_record(node.previous_turn_node_hash.as_ref()),
    );
    record.insert(
        "schemaId".to_string(),
        KernelRecord::Text(node.schema_id.clone()),
    );
    record.insert(
        "turnTreeHash".to_string(),
        KernelRecord::Text(node.turn_tree_hash.clone()),
    );
    hash_kernel_record(&KernelRecord::Map(record))
}

pub fn schema_to_record(schema: &crate::types::TurnTreeSchema) -> KernelRecord {
    let paths = schema
        .paths
        .iter()
        .map(|path| {
            let mut record = BTreeMap::new();
            record.insert(
                "collection".to_string(),
                KernelRecord::Text(
                    match path.collection {
                        crate::types::PathCollectionKind::Ordered => "ordered",
                        crate::types::PathCollectionKind::Single => "single",
                    }
                    .to_string(),
                ),
            );
            if let Some(metadata) = &path.metadata {
                record.insert("metadata".to_string(), metadata.clone());
            }
            record.insert("path".to_string(), KernelRecord::Text(path.path.clone()));
            KernelRecord::Map(record)
        })
        .collect();
    let rules = schema
        .incorporation_rules
        .iter()
        .map(|rule| {
            let mut record = BTreeMap::new();
            record.insert(
                "objectType".to_string(),
                KernelRecord::Text(rule.object_type.clone()),
            );
            record.insert(
                "targetPath".to_string(),
                KernelRecord::Text(rule.target_path.clone()),
            );
            KernelRecord::Map(record)
        })
        .collect();
    let mut record = BTreeMap::new();
    record.insert("incorporationRules".to_string(), KernelRecord::Array(rules));
    record.insert("paths".to_string(), KernelRecord::Array(paths));
    record.insert(
        "schemaId".to_string(),
        KernelRecord::Text(schema.schema_id.clone()),
    );
    KernelRecord::Map(record)
}

fn path_value_to_record(value: &PathValue) -> KernelRecord {
    match value {
        PathValue::Ordered(values) => KernelRecord::Array(
            values
                .iter()
                .map(|value| KernelRecord::Text(value.clone()))
                .collect(),
        ),
        PathValue::Single(value) => KernelRecord::Text(value.clone()),
        PathValue::Null => KernelRecord::Null,
    }
}

fn staged_result_to_record(staged_result: &StagedResult) -> KernelRecord {
    let mut record = BTreeMap::new();
    record.insert(
        "objectHash".to_string(),
        KernelRecord::Text(staged_result.object_hash.clone()),
    );
    record.insert(
        "objectType".to_string(),
        KernelRecord::Text(staged_result.object_type.clone()),
    );
    record.insert(
        "status".to_string(),
        KernelRecord::Text(
            match staged_result.status {
                StagedResultStatus::Completed => "completed",
                StagedResultStatus::Failed => "failed",
                StagedResultStatus::Interrupted => "interrupted",
            }
            .to_string(),
        ),
    );
    record.insert(
        "taskId".to_string(),
        KernelRecord::Text(staged_result.task_id.clone()),
    );
    record.insert(
        "timestamp".to_string(),
        KernelRecord::Integer(staged_result.timestamp_ms),
    );

    if let Some(interrupt_payload) = &staged_result.interrupt_payload {
        record.insert("interruptPayload".to_string(), interrupt_payload.clone());
    }

    KernelRecord::Map(record)
}

fn optional_text_record(value: Option<&String>) -> KernelRecord {
    value.map_or(KernelRecord::Null, |value| {
        KernelRecord::Text(value.clone())
    })
}
