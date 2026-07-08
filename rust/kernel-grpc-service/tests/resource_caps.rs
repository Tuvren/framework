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

//! KRT-BK006: behavioral proof that `serve_kernel_grpc`'s message-decode-size
//! ceiling is real and active.
//!
//! Unlike `interop_smoke.rs`'s `spawn_kernel_server` helper (which has its
//! own `Server::builder()` chain and therefore would not exercise this
//! change at all), these tests call `serve_kernel_grpc` itself so the
//! caps configured on its builder chain are actually under test.
//!
//! Scope note (see ticket report): only the decode-size ceiling (Gherkin
//! scenario 2) is exercised here with a real running server and client. The
//! per-RPC timeout and per-connection concurrency limit (Gherkin scenario 3)
//! are not exercised behaviorally in this suite:
//!
//! * tonic's `GrpcTimeout` layer takes `min(client-supplied grpc-timeout
//!   header, server-configured timeout)`, and is present on every tonic
//!   server unconditionally (with `server_timeout: None` when unconfigured).
//!   A test that sets a short client-side timeout would trip regardless of
//!   whether `serve_kernel_grpc` configures `.timeout(..)` at all, so it
//!   would prove nothing about this change.
//! * Proving the server-side 30s ceiling (or the 64 concurrency ceiling)
//!   fires would require an RPC handler that can be made to hang or hold a
//!   concurrency slot on demand. No such test seam exists in
//!   `InMemoryKernel` today, and every handler in this crate completes
//!   near-instantly, so there is no way to observe either ceiling firing
//!   without either waiting out a real 30-second timeout in this suite or
//!   adding a new artificial-delay seam to the kernel — both judged out of
//!   scope for this ticket. `.timeout(..)` and
//!   `.concurrency_limit_per_connection(..)` are confirmed present on the
//!   builder chain in `src/lib.rs` and are real `tonic::transport::Server`
//!   builder methods in the pinned tonic 0.14.5 (verified against
//!   `tonic-0.14.5/src/transport/server/mod.rs`), so this is a documented
//!   test gap, not a silent omission.

use tuvren_kernel_rust::InMemoryKernel;
use tuvren_kernel_rust_grpc_service::proto;

/// tonic 0.14.5's own default decode ceiling when no
/// `max_decoding_message_size` is configured (see
/// `tonic-0.14.5/src/codec/mod.rs::DEFAULT_MAX_RECV_MESSAGE_SIZE`). A test
/// payload between this value and the 16 MiB ceiling this ticket configures
/// proves the ceiling was actually raised, rather than merely proving some
/// (possibly unrelated) limit rejected an oversized message.
const TONIC_DEFAULT_MAX_RECV_MESSAGE_SIZE_BYTES: usize = 4 * 1024 * 1024;
const CONFIGURED_MAX_DECODE_MESSAGE_SIZE_BYTES: usize = 16 * 1024 * 1024;

#[tokio::test]
async fn accepts_a_payload_larger_than_tonics_default_ceiling_but_within_the_configured_one() {
    let (endpoint, server_handle) = spawn_server_via_serve_kernel_grpc().await;
    let mut store_client =
        proto::kernel_store_service_client::KernelStoreServiceClient::connect(endpoint)
            .await
            .expect("store client connects");

    // 8 MiB: past tonic's unconfigured 4 MiB default, comfortably inside the
    // 16 MiB ceiling `serve_kernel_grpc` configures.
    let blob = vec![7u8; 8 * 1024 * 1024];
    assert!(blob.len() > TONIC_DEFAULT_MAX_RECV_MESSAGE_SIZE_BYTES);
    assert!(blob.len() < CONFIGURED_MAX_DECODE_MESSAGE_SIZE_BYTES);

    let response = store_client
        .store_put(proto::StorePutRequest {
            blob,
            media_type: Some("application/octet-stream".to_string()),
        })
        .await
        .expect("a payload within the configured decode ceiling is accepted");
    assert!(!response.into_inner().object_hash.is_empty());

    server_handle.abort();
}

#[tokio::test]
async fn rejects_a_payload_larger_than_the_configured_decode_ceiling() {
    let (endpoint, server_handle) = spawn_server_via_serve_kernel_grpc().await;
    let mut store_client =
        proto::kernel_store_service_client::KernelStoreServiceClient::connect(endpoint)
            .await
            .expect("store client connects");

    // 20 MiB: past the 16 MiB ceiling `serve_kernel_grpc` configures.
    let blob = vec![9u8; 20 * 1024 * 1024];
    assert!(blob.len() > CONFIGURED_MAX_DECODE_MESSAGE_SIZE_BYTES);

    let error = store_client
        .store_put(proto::StorePutRequest {
            blob,
            media_type: Some("application/octet-stream".to_string()),
        })
        .await
        .expect_err("a payload past the configured decode ceiling is rejected");

    // tonic's decode-size guard rejects with `Status::out_of_range` (see
    // `tonic-0.14.5/src/codec/decode.rs`), not `resource_exhausted` as the
    // ticket's Gherkin prose says — asserting the real code tonic emits
    // rather than the Gherkin's approximate language.
    assert_eq!(error.code(), tonic::Code::OutOfRange);

    server_handle.abort();
}

async fn spawn_server_via_serve_kernel_grpc() -> (String, tokio::task::JoinHandle<()>) {
    // Reserve an ephemeral port via a throwaway listener, then hand the
    // resolved address to `serve_kernel_grpc` itself (rather than
    // duplicating its builder chain, as `interop_smoke.rs`'s
    // `spawn_kernel_server` does) so this test actually exercises the caps
    // configured on that function's `Server::builder()` chain. There is a
    // narrow window between dropping this listener and `serve_kernel_grpc`
    // binding the same address; on loopback in test/CI this is not
    // observed to race in practice, and `serve_kernel_grpc`'s signature
    // (`SocketAddr`, not a pre-bound listener) is intentionally left
    // unchanged per the ticket's scope guidance.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind ephemeral test port");
    let address = listener.local_addr().expect("read listener address");
    drop(listener);

    let handle = tokio::spawn(async move {
        tuvren_kernel_rust_grpc_service::serve_kernel_grpc(address, InMemoryKernel::new())
            .await
            .expect("test gRPC server runs");
    });

    // serve_kernel_grpc's own bind happens asynchronously after this task is
    // spawned; retry the first connection briefly rather than assuming the
    // listener is already up.
    let endpoint = format!("http://{address}");
    for attempt in 0..50 {
        match tonic::transport::Endpoint::from_shared(endpoint.clone())
            .expect("valid endpoint")
            .connect()
            .await
        {
            Ok(_) => break,
            Err(_) if attempt < 49 => {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
            Err(error) => panic!("server never became ready: {error}"),
        }
    }

    (endpoint, handle)
}
