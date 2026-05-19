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

use prost::Message;
use prost_types::Any;
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;
use tonic::codegen::Bytes;
use tonic::transport::{Error as TransportError, Server};
use tonic::{Code, Request, Response, Status};
use tuvren_kernel_rust::{
    BranchRecord, InMemoryKernel, IncorporationRule, KernelError, KernelRecord, KernelResult,
    PathCollectionKind, PathDefinition, PathValue, RunCompletionStatus, RunStatus, SetHeadResult,
    StagedResult, StagedResultStatus, StepDeclaration, StoredThreadEntry, ThreadCreateResult,
    ThreadListOptions, ThreadRecord, TurnNode, TurnRecord, TurnTreeManifest, TurnTreeSchema,
    Verdict, VerdictDisposition, decode_deterministic_kernel_record,
    encode_deterministic_kernel_record,
};

pub mod proto {
    tonic::include_proto!("tuvren.kernel.interop.v1");
}

use proto::kernel_branch_service_server::KernelBranchService;
use proto::kernel_node_service_server::KernelNodeService;
use proto::kernel_run_service_server::KernelRunService;
use proto::kernel_schema_service_server::KernelSchemaService;
use proto::kernel_staging_service_server::KernelStagingService;
use proto::kernel_store_service_server::KernelStoreService;
use proto::kernel_thread_service_server::KernelThreadService;
use proto::kernel_tree_service_server::KernelTreeService;
use proto::kernel_turn_service_server::KernelTurnService;
use proto::kernel_verdicts_service_server::KernelVerdictsService;

const KERNEL_ERROR_PAYLOAD_TYPE_URL: &str =
    "type.googleapis.com/tuvren.kernel.interop.v1.KernelErrorPayload";

#[derive(Clone, PartialEq, Message)]
struct GoogleRpcStatus {
    #[prost(int32, tag = "1")]
    code: i32,
    #[prost(string, tag = "2")]
    message: String,
    #[prost(message, repeated, tag = "3")]
    details: Vec<Any>,
}

#[derive(Clone)]
pub struct KernelGrpcServiceImpl {
    kernel: InMemoryKernel,
}

impl KernelGrpcServiceImpl {
    pub fn new(kernel: InMemoryKernel) -> Self {
        Self { kernel }
    }

    pub fn kernel(&self) -> &InMemoryKernel {
        &self.kernel
    }
}

pub async fn serve_kernel_grpc(
    address: std::net::SocketAddr,
    kernel: InMemoryKernel,
) -> Result<(), TransportError> {
    let service = KernelGrpcServiceImpl::new(kernel);

    // Register the full governed kernel transport surface. Epic U stops here;
    // TypeScript client/runtime switching is intentionally left to Epic V.
    Server::builder()
        .add_service(
            proto::kernel_store_service_server::KernelStoreServiceServer::new(service.clone()),
        )
        .add_service(
            proto::kernel_schema_service_server::KernelSchemaServiceServer::new(service.clone()),
        )
        .add_service(
            proto::kernel_tree_service_server::KernelTreeServiceServer::new(service.clone()),
        )
        .add_service(
            proto::kernel_node_service_server::KernelNodeServiceServer::new(service.clone()),
        )
        .add_service(
            proto::kernel_thread_service_server::KernelThreadServiceServer::new(service.clone()),
        )
        .add_service(
            proto::kernel_branch_service_server::KernelBranchServiceServer::new(service.clone()),
        )
        .add_service(
            proto::kernel_staging_service_server::KernelStagingServiceServer::new(service.clone()),
        )
        .add_service(proto::kernel_run_service_server::KernelRunServiceServer::new(service.clone()))
        .add_service(
            proto::kernel_turn_service_server::KernelTurnServiceServer::new(service.clone()),
        )
        .add_service(
            proto::kernel_verdicts_service_server::KernelVerdictsServiceServer::new(service),
        )
        .serve(address)
        .await
}

#[tonic::async_trait]
impl KernelStoreService for KernelGrpcServiceImpl {
    async fn store_put(
        &self,
        request: Request<proto::StorePutRequest>,
    ) -> Result<Response<proto::StorePutResponse>, Status> {
        let request = request.into_inner();
        let object_hash = self
            .kernel
            .store_put(request.blob, request.media_type)
            .map_err(status_from_kernel_error)?;
        Ok(Response::new(proto::StorePutResponse { object_hash }))
    }

    async fn store_get(
        &self,
        request: Request<proto::StoreGetRequest>,
    ) -> Result<Response<proto::StoreGetResponse>, Status> {
        let blob = self
            .kernel
            .store_get(&request.into_inner().hash)
            .map_err(status_from_kernel_error)?;
        Ok(Response::new(proto::StoreGetResponse {
            found: blob.is_some(),
            blob: blob.unwrap_or_default(),
        }))
    }

    async fn store_has(
        &self,
        request: Request<proto::StoreHasRequest>,
    ) -> Result<Response<proto::StoreHasResponse>, Status> {
        let exists = self
            .kernel
            .store_has(&request.into_inner().hash)
            .map_err(status_from_kernel_error)?;
        Ok(Response::new(proto::StoreHasResponse { exists }))
    }
}

#[tonic::async_trait]
impl KernelSchemaService for KernelGrpcServiceImpl {
    async fn schema_register(
        &self,
        request: Request<proto::SchemaRegisterRequest>,
    ) -> Result<Response<proto::SchemaRegisterResponse>, Status> {
        let schema = request
            .into_inner()
            .schema
            .ok_or_else(|| Status::invalid_argument("schema is required"))
            .and_then(schema_from_proto)?;
        let schema_id = self
            .kernel
            .schema_register(schema)
            .map_err(status_from_kernel_error)?;
        Ok(Response::new(proto::SchemaRegisterResponse { schema_id }))
    }

    async fn schema_get(
        &self,
        request: Request<proto::SchemaGetRequest>,
    ) -> Result<Response<proto::SchemaGetResponse>, Status> {
        let schema = self
            .kernel
            .schema_get(&request.into_inner().schema_id)
            .map_err(status_from_kernel_error)?;
        Ok(Response::new(proto::SchemaGetResponse {
            found: schema.is_some(),
            schema: schema.map(schema_to_proto),
        }))
    }
}

#[tonic::async_trait]
impl KernelTreeService for KernelGrpcServiceImpl {
    async fn tree_create(
        &self,
        request: Request<proto::TreeCreateRequest>,
    ) -> Result<Response<proto::TreeCreateResponse>, Status> {
        let request = request.into_inner();
        let tree_hash = self
            .kernel
            .tree_create(
                &request.schema_id,
                manifest_from_entries(request.changes)?,
                request.base_turn_tree_hash.as_deref(),
            )
            .map_err(status_from_kernel_error)?;
        Ok(Response::new(proto::TreeCreateResponse { tree_hash }))
    }

    async fn tree_incorporate(
        &self,
        request: Request<proto::TreeIncorporateRequest>,
    ) -> Result<Response<proto::TreeIncorporateResponse>, Status> {
        let request = request.into_inner();
        let staged_results = request
            .staged_results
            .into_iter()
            .map(staged_result_from_proto)
            .collect::<Result<Vec<_>, _>>()?;
        let tree_hash = self
            .kernel
            .tree_incorporate(&request.base_turn_tree_hash, &staged_results)
            .map_err(status_from_kernel_error)?;
        Ok(Response::new(proto::TreeIncorporateResponse { tree_hash }))
    }

    async fn tree_diff(
        &self,
        request: Request<proto::TreeDiffRequest>,
    ) -> Result<Response<proto::TreeDiffResponse>, Status> {
        let request = request.into_inner();
        let paths = self
            .kernel
            .tree_diff(&request.tree_hash_a, &request.tree_hash_b)
            .map_err(status_from_kernel_error)?;
        Ok(Response::new(proto::TreeDiffResponse { paths }))
    }

    async fn tree_resolve(
        &self,
        request: Request<proto::TreeResolveRequest>,
    ) -> Result<Response<proto::TreeResolveResponse>, Status> {
        let request = request.into_inner();
        let value = self
            .kernel
            .tree_resolve(&request.tree_hash, &request.path)
            .map_err(status_from_kernel_error)?;
        Ok(Response::new(proto::TreeResolveResponse {
            value: Some(path_value_to_proto(value)),
        }))
    }

    async fn tree_manifest(
        &self,
        request: Request<proto::TreeManifestRequest>,
    ) -> Result<Response<proto::TreeManifestResponse>, Status> {
        let entries = self
            .kernel
            .tree_manifest(&request.into_inner().tree_hash)
            .map_err(status_from_kernel_error)?
            .into_iter()
            .map(|(path, value)| proto::PathValueEntry {
                path,
                value: Some(path_value_to_proto(value)),
            })
            .collect();
        Ok(Response::new(proto::TreeManifestResponse { entries }))
    }
}

#[tonic::async_trait]
impl KernelNodeService for KernelGrpcServiceImpl {
    async fn node_get(
        &self,
        request: Request<proto::NodeGetRequest>,
    ) -> Result<Response<proto::NodeGetResponse>, Status> {
        let node = self
            .kernel
            .node_get(&request.into_inner().hash)
            .map_err(status_from_kernel_error)?;
        Ok(Response::new(proto::NodeGetResponse {
            found: node.is_some(),
            node: node.map(turn_node_to_proto),
        }))
    }

    type NodeWalkBackStream = ReceiverStream<Result<proto::NodeWalkBackResponse, Status>>;

    async fn node_walk_back(
        &self,
        request: Request<proto::NodeWalkBackRequest>,
    ) -> Result<Response<Self::NodeWalkBackStream>, Status> {
        let kernel = self.kernel.clone();
        let mut next_hash = Some(request.into_inner().from_hash);
        let (sender, receiver) = mpsc::channel(8);
        tokio::spawn(async move {
            while let Some(hash) = next_hash {
                let node = match kernel.node_get(&hash) {
                    Ok(Some(node)) => node,
                    Ok(None) => {
                        let _ = sender
                            .send(Err(status_from_kernel_error(KernelError::new(
                                "turn_node_not_found",
                                "turn node does not exist",
                                None,
                            ))))
                            .await;
                        break;
                    }
                    Err(error) => {
                        let _ = sender.send(Err(status_from_kernel_error(error))).await;
                        break;
                    }
                };
                next_hash = node.previous_turn_node_hash.clone();
                if sender
                    .send(Ok(proto::NodeWalkBackResponse {
                        node: Some(turn_node_to_proto(node)),
                    }))
                    .await
                    .is_err()
                {
                    break;
                }
            }
        });
        Ok(Response::new(ReceiverStream::new(receiver)))
    }
}

#[tonic::async_trait]
impl KernelThreadService for KernelGrpcServiceImpl {
    async fn thread_create(
        &self,
        request: Request<proto::ThreadCreateRequest>,
    ) -> Result<Response<proto::ThreadCreateResponse>, Status> {
        let request = request.into_inner();
        let result = self
            .kernel
            .thread_create(
                &request.thread_id,
                &request.schema_id,
                &request.initial_branch_id,
            )
            .map_err(status_from_kernel_error)?;
        Ok(Response::new(proto::ThreadCreateResponse {
            result: Some(thread_create_result_to_proto(result)),
        }))
    }

    async fn thread_get(
        &self,
        request: Request<proto::ThreadGetRequest>,
    ) -> Result<Response<proto::ThreadGetResponse>, Status> {
        let thread = self
            .kernel
            .thread_get(&request.into_inner().thread_id)
            .map_err(status_from_kernel_error)?;
        Ok(Response::new(proto::ThreadGetResponse {
            found: thread.is_some(),
            thread: thread.map(thread_to_proto),
        }))
    }

    async fn thread_list(
        &self,
        request: Request<proto::ThreadListRequest>,
    ) -> Result<Response<proto::ThreadListResponse>, Status> {
        let req = request.into_inner();
        let cursor = req.cursor.map(|c| {
            // Cursor is "lastCreatedAtMs:lastThreadId" — parse on the server.
            // The TS adapter encodes/decodes the opaque KernelThreadListCursor;
            // for Rust-to-Rust calls we expose a simple colon-delimited form.
            let parts: Vec<&str> = c.splitn(2, ':').collect();
            if parts.len() == 2
                && let Ok(ms) = parts[0].parse::<i64>()
            {
                return (ms, parts[1].to_string());
            }
            (0, c)
        });
        let options = ThreadListOptions {
            limit: req.limit.map(|l| l as usize),
            cursor,
            filter_schema_id: req.filter_schema_id,
        };
        let (entries, next_cursor) = self
            .kernel
            .thread_list(options)
            .map_err(status_from_kernel_error)?;
        Ok(Response::new(proto::ThreadListResponse {
            entries: entries
                .into_iter()
                .map(stored_thread_entry_to_proto)
                .collect(),
            next_cursor: next_cursor.map(|(ms, id)| format!("{ms}:{id}")),
        }))
    }
}

#[tonic::async_trait]
impl KernelBranchService for KernelGrpcServiceImpl {
    async fn branch_create(
        &self,
        request: Request<proto::BranchCreateRequest>,
    ) -> Result<Response<proto::BranchCreateResponse>, Status> {
        let request = request.into_inner();
        let branch = self
            .kernel
            .branch_create(
                &request.branch_id,
                &request.thread_id,
                &request.from_turn_node_hash,
            )
            .map_err(status_from_kernel_error)?;
        Ok(Response::new(proto::BranchCreateResponse {
            branch: Some(branch_to_proto(branch)),
        }))
    }

    async fn branch_get(
        &self,
        request: Request<proto::BranchGetRequest>,
    ) -> Result<Response<proto::BranchGetResponse>, Status> {
        let branch = self
            .kernel
            .branch_get(&request.into_inner().branch_id)
            .map_err(status_from_kernel_error)?;
        Ok(Response::new(proto::BranchGetResponse {
            found: branch.is_some(),
            branch: branch.map(branch_to_proto),
        }))
    }

    async fn branch_set_head(
        &self,
        request: Request<proto::BranchSetHeadRequest>,
    ) -> Result<Response<proto::BranchSetHeadResponse>, Status> {
        let request = request.into_inner();
        let result = self
            .kernel
            .branch_set_head(&request.branch_id, &request.turn_node_hash)
            .map_err(status_from_kernel_error)?;
        Ok(Response::new(proto::BranchSetHeadResponse {
            result: Some(set_head_result_to_proto(result)),
        }))
    }

    async fn branch_list(
        &self,
        request: Request<proto::BranchListRequest>,
    ) -> Result<Response<proto::BranchListResponse>, Status> {
        let entries = self
            .kernel
            .branch_list(&request.into_inner().thread_id)
            .map_err(status_from_kernel_error)?
            .into_iter()
            .map(
                |(branch_id, head_turn_node_hash)| proto::BranchHeadListEntry {
                    branch_id,
                    head_turn_node_hash,
                },
            )
            .collect();
        Ok(Response::new(proto::BranchListResponse { entries }))
    }
}

#[tonic::async_trait]
impl KernelStagingService for KernelGrpcServiceImpl {
    async fn staging_stage(
        &self,
        request: Request<proto::StagingStageRequest>,
    ) -> Result<Response<proto::StagingStageResponse>, Status> {
        let request = request.into_inner();
        let (status, interrupt_payload) = match request.outcome {
            Some(proto::staging_stage_request::Outcome::Settled(settled)) => (
                staged_status_from_proto(settled.status)?,
                Option::<KernelRecord>::None,
            ),
            Some(proto::staging_stage_request::Outcome::Interrupted(interrupted)) => (
                StagedResultStatus::Interrupted,
                Some(
                    decode_deterministic_kernel_record(&interrupted.interrupt_payload_cbor)
                        .map_err(status_from_kernel_error)?,
                ),
            ),
            None => return Err(Status::invalid_argument("staging outcome is required")),
        };
        let (object_hash, staged_result) = self
            .kernel
            .staging_stage(
                &request.run_id,
                request.blob,
                &request.task_id,
                &request.object_type,
                status,
                interrupt_payload,
            )
            .map_err(status_from_kernel_error)?;
        Ok(Response::new(proto::StagingStageResponse {
            object_hash,
            staged_result: Some(staged_result_to_proto(staged_result)?),
        }))
    }

    async fn staging_current(
        &self,
        request: Request<proto::StagingCurrentRequest>,
    ) -> Result<Response<proto::StagingCurrentResponse>, Status> {
        let staged_results = self
            .kernel
            .staging_current(&request.into_inner().run_id)
            .map_err(status_from_kernel_error)?
            .into_iter()
            .map(staged_result_to_proto)
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Response::new(proto::StagingCurrentResponse {
            staged_results,
        }))
    }
}

#[tonic::async_trait]
impl KernelRunService for KernelGrpcServiceImpl {
    async fn run_create(
        &self,
        request: Request<proto::RunCreateRequest>,
    ) -> Result<Response<proto::RunCreateResponse>, Status> {
        let request = request.into_inner();
        let steps = request
            .steps
            .into_iter()
            .map(step_from_proto)
            .collect::<Result<Vec<_>, _>>()?;
        let run = self
            .kernel
            .run_create(
                &request.run_id,
                &request.turn_id,
                &request.branch_id,
                &request.schema_id,
                &request.start_turn_node_hash,
                steps,
            )
            .map_err(status_from_kernel_error)?;
        Ok(Response::new(proto::RunCreateResponse {
            run: Some(run_to_proto(run)),
        }))
    }

    async fn run_begin_step(
        &self,
        request: Request<proto::RunBeginStepRequest>,
    ) -> Result<Response<proto::RunBeginStepResponse>, Status> {
        let request = request.into_inner();
        let context = self
            .kernel
            .run_begin_step(&request.run_id, &request.step_id)
            .map_err(status_from_kernel_error)?;
        Ok(Response::new(proto::RunBeginStepResponse {
            context: Some(proto::StepContext {
                current_turn_node_hash: context.current_turn_node_hash,
                schema: Some(schema_to_proto(context.schema)),
                signals_cbor: context
                    .signals
                    .iter()
                    .map(encode_deterministic_kernel_record)
                    .collect::<KernelResult<Vec<_>>>()
                    .map_err(status_from_kernel_error)?,
                step: Some(step_to_proto(context.step)?),
            }),
        }))
    }

    async fn run_complete_step(
        &self,
        request: Request<proto::RunCompleteStepRequest>,
    ) -> Result<Response<proto::RunCompleteStepResponse>, Status> {
        let request = request.into_inner();
        let observe_results = request
            .observe_results
            .into_iter()
            .map(|result| {
                let annotations = result
                    .annotations_cbor
                    .iter()
                    .map(|bytes| {
                        let record = decode_deterministic_kernel_record(bytes)?;
                        if !matches!(record, KernelRecord::Map(_)) {
                            return Err(KernelError::new(
                                "invalid_annotation_record",
                                "observe annotations must be kernel object records",
                                None,
                            ));
                        }
                        encode_deterministic_kernel_record(&record)
                    })
                    .collect::<KernelResult<Vec<_>>>()?;
                Ok(tuvren_kernel_rust::ObserveResult {
                    annotations,
                    signals: result
                        .signals_cbor
                        .iter()
                        .map(|bytes| decode_deterministic_kernel_record(bytes))
                        .collect::<KernelResult<Vec<_>>>()?,
                })
            })
            .collect::<KernelResult<Vec<_>>>()
            .map_err(status_from_kernel_error)?;
        let (checkpointed, turn_node_hash) = self
            .kernel
            .run_complete_step(
                &request.run_id,
                &request.step_id,
                request.event_hash,
                observe_results,
                request.tree_hash,
            )
            .map_err(status_from_kernel_error)?;
        Ok(Response::new(proto::RunCompleteStepResponse {
            checkpointed,
            turn_node_hash,
        }))
    }

    async fn run_complete(
        &self,
        request: Request<proto::RunCompleteRequest>,
    ) -> Result<Response<proto::RunCompleteResponse>, Status> {
        let request = request.into_inner();
        let turn_node_hash = self
            .kernel
            .run_complete(
                &request.run_id,
                run_completion_status_from_proto(request.status)?,
                request.event_hash,
            )
            .map_err(status_from_kernel_error)?;
        Ok(Response::new(proto::RunCompleteResponse { turn_node_hash }))
    }

    async fn run_recover(
        &self,
        request: Request<proto::RunRecoverRequest>,
    ) -> Result<Response<proto::RunRecoverResponse>, Status> {
        let recovery = self
            .kernel
            .run_recover(&request.into_inner().run_id)
            .map_err(status_from_kernel_error)?;
        Ok(Response::new(proto::RunRecoverResponse {
            recovery_state: Some(proto::RecoveryState {
                consumed_staged_results: recovery
                    .consumed_staged_results
                    .into_iter()
                    .map(staged_result_to_proto)
                    .collect::<Result<Vec<_>, _>>()?,
                last_completed_step_id: recovery.last_completed_step_id,
                last_turn_node_hash: recovery.last_turn_node_hash,
                step_sequence: recovery
                    .step_sequence
                    .into_iter()
                    .map(step_to_proto)
                    .collect::<Result<Vec<_>, _>>()?,
                uncommitted_staged_results: recovery
                    .uncommitted_staged_results
                    .into_iter()
                    .map(staged_result_to_proto)
                    .collect::<Result<Vec<_>, _>>()?,
            }),
        }))
    }
}

#[tonic::async_trait]
impl KernelTurnService for KernelGrpcServiceImpl {
    async fn turn_create(
        &self,
        request: Request<proto::TurnCreateRequest>,
    ) -> Result<Response<proto::TurnCreateResponse>, Status> {
        let request = request.into_inner();
        let turn = self
            .kernel
            .turn_create(
                &request.turn_id,
                &request.thread_id,
                &request.branch_id,
                request.parent_turn_id,
                &request.start_turn_node_hash,
            )
            .map_err(status_from_kernel_error)?;
        Ok(Response::new(proto::TurnCreateResponse {
            turn: Some(turn_to_proto(turn)),
        }))
    }

    async fn turn_get(
        &self,
        request: Request<proto::TurnGetRequest>,
    ) -> Result<Response<proto::TurnGetResponse>, Status> {
        let turn = self
            .kernel
            .turn_get(&request.into_inner().turn_id)
            .map_err(status_from_kernel_error)?;
        Ok(Response::new(proto::TurnGetResponse {
            found: turn.is_some(),
            turn: turn.map(turn_to_proto),
        }))
    }

    async fn turn_update_head(
        &self,
        request: Request<proto::TurnUpdateHeadRequest>,
    ) -> Result<Response<proto::TurnUpdateHeadResponse>, Status> {
        let request = request.into_inner();
        self.kernel
            .turn_update_head(&request.turn_id, &request.head_turn_node_hash)
            .map_err(status_from_kernel_error)?;
        Ok(Response::new(proto::TurnUpdateHeadResponse {}))
    }
}

#[tonic::async_trait]
impl KernelVerdictsService for KernelGrpcServiceImpl {
    async fn verdicts_compose(
        &self,
        request: Request<proto::VerdictsComposeRequest>,
    ) -> Result<Response<proto::VerdictsComposeResponse>, Status> {
        let verdicts = request
            .into_inner()
            .verdicts
            .into_iter()
            .map(verdict_from_proto)
            .collect::<Result<Vec<_>, _>>()?;
        let verdict = self
            .kernel
            .verdicts_compose(verdicts)
            .map_err(status_from_kernel_error)?;
        Ok(Response::new(proto::VerdictsComposeResponse {
            verdict: Some(verdict_to_proto(verdict)?),
        }))
    }
}

fn status_from_kernel_error(error: KernelError) -> Status {
    let code = kernel_error_code_to_status(&error.payload.code);
    let details_cbor = error
        .payload
        .details
        .as_ref()
        .and_then(|details| encode_deterministic_kernel_record(details).ok());
    let payload = proto::KernelErrorPayload {
        code: error.payload.code,
        message: error.payload.message,
        details_cbor,
    };
    let message = format!("{}: {}", payload.code, payload.message);
    let mut payload_bytes = Vec::new();
    // grpc-status-details-bin must contain a google.rpc.Status envelope, with
    // concrete error payloads packed as Any details. Raw proto bytes here make
    // Connect clients fail before they can unpack the stable kernel payload.
    if payload.encode(&mut payload_bytes).is_ok() {
        let rich_status = GoogleRpcStatus {
            code: code as i32,
            message: message.clone(),
            details: vec![Any {
                type_url: KERNEL_ERROR_PAYLOAD_TYPE_URL.to_string(),
                value: payload_bytes,
            }],
        };
        let mut status_bytes = Vec::new();
        if rich_status.encode(&mut status_bytes).is_ok() {
            return Status::with_details(code, message, Bytes::from(status_bytes));
        }
    }
    Status::new(code, message)
}

fn kernel_error_code_to_status(code: &str) -> Code {
    match code {
        "branch_not_found"
        | "event_object_not_found"
        | "incorporation_rule_not_found"
        | "parent_turn_not_found"
        | "run_not_found"
        | "run_step_not_found"
        | "schema_not_found"
        | "staged_object_not_found"
        | "thread_not_found"
        | "turn_node_not_found"
        | "turn_not_found"
        | "turn_tree_not_found"
        | "turn_tree_path_not_found" => Code::NotFound,
        "branch_already_exists"
        | "run_already_exists"
        | "schema_already_exists"
        | "staged_result_task_already_exists"
        | "thread_already_exists"
        | "turn_already_exists" => Code::AlreadyExists,
        "duplicate_incorporation_rule_object_type"
        | "duplicate_schema_path"
        | "duplicate_step_id"
        | "incomplete_turn_tree_manifest"
        | "invalid_annotation_record"
        | "invalid_decoded_kernel_record"
        | "invalid_epoch_ms"
        | "invalid_hash_string"
        | "invalid_incorporation_rule"
        | "invalid_incorporation_rule_target"
        | "invalid_json_kernel_record_number"
        | "invalid_kernel_record_integer"
        | "invalid_kernel_record_map_key"
        | "invalid_kernel_record_value"
        | "invalid_object_type"
        | "invalid_path_value_kind"
        | "invalid_run_id"
        | "invalid_schema_id"
        | "invalid_schema_path"
        | "invalid_staged_result_outcome"
        | "invalid_step_id"
        | "invalid_step_sequence"
        | "invalid_task_id"
        | "invalid_thread_id"
        | "invalid_branch_id"
        | "invalid_turn_id"
        | "invalid_parent_turn_id"
        | "non_canonical_kernel_record_encoding"
        | "unsupported_kernel_record_value" => Code::InvalidArgument,
        "branch_has_active_run"
        | "branch_head_lateral_move"
        | "invalid_ordered_path_state"
        | "invalid_run_completion_transition"
        | "parent_turn_head_mismatch"
        | "parent_turn_thread_mismatch"
        | "run_branch_head_mismatch"
        | "run_not_running"
        | "run_schema_mismatch"
        | "run_start_head_mismatch"
        | "run_step_mismatch"
        | "run_steps_incomplete"
        | "run_turn_branch_mismatch"
        | "run_turn_span_mismatch"
        | "turn_branch_thread_mismatch"
        | "turn_head_lateral_move"
        | "turn_head_not_descendant"
        | "turn_node_thread_mismatch"
        | "turn_parent_not_immediate"
        | "turn_parent_required"
        | "turn_tree_schema_mismatch" => Code::FailedPrecondition,
        _ => Code::FailedPrecondition,
    }
}

fn schema_from_proto(schema: proto::TurnTreeSchema) -> Result<TurnTreeSchema, Status> {
    Ok(TurnTreeSchema {
        incorporation_rules: schema
            .incorporation_rules
            .into_iter()
            .map(|rule| IncorporationRule {
                object_type: rule.object_type,
                target_path: rule.target_path,
            })
            .collect(),
        paths: schema
            .paths
            .into_iter()
            .map(|path| {
                Ok(PathDefinition {
                    collection: match path.collection() {
                        proto::PathCollectionKind::Ordered => PathCollectionKind::Ordered,
                        proto::PathCollectionKind::Single => PathCollectionKind::Single,
                        proto::PathCollectionKind::Unspecified => {
                            return Err(Status::invalid_argument(
                                "path collection kind must be specified",
                            ));
                        }
                    },
                    metadata: path
                        .metadata_cbor
                        .map(|bytes| decode_deterministic_kernel_record(&bytes))
                        .transpose()
                        .map_err(status_from_kernel_error)?,
                    path: path.path,
                })
            })
            .collect::<Result<Vec<_>, _>>()?,
        schema_id: schema.schema_id,
    })
}

fn schema_to_proto(schema: TurnTreeSchema) -> proto::TurnTreeSchema {
    proto::TurnTreeSchema {
        incorporation_rules: schema
            .incorporation_rules
            .into_iter()
            .map(|rule| proto::IncorporationRule {
                object_type: rule.object_type,
                target_path: rule.target_path,
            })
            .collect(),
        paths: schema
            .paths
            .into_iter()
            .map(|path| proto::PathDefinition {
                collection: match path.collection {
                    PathCollectionKind::Ordered => proto::PathCollectionKind::Ordered as i32,
                    PathCollectionKind::Single => proto::PathCollectionKind::Single as i32,
                },
                metadata_cbor: path
                    .metadata
                    .as_ref()
                    .map(encode_deterministic_kernel_record)
                    .transpose()
                    .unwrap_or_default(),
                path: path.path,
            })
            .collect(),
        schema_id: schema.schema_id,
    }
}

fn manifest_from_entries(entries: Vec<proto::PathValueEntry>) -> Result<TurnTreeManifest, Status> {
    let mut manifest = BTreeMap::new();
    for entry in entries {
        let value = entry
            .value
            .ok_or_else(|| Status::invalid_argument("path value is required"))
            .and_then(path_value_from_proto)?;
        // Duplicate transport entries must fail explicitly; otherwise map
        // insertion would hide malformed client input before kernel validation.
        if manifest.insert(entry.path, value).is_some() {
            return Err(Status::invalid_argument("duplicate path value entry"));
        }
    }
    Ok(manifest)
}

fn path_value_from_proto(value: proto::PathValue) -> Result<PathValue, Status> {
    match value.value {
        Some(proto::path_value::Value::NullValue(_)) => Ok(PathValue::Null),
        Some(proto::path_value::Value::SingleHash(value)) => Ok(PathValue::Single(value)),
        Some(proto::path_value::Value::OrderedHashes(values)) => {
            Ok(PathValue::Ordered(values.hashes))
        }
        None => Err(Status::invalid_argument("path value oneof is required")),
    }
}

fn path_value_to_proto(value: PathValue) -> proto::PathValue {
    proto::PathValue {
        value: Some(match value {
            PathValue::Null => proto::path_value::Value::NullValue(proto::NullPathValue {}),
            PathValue::Single(value) => proto::path_value::Value::SingleHash(value),
            PathValue::Ordered(values) => {
                proto::path_value::Value::OrderedHashes(proto::OrderedPathHashes { hashes: values })
            }
        }),
    }
}

fn step_from_proto(step: proto::StepDeclaration) -> Result<StepDeclaration, Status> {
    Ok(StepDeclaration {
        deterministic: step.deterministic,
        id: step.id,
        metadata: step
            .metadata_cbor
            .map(|bytes| decode_deterministic_kernel_record(&bytes))
            .transpose()
            .map_err(status_from_kernel_error)?,
        side_effects: step.side_effects,
    })
}

fn step_to_proto(step: StepDeclaration) -> Result<proto::StepDeclaration, Status> {
    Ok(proto::StepDeclaration {
        deterministic: step.deterministic,
        id: step.id,
        metadata_cbor: step
            .metadata
            .as_ref()
            .map(encode_deterministic_kernel_record)
            .transpose()
            .map_err(status_from_kernel_error)?,
        side_effects: step.side_effects,
    })
}

fn staged_result_from_proto(value: proto::StagedResult) -> Result<StagedResult, Status> {
    let (status, interrupt_payload) = match value.outcome {
        Some(proto::staged_result::Outcome::Settled(settled)) => {
            (staged_status_from_proto(settled.status)?, None)
        }
        Some(proto::staged_result::Outcome::Interrupted(interrupted)) => (
            StagedResultStatus::Interrupted,
            Some(
                decode_deterministic_kernel_record(&interrupted.interrupt_payload_cbor)
                    .map_err(status_from_kernel_error)?,
            ),
        ),
        None => {
            return Err(Status::invalid_argument(
                "staged result outcome is required",
            ));
        }
    };
    Ok(StagedResult {
        interrupt_payload,
        object_hash: value.object_hash,
        object_type: value.object_type,
        status,
        task_id: value.task_id,
        timestamp_ms: value.timestamp_ms,
    })
}

fn staged_result_to_proto(value: StagedResult) -> Result<proto::StagedResult, Status> {
    let status = staged_status_to_proto(&value.status);
    let outcome = match value.status {
        StagedResultStatus::Completed | StagedResultStatus::Failed => {
            proto::staged_result::Outcome::Settled(proto::SettledStagedResult { status })
        }
        StagedResultStatus::Interrupted => {
            proto::staged_result::Outcome::Interrupted(proto::InterruptedStagedResult {
                interrupt_payload_cbor: encode_deterministic_kernel_record(
                    &value
                        .interrupt_payload
                        .ok_or_else(|| Status::invalid_argument("interrupt payload is required"))?,
                )
                .map_err(status_from_kernel_error)?,
            })
        }
    };
    Ok(proto::StagedResult {
        object_hash: value.object_hash,
        object_type: value.object_type,
        task_id: value.task_id,
        timestamp_ms: value.timestamp_ms,
        outcome: Some(outcome),
    })
}

fn staged_status_from_proto(status: i32) -> Result<StagedResultStatus, Status> {
    match proto::StagedResultStatus::try_from(status)
        .map_err(|_| Status::invalid_argument("invalid staged result status"))?
    {
        proto::StagedResultStatus::Completed => Ok(StagedResultStatus::Completed),
        proto::StagedResultStatus::Failed => Ok(StagedResultStatus::Failed),
        proto::StagedResultStatus::Unspecified => {
            Err(Status::invalid_argument("staged result status is required"))
        }
    }
}

fn staged_status_to_proto(status: &StagedResultStatus) -> i32 {
    match status {
        StagedResultStatus::Completed => proto::StagedResultStatus::Completed as i32,
        StagedResultStatus::Failed => proto::StagedResultStatus::Failed as i32,
        StagedResultStatus::Interrupted => proto::StagedResultStatus::Unspecified as i32,
    }
}

fn turn_node_to_proto(node: TurnNode) -> proto::TurnNode {
    proto::TurnNode {
        consumed_staged_results: node
            .consumed_staged_results
            .into_iter()
            .map(staged_result_to_proto)
            .collect::<Result<Vec<_>, _>>()
            .unwrap_or_default(),
        event_hash: node.event_hash,
        hash: node.hash,
        previous_turn_node_hash: node.previous_turn_node_hash,
        schema_id: node.schema_id,
        turn_tree_hash: node.turn_tree_hash,
    }
}

fn thread_create_result_to_proto(result: ThreadCreateResult) -> proto::ThreadCreateResult {
    proto::ThreadCreateResult {
        branch_id: result.branch_id,
        root_turn_node_hash: result.root_turn_node_hash,
        root_turn_tree_hash: result.root_turn_tree_hash,
        thread_id: result.thread_id,
    }
}

fn thread_to_proto(thread: ThreadRecord) -> proto::ThreadRecord {
    proto::ThreadRecord {
        root_turn_node_hash: thread.root_turn_node_hash,
        schema_id: thread.schema_id,
        thread_id: thread.thread_id,
    }
}

fn stored_thread_entry_to_proto(entry: StoredThreadEntry) -> proto::StoredThreadEntry {
    proto::StoredThreadEntry {
        thread_id: entry.thread_id,
        schema_id: entry.schema_id,
        root_turn_node_hash: entry.root_turn_node_hash,
        created_at_ms: entry.created_at_ms,
    }
}

fn branch_to_proto(branch: BranchRecord) -> proto::BranchRecord {
    proto::BranchRecord {
        branch_id: branch.branch_id,
        head_turn_node_hash: branch.head_turn_node_hash,
        thread_id: branch.thread_id,
    }
}

fn set_head_result_to_proto(result: SetHeadResult) -> proto::SetHeadResult {
    proto::SetHeadResult {
        archive_branch: result.archive_branch.map(branch_to_proto),
        branch: Some(branch_to_proto(result.branch)),
    }
}

fn run_to_proto(run: tuvren_kernel_rust::RunRecord) -> proto::RunRecord {
    proto::RunRecord {
        branch_id: run.branch_id,
        created_turn_nodes: run.created_turn_nodes,
        current_step_index: i32::try_from(run.current_step_index).unwrap_or(i32::MAX),
        run_id: run.run_id,
        schema_id: run.schema_id,
        start_turn_node_hash: run.start_turn_node_hash,
        status: match run.status {
            RunStatus::Running => proto::RunStatus::Running as i32,
            RunStatus::Paused => proto::RunStatus::Paused as i32,
            RunStatus::Completed => proto::RunStatus::Completed as i32,
            RunStatus::Failed => proto::RunStatus::Failed as i32,
        },
        step_sequence: run
            .step_sequence
            .into_iter()
            .map(step_to_proto)
            .collect::<Result<Vec<_>, _>>()
            .unwrap_or_default(),
        turn_id: run.turn_id,
    }
}

fn run_completion_status_from_proto(status: i32) -> Result<RunCompletionStatus, Status> {
    match proto::RunCompletionStatus::try_from(status)
        .map_err(|_| Status::invalid_argument("invalid run completion status"))?
    {
        proto::RunCompletionStatus::Paused => Ok(RunCompletionStatus::Paused),
        proto::RunCompletionStatus::Completed => Ok(RunCompletionStatus::Completed),
        proto::RunCompletionStatus::Failed => Ok(RunCompletionStatus::Failed),
        proto::RunCompletionStatus::Unspecified => Err(Status::invalid_argument(
            "run completion status is required",
        )),
    }
}

fn turn_to_proto(turn: TurnRecord) -> proto::TurnRecord {
    proto::TurnRecord {
        branch_id: turn.branch_id,
        head_turn_node_hash: turn.head_turn_node_hash,
        parent_turn_id: turn.parent_turn_id,
        start_turn_node_hash: turn.start_turn_node_hash,
        thread_id: turn.thread_id,
        turn_id: turn.turn_id,
    }
}

fn verdict_from_proto(verdict: proto::Verdict) -> Result<Verdict, Status> {
    match verdict.verdict {
        Some(proto::verdict::Verdict::Proceed(_)) => Ok(Verdict::Proceed),
        Some(proto::verdict::Verdict::Abort(abort)) => Ok(Verdict::Abort {
            disposition: verdict_disposition_from_proto(abort.disposition)?,
            reason: abort.reason,
        }),
        Some(proto::verdict::Verdict::Modify(modify)) => Ok(Verdict::Modify {
            transform: decode_deterministic_kernel_record(&modify.transform_cbor)
                .map_err(status_from_kernel_error)?,
        }),
        Some(proto::verdict::Verdict::Pause(pause)) => Ok(Verdict::Pause {
            reason: pause.reason,
            resumption_schema: decode_deterministic_kernel_record(&pause.resumption_schema_cbor)
                .map_err(status_from_kernel_error)?,
        }),
        Some(proto::verdict::Verdict::Retry(retry)) => Ok(Verdict::Retry {
            adjustment: decode_deterministic_kernel_record(&retry.adjustment_cbor)
                .map_err(status_from_kernel_error)?,
        }),
        None => Err(Status::invalid_argument("verdict oneof is required")),
    }
}

fn verdict_to_proto(verdict: Verdict) -> Result<proto::Verdict, Status> {
    Ok(proto::Verdict {
        verdict: Some(match verdict {
            Verdict::Proceed => proto::verdict::Verdict::Proceed(proto::ProceedVerdict {}),
            Verdict::Abort {
                disposition,
                reason,
            } => proto::verdict::Verdict::Abort(proto::AbortVerdict {
                disposition: verdict_disposition_to_proto(disposition),
                reason,
            }),
            Verdict::Modify { transform } => {
                proto::verdict::Verdict::Modify(proto::ModifyVerdict {
                    transform_cbor: encode_deterministic_kernel_record(&transform)
                        .map_err(status_from_kernel_error)?,
                })
            }
            Verdict::Pause {
                reason,
                resumption_schema,
            } => proto::verdict::Verdict::Pause(proto::PauseVerdict {
                reason,
                resumption_schema_cbor: encode_deterministic_kernel_record(&resumption_schema)
                    .map_err(status_from_kernel_error)?,
            }),
            Verdict::Retry { adjustment } => proto::verdict::Verdict::Retry(proto::RetryVerdict {
                adjustment_cbor: encode_deterministic_kernel_record(&adjustment)
                    .map_err(status_from_kernel_error)?,
            }),
        }),
    })
}

fn verdict_disposition_from_proto(disposition: i32) -> Result<VerdictDisposition, Status> {
    match proto::VerdictDisposition::try_from(disposition)
        .map_err(|_| Status::invalid_argument("invalid verdict disposition"))?
    {
        proto::VerdictDisposition::HardFail => Ok(VerdictDisposition::HardFail),
        proto::VerdictDisposition::SoftFail => Ok(VerdictDisposition::SoftFail),
        proto::VerdictDisposition::EndTurn => Ok(VerdictDisposition::EndTurn),
        proto::VerdictDisposition::Unspecified => {
            Err(Status::invalid_argument("verdict disposition is required"))
        }
    }
}

fn verdict_disposition_to_proto(disposition: VerdictDisposition) -> i32 {
    match disposition {
        VerdictDisposition::HardFail => proto::VerdictDisposition::HardFail as i32,
        VerdictDisposition::SoftFail => proto::VerdictDisposition::SoftFail as i32,
        VerdictDisposition::EndTurn => proto::VerdictDisposition::EndTurn as i32,
    }
}
