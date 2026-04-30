use prost::Message;
use tokio_stream::StreamExt;
use tokio_stream::wrappers::TcpListenerStream;
use tonic::Request;
use tonic::transport::Server;
use tuvren_kernel_rust::{
    InMemoryKernel, IncorporationRule as RustIncorporationRule,
    PathCollectionKind as RustPathCollectionKind, PathDefinition as RustPathDefinition,
    StepDeclaration as RustStepDeclaration, TurnTreeSchema as RustTurnTreeSchema,
};
use tuvren_kernel_rust_grpc_service::KernelGrpcServiceImpl;
use tuvren_kernel_rust_grpc_service::proto::kernel_run_service_server::KernelRunService;
use tuvren_kernel_rust_grpc_service::proto::kernel_tree_service_server::KernelTreeService;
use tuvren_kernel_rust_grpc_service::proto::{
    self, IncorporationRule, PathCollectionKind, PathDefinition, RunCompletionStatus,
    SettledStagedResult, StagedResultStatus, StepDeclaration,
};

#[tokio::test]
async fn interop_smoke_exercises_unary_and_node_walk_back_stream() {
    let (endpoint, server_handle) = spawn_kernel_server().await;
    let mut schema_client =
        proto::kernel_schema_service_client::KernelSchemaServiceClient::connect(endpoint.clone())
            .await
            .expect("schema client connects");
    let mut thread_client =
        proto::kernel_thread_service_client::KernelThreadServiceClient::connect(endpoint.clone())
            .await
            .expect("thread client connects");
    let mut turn_client =
        proto::kernel_turn_service_client::KernelTurnServiceClient::connect(endpoint.clone())
            .await
            .expect("turn client connects");
    let mut run_client =
        proto::kernel_run_service_client::KernelRunServiceClient::connect(endpoint.clone())
            .await
            .expect("run client connects");
    let mut staging_client =
        proto::kernel_staging_service_client::KernelStagingServiceClient::connect(endpoint.clone())
            .await
            .expect("staging client connects");
    let mut node_client =
        proto::kernel_node_service_client::KernelNodeServiceClient::connect(endpoint)
            .await
            .expect("node client connects");
    let schema = proto::TurnTreeSchema {
        incorporation_rules: vec![IncorporationRule {
            object_type: "message".to_string(),
            target_path: "messages".to_string(),
        }],
        paths: vec![PathDefinition {
            collection: PathCollectionKind::Ordered as i32,
            metadata_cbor: None,
            path: "messages".to_string(),
        }],
        schema_id: "schema_main".to_string(),
    };
    schema_client
        .schema_register(proto::SchemaRegisterRequest {
            schema: Some(schema),
        })
        .await
        .expect("schema registers");
    let thread = thread_client
        .thread_create(proto::ThreadCreateRequest {
            initial_branch_id: "branch_main".to_string(),
            schema_id: "schema_main".to_string(),
            thread_id: "thread_main".to_string(),
        })
        .await
        .expect("thread creates")
        .into_inner()
        .result
        .expect("thread result");
    turn_client
        .turn_create(proto::TurnCreateRequest {
            branch_id: "branch_main".to_string(),
            parent_turn_id: None,
            start_turn_node_hash: thread.root_turn_node_hash.clone(),
            thread_id: "thread_main".to_string(),
            turn_id: "turn_main".to_string(),
        })
        .await
        .expect("turn creates");
    run_client
        .run_create(proto::RunCreateRequest {
            branch_id: "branch_main".to_string(),
            run_id: "run_main".to_string(),
            schema_id: "schema_main".to_string(),
            start_turn_node_hash: thread.root_turn_node_hash.clone(),
            steps: vec![StepDeclaration {
                deterministic: false,
                id: "model_call".to_string(),
                metadata_cbor: None,
                side_effects: false,
            }],
            turn_id: "turn_main".to_string(),
        })
        .await
        .expect("run creates");
    staging_client
        .staging_stage(proto::StagingStageRequest {
            blob: b"hello".to_vec(),
            object_type: "message".to_string(),
            outcome: Some(proto::staging_stage_request::Outcome::Settled(
                SettledStagedResult {
                    status: StagedResultStatus::Completed as i32,
                },
            )),
            run_id: "run_main".to_string(),
            task_id: "msg_assistant".to_string(),
        })
        .await
        .expect("stage succeeds");
    let completed = run_client
        .run_complete_step(proto::RunCompleteStepRequest {
            event_hash: None,
            observe_results: Vec::new(),
            run_id: "run_main".to_string(),
            step_id: "model_call".to_string(),
            tree_hash: None,
        })
        .await
        .expect("step completes")
        .into_inner();
    assert!(completed.checkpointed);
    let checkpoint_hash = completed.turn_node_hash.expect("checkpoint hash");
    run_client
        .run_complete(proto::RunCompleteRequest {
            event_hash: None,
            run_id: "run_main".to_string(),
            status: RunCompletionStatus::Completed as i32,
        })
        .await
        .expect("run completes");
    let mut stream = node_client
        .node_walk_back(proto::NodeWalkBackRequest {
            from_hash: checkpoint_hash,
        })
        .await
        .expect("walk stream starts")
        .into_inner();
    let first = stream
        .next()
        .await
        .expect("first stream item")
        .expect("stream is readable");
    assert_eq!(
        first.node.expect("node").previous_turn_node_hash.as_deref(),
        Some(thread.root_turn_node_hash.as_str())
    );
    let second = stream
        .next()
        .await
        .expect("second stream item")
        .expect("stream is readable");
    assert!(second.node.expect("node").previous_turn_node_hash.is_none());
    assert!(stream.next().await.is_none());

    server_handle.abort();
}

#[tokio::test]
async fn kernel_errors_include_stable_payload_details() {
    let (endpoint, server_handle) = spawn_kernel_server().await;
    let mut thread_client =
        proto::kernel_thread_service_client::KernelThreadServiceClient::connect(endpoint)
            .await
            .expect("thread client connects");
    let error = thread_client
        .thread_create(proto::ThreadCreateRequest {
            initial_branch_id: "branch_main".to_string(),
            schema_id: "missing_schema".to_string(),
            thread_id: "thread_main".to_string(),
        })
        .await
        .expect_err("missing schema should map to a status");

    assert_eq!(error.code(), tonic::Code::NotFound);
    let payload = proto::KernelErrorPayload::decode(error.details())
        .expect("status details decode as KernelErrorPayload");
    assert_eq!(payload.code, "schema_not_found");
    assert!(payload.message.contains("schema"));
    assert!(payload.details_cbor.is_none());

    server_handle.abort();
}

#[tokio::test]
async fn tree_create_rejects_duplicate_transport_paths() {
    let service = KernelGrpcServiceImpl::new(InMemoryKernel::new());
    let duplicate_entry = proto::PathValueEntry {
        path: "messages".to_string(),
        value: Some(proto::PathValue {
            value: Some(proto::path_value::Value::NullValue(proto::NullPathValue {})),
        }),
    };
    let error = service
        .tree_create(Request::new(proto::TreeCreateRequest {
            base_turn_tree_hash: None,
            changes: vec![duplicate_entry.clone(), duplicate_entry],
            schema_id: "schema_main".to_string(),
        }))
        .await
        .expect_err("duplicate transport paths are rejected");

    assert_eq!(error.code(), tonic::Code::InvalidArgument);
}

#[tokio::test]
async fn run_complete_step_rejects_invalid_annotation_cbor() {
    let service = KernelGrpcServiceImpl::new(InMemoryKernel::new());
    service
        .kernel()
        .schema_register(RustTurnTreeSchema {
            incorporation_rules: vec![RustIncorporationRule {
                object_type: "message".to_string(),
                target_path: "messages".to_string(),
            }],
            paths: vec![RustPathDefinition {
                collection: RustPathCollectionKind::Ordered,
                metadata: None,
                path: "messages".to_string(),
            }],
            schema_id: "schema_main".to_string(),
        })
        .expect("schema registers");
    let thread = service
        .kernel()
        .thread_create("thread_main", "schema_main", "branch_main")
        .expect("thread creates");
    service
        .kernel()
        .turn_create(
            "turn_main",
            "thread_main",
            "branch_main",
            None,
            &thread.root_turn_node_hash,
        )
        .expect("turn creates");
    service
        .kernel()
        .run_create(
            "run_main",
            "turn_main",
            "branch_main",
            "schema_main",
            &thread.root_turn_node_hash,
            vec![RustStepDeclaration {
                deterministic: false,
                id: "model_call".to_string(),
                metadata: None,
                side_effects: false,
            }],
        )
        .expect("run creates");

    let error = KernelRunService::run_complete_step(
        &service,
        Request::new(proto::RunCompleteStepRequest {
            event_hash: None,
            observe_results: vec![proto::ObserveResult {
                annotations_cbor: vec![vec![0xff]],
                signals_cbor: Vec::new(),
            }],
            run_id: "run_main".to_string(),
            step_id: "model_call".to_string(),
            tree_hash: None,
        }),
    )
    .await
    .expect_err("invalid annotation CBOR is rejected");

    assert_eq!(error.code(), tonic::Code::InvalidArgument);
}

async fn spawn_kernel_server() -> (String, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind test gRPC listener");
    let address = listener.local_addr().expect("read listener address");
    let service = KernelGrpcServiceImpl::new(InMemoryKernel::new());
    let handle = tokio::spawn(async move {
        Server::builder()
            .add_service(
                proto::kernel_store_service_server::KernelStoreServiceServer::new(service.clone()),
            )
            .add_service(
                proto::kernel_schema_service_server::KernelSchemaServiceServer::new(
                    service.clone(),
                ),
            )
            .add_service(
                proto::kernel_tree_service_server::KernelTreeServiceServer::new(service.clone()),
            )
            .add_service(
                proto::kernel_node_service_server::KernelNodeServiceServer::new(service.clone()),
            )
            .add_service(
                proto::kernel_thread_service_server::KernelThreadServiceServer::new(
                    service.clone(),
                ),
            )
            .add_service(
                proto::kernel_branch_service_server::KernelBranchServiceServer::new(
                    service.clone(),
                ),
            )
            .add_service(
                proto::kernel_staging_service_server::KernelStagingServiceServer::new(
                    service.clone(),
                ),
            )
            .add_service(
                proto::kernel_run_service_server::KernelRunServiceServer::new(service.clone()),
            )
            .add_service(
                proto::kernel_turn_service_server::KernelTurnServiceServer::new(service.clone()),
            )
            .add_service(
                proto::kernel_verdicts_service_server::KernelVerdictsServiceServer::new(service),
            )
            .serve_with_incoming(TcpListenerStream::new(listener))
            .await
            .expect("test gRPC server runs");
    });

    (format!("http://{address}"), handle)
}
