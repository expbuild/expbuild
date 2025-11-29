use anyhow::Context;
use futures::stream::BoxStream;
use futures::stream::StreamExt;
use futures::stream::TryStreamExt;
use prost::Message;
use re_grpc_proto::build::bazel::remote::execution::v2::ExecuteOperationMetadata;
use re_grpc_proto::build::bazel::remote::execution::v2::ExecuteRequest as GExecuteRequest;
use re_grpc_proto::build::bazel::remote::execution::v2::ExecuteResponse as GExecuteResponse;
use re_grpc_proto::build::bazel::remote::execution::v2::ResultsCachePolicy;
use re_grpc_proto::build::bazel::remote::execution::v2::execution_stage;
use re_grpc_proto::google::longrunning::operation::Result as OpResult;

use crate::error::*;
use crate::metadata::*;
use crate::request::*;
use crate::response::*;

use super::helpers::convert_action_result;

pub(crate) async fn execute_with_progress_impl(
    mut client: re_grpc_proto::build::bazel::remote::execution::v2::execution_client::ExecutionClient<super::types::GrpcService>,
    instance_name: &super::types::InstanceName,
    metadata: RemoteExecutionMetadata,
    mut execute_request: ExecuteRequest,
    use_fbcode_metadata: bool,
) -> anyhow::Result<BoxStream<'static, anyhow::Result<ExecuteWithProgressResponse>>> {
    let action_digest = execute_request.action_digest.to_grpc();

    let request = GExecuteRequest {
        instance_name: instance_name.as_str().to_owned(),
        skip_cache_lookup: false,
        execution_policy: None,
        results_cache_policy: Some(ResultsCachePolicy { priority: 0 }),
        action_digest: Some(action_digest.clone()),
        ..Default::default()
    };

    let stream = client
        .execute(super::helpers::with_re_metadata(
            request,
            metadata,
            use_fbcode_metadata,
        ))
        .await?
        .into_inner();

    let stream = futures::stream::try_unfold(stream, move |mut stream| async {
        let msg = match stream.try_next().await.context("RE channel error")? {
            Some(msg) => msg,
            None => return Ok(None),
        };

        let status = if msg.done {
            match msg
                .result
                .context("Missing `result` when message was `done`")?
            {
                OpResult::Error(rpc_status) => {
                    return Err(REClientError {
                        code: TCode(rpc_status.code),
                        message: rpc_status.message,
                        group: TCodeReasonGroup::UNKNOWN,
                    }
                    .into());
                }
                OpResult::Response(any) => {
                    let execute_response_grpc: GExecuteResponse =
                        GExecuteResponse::decode(&any.value[..])?;

                    TStatus::from_grpc_result(execute_response_grpc.status.unwrap_or_default())?;

                    let action_result = execute_response_grpc
                        .result
                        .with_context(|| "The action result is not defined.")?;

                    let action_result = convert_action_result(action_result)?;

                    let execute_response = ExecuteResponse {
                        action_result,
                        action_result_digest: TDigest::default(),
                        action_result_ttl: 0,
                        status: TStatus {
                            code: TCode::OK,
                            message: execute_response_grpc.message,
                            ..Default::default()
                        },
                        cached_result: execute_response_grpc.cached_result,
                        action_digest: Default::default(),
                    };

                    ExecuteWithProgressResponse {
                        stage: Stage::COMPLETED,
                        execute_response: Some(execute_response),
                        ..Default::default()
                    }
                }
            }
        } else {
            let meta =
                ExecuteOperationMetadata::decode(&msg.metadata.unwrap_or_default().value[..])?;

            let stage = match execution_stage::Value::try_from(meta.stage) {
                Ok(execution_stage::Value::Unknown) => Stage::UNKNOWN,
                Ok(execution_stage::Value::CacheCheck) => Stage::CACHE_CHECK,
                Ok(execution_stage::Value::Queued) => Stage::QUEUED,
                Ok(execution_stage::Value::Executing) => Stage::EXECUTING,
                Ok(execution_stage::Value::Completed) => Stage::COMPLETED,
                _ => Stage::UNKNOWN,
            };

            ExecuteWithProgressResponse {
                stage,
                execute_response: None,
                ..Default::default()
            }
        };

        anyhow::Ok(Some((status, stream)))
    });

    let stream = stream.map(move |mut r| {
        match &mut r {
            Ok(ExecuteWithProgressResponse {
                execute_response: Some(response),
                ..
            }) => {
                response.action_digest = std::mem::take(&mut execute_request.action_digest);
            }
            _ => {}
        };

        r
    });

    Ok(stream.boxed())
}
