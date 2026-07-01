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

fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Cargo owns Rust codegen for Epic U; Buf remains the lint/breaking
    // authority for the checked-in proto surface.
    let proto_root = "../../boundaries/kernel/interop/grpc/proto";
    let proto_files = [
        format!("{proto_root}/tuvren/kernel/interop/v1/kernel_types.proto"),
        format!("{proto_root}/tuvren/kernel/interop/v1/kernel_services.proto"),
    ];
    let include_roots = [proto_root.to_string()];
    tonic_prost_build::configure().compile_protos(&proto_files, &include_roots)?;
    Ok(())
}
