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

pub mod cbor;
pub mod identity;
pub mod memory;
pub mod telemetry;
pub mod types;

pub use cbor::{
    decode_deterministic_kernel_record, encode_deterministic_kernel_record, kernel_record_from_json,
};
pub use identity::{
    hash_bytes_to_hex, hash_kernel_record, hash_turn_node_identity, schema_to_record,
};
pub use memory::{
    BackendCapability, InMemoryKernel, InMemoryKernelOptions, StoredThreadEntry, ThreadListOptions,
    ThreadListResult,
};
pub use types::*;
