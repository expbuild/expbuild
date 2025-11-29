use anyhow::Context;
use prost::Message;
use re_grpc_proto::build::bazel::remote::execution::v2::ActionResult;
use re_grpc_proto::build::bazel::remote::execution::v2::ExecutedActionMetadata;
use re_grpc_proto::build::bazel::remote::execution::v2::OutputDirectory;
use re_grpc_proto::build::bazel::remote::execution::v2::OutputFile;
use re_grpc_proto::build::bazel::remote::execution::v2::OutputSymlink;
use re_grpc_proto::build::bazel::remote::execution::v2::RequestMetadata;
use re_grpc_proto::build::bazel::remote::execution::v2::ToolDetails;
use tonic::metadata::MetadataValue;

use crate::metadata::*;
use crate::response::*;
use crate::digest::TDigest;

pub(crate) fn convert_action_result(action_result: ActionResult) -> anyhow::Result<TActionResult2> {
    let execution_metadata = action_result
        .execution_metadata
        .with_context(|| "The execution metadata are not defined.")?;

    let output_files: Result<Vec<_>, _> = action_result
        .output_files
        .into_iter()
        .map(|output_file| {
        let output_file_digest = output_file.digest.with_context(|| "Digest not found.")?;

        anyhow::Ok(TFile {
            digest: DigestWithStatus {
                status: TStatus::ok(),
                digest: TDigest::from_grpc(output_file_digest),
                _dot_dot_default: (),
            },
            name: output_file.path,
            existed: false,
            executable: output_file.is_executable,
            ttl: 0,
            _dot_dot_default: (),
        })
    })
        .collect();
    let output_files = output_files?;

    let output_symlinks: Result<Vec<_>, _> = action_result
        .output_symlinks
        .into_iter()
        .map(|output_symlink| {
            anyhow::Ok(TSymlink {
                name: output_symlink.path,
                target: output_symlink.target,
                _dot_dot_default: (),
            })
        })
        .collect();
    let output_symlinks = output_symlinks?;

    let output_directories: Result<Vec<_>, _> = action_result
        .output_directories
        .into_iter()
        .map(|output_directory| {
            let digest = TDigest::from_grpc(
                output_directory
                    .tree_digest
                    .with_context(|| "Tree digest not defined.")?,
            );
            anyhow::Ok(TDirectory2 {
                path: output_directory.path,
                tree_digest: digest.clone(),
                root_directory_digest: digest,
                _dot_dot_default: (),
            })
        })
        .collect();
    let output_directories = output_directories?;

    let action_result = TActionResult2 {
        output_files,
        output_symlinks,
        output_directories,
        exit_code: action_result.exit_code,
        stdout_raw: Some(action_result.stdout_raw),
        stdout_digest: action_result.stdout_digest.map(TDigest::from_grpc),
        stderr_raw: Some(action_result.stderr_raw),
        stderr_digest: action_result.stderr_digest.map(TDigest::from_grpc),

        execution_metadata: TExecutedActionMetadata {
            worker: execution_metadata.worker,
            queued_timestamp: TTimestamp::from_grpc(execution_metadata.queued_timestamp),
            worker_start_timestamp: TTimestamp::from_grpc(execution_metadata.worker_start_timestamp),
            worker_completed_timestamp: TTimestamp::from_grpc(
                execution_metadata.worker_completed_timestamp,
            ),
            input_fetch_start_timestamp: TTimestamp::from_grpc(
                execution_metadata.input_fetch_start_timestamp,
            ),
            input_fetch_completed_timestamp: TTimestamp::from_grpc(
                execution_metadata.input_fetch_completed_timestamp,
            ),
            execution_start_timestamp: TTimestamp::from_grpc(
                execution_metadata.execution_start_timestamp,
            ),
            execution_completed_timestamp: TTimestamp::from_grpc(
                execution_metadata.execution_completed_timestamp,
            ),
            output_upload_start_timestamp: TTimestamp::from_grpc(
                execution_metadata.output_upload_start_timestamp,
            ),
            output_upload_completed_timestamp: TTimestamp::from_grpc(
                execution_metadata.output_upload_completed_timestamp,
            ),
            input_analyzing_start_timestamp: Default::default(),
            input_analyzing_completed_timestamp: Default::default(),
            execution_dir: "".to_owned(),
            execution_attempts: 0,
            last_queued_timestamp: Default::default(),
            ..Default::default()
        },
        ..Default::default()
    };

    Ok(action_result)
}

pub(crate) fn convert_t_action_result2(t_action_result: TActionResult2) -> anyhow::Result<ActionResult> {
    let t_execution_metadata = t_action_result.execution_metadata;
    let virtual_execution_duration = prost_types::Duration::try_from(
        t_execution_metadata
            .execution_completed_timestamp
            .saturating_duration_since(&t_execution_metadata.execution_start_timestamp),
    )?;
    let execution_metadata = Some(ExecutedActionMetadata {
        worker: t_execution_metadata.worker,
        queued_timestamp: Some(t_execution_metadata.queued_timestamp.to_grpc()),
        worker_start_timestamp: Some(t_execution_metadata.worker_start_timestamp.to_grpc()),
        worker_completed_timestamp: Some(
            t_execution_metadata.worker_completed_timestamp.to_grpc(),
        ),
        input_fetch_start_timestamp: Some(
            t_execution_metadata.input_fetch_start_timestamp.to_grpc(),
        ),
        input_fetch_completed_timestamp: Some(
            t_execution_metadata.input_fetch_completed_timestamp.to_grpc(),
        ),
        execution_start_timestamp: Some(
            t_execution_metadata.execution_start_timestamp.to_grpc(),
        ),
        execution_completed_timestamp: Some(
            t_execution_metadata.execution_completed_timestamp.to_grpc(),
        ),
        virtual_execution_duration: Some(virtual_execution_duration),
        output_upload_start_timestamp: Some(
            t_execution_metadata.output_upload_start_timestamp.to_grpc(),
        ),
        output_upload_completed_timestamp: Some(
            t_execution_metadata.output_upload_completed_timestamp.to_grpc(),
        ),
        auxiliary_metadata: Vec::new(),
    });

    let output_files = t_action_result
        .output_files
        .into_iter()
        .map(|output_file| OutputFile {
            path: output_file.name,
            digest: Some(output_file.digest.digest.to_grpc()),
            is_executable: output_file.executable,
            contents: Vec::new(),
            node_properties: None,
        })
        .collect();

    let output_symlinks =
        t_action_result
            .output_symlinks
            .into_iter()
            .map(|output_symlink| OutputSymlink {
                path: output_symlink.name,
                target: output_symlink.target,
                node_properties: None,
            })
            .collect();

    let output_directories = t_action_result
        .output_directories
        .into_iter()
        .map(|output_directory| {
            let digest = output_directory.tree_digest.to_grpc();
            OutputDirectory {
                path: output_directory.path,
                tree_digest: Some(digest.clone()),
                is_topologically_sorted: false,
                root_directory_digest: None,
            }
        })
        .collect();

    let action_result = ActionResult {
        output_files,
        output_symlinks,
        output_directories,
        exit_code: t_action_result.exit_code,
        stdout_raw: Vec::new(),
        stdout_digest: t_action_result.stdout_digest.map(|d| d.to_grpc()),
        stderr_raw: Vec::new(),
        stderr_digest: t_action_result.stderr_digest.map(|d| d.to_grpc()),
        execution_metadata,
        ..Default::default()
    };

    Ok(action_result)
}

pub(crate) fn with_re_metadata<T>(
    t: T,
    metadata: RemoteExecutionMetadata,
    use_fbcode_metadata: bool,
) -> tonic::Request<T> {
    let mut msg = tonic::Request::new(t);

    if use_fbcode_metadata {
        #[derive(prost::Message)]
        struct Metadata {
            #[prost(message, optional, tag = "15")]
            platform: Option<crate::grpc::Platform>,
            #[prost(string, optional, tag = "18")]
            use_case_id: Option<String>,
        }

        let mut encoded = Vec::new();
        Metadata {
            platform: metadata.platform,
            use_case_id: Some(metadata.use_case_id),
        }
        .encode(&mut encoded)
        .expect("Encoding into a Vec cannot not fail");

        msg.metadata_mut()
            .insert_bin("re-metadata-bin", MetadataValue::from_bytes(&encoded));
    } else {
        let mut encoded = Vec::new();
        RequestMetadata {
            tool_details: Some(ToolDetails {
                tool_name: "expbuild".to_owned(),
                tool_version: "0.1.0".to_owned(),
            }),
            action_id: "".to_owned(),
            tool_invocation_id: metadata
                .invocation_info
                .map_or(String::new(), |invocation_info| invocation_info.build_id),
            correlated_invocations_id: "".to_owned(),
            action_mnemonic: "".to_owned(),
            target_id: "".to_owned(),
            configuration_id: "".to_owned(),
        }
        .encode(&mut encoded)
        .expect("Encoding into a Vec cannot not fail");

        msg.metadata_mut().insert_bin(
            "build.bazel.remote.execution.v2.requestmetadata-bin",
            MetadataValue::from_bytes(&encoded),
        );
    };
    msg
}
