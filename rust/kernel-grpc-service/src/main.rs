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

use std::net::SocketAddr;

use tuvren_kernel_rust::InMemoryKernel;
use tuvren_kernel_rust_grpc_service::serve_kernel_grpc;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Keep the baseline runnable without inventing a configuration contract;
    // the formal TS transport client and runtime switch arrive in Epic V.
    let address = std::env::var("TUVREN_KERNEL_GRPC_ADDR")
        .unwrap_or_else(|_| "127.0.0.1:50051".to_string())
        .parse::<SocketAddr>()?;

    serve_kernel_grpc(address, InMemoryKernel::new()).await?;
    Ok(())
}
