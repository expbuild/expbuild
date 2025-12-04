use prost::Message;
use re_grpc_proto::build::bazel::remote::execution::v2::{Action, Command, Platform};

use crate::action::error::ActionError;
use crate::action::types::CommandSpec;
use crate::digest::TDigest;

pub fn command_spec_to_proto(spec: &CommandSpec) -> Result<Command, ActionError> {
    let mut env_vars: Vec<_> = spec
        .environment_variables
        .iter()
        .map(|(name, value)| {
            re_grpc_proto::build::bazel::remote::execution::v2::command::EnvironmentVariable {
                name: name.clone(),
                value: value.clone(),
            }
        })
        .collect();

    env_vars.sort_by(|a, b| a.name.cmp(&b.name));

    let mut output_paths = spec.output_paths.clone();
    output_paths.sort();
    output_paths.dedup();

    Ok(Command {
        arguments: spec.arguments.clone(),
        environment_variables: env_vars,
        output_paths,
        working_directory: spec.working_directory.clone().unwrap_or_default(),
        output_node_properties: Vec::new(),
        output_directory_format: 0,
        ..Default::default()
    })
}

pub fn compute_command_digest(command: &Command) -> Result<TDigest, ActionError> {
    let mut buf = Vec::new();
    command
        .encode(&mut buf)
        .map_err(|e| ActionError::PreparationFailed(format!("Failed to encode Command: {}", e)))?;

    Ok(crate::digest::compute_digest(&buf))
}

pub fn build_action_proto(
    command_digest: TDigest,
    input_root_digest: TDigest,
    timeout: Option<std::time::Duration>,
    do_not_cache: bool,
    platform: Option<Platform>,
) -> Action {
    let timeout_proto = timeout.map(|d| prost_types::Duration {
        seconds: d.as_secs() as i64,
        nanos: d.subsec_nanos() as i32,
    });

    Action {
        command_digest: Some(re_grpc_proto::build::bazel::remote::execution::v2::Digest {
            hash: command_digest.hash,
            size_bytes: command_digest.size_in_bytes,
        }),
        input_root_digest: Some(re_grpc_proto::build::bazel::remote::execution::v2::Digest {
            hash: input_root_digest.hash,
            size_bytes: input_root_digest.size_in_bytes,
        }),
        timeout: timeout_proto,
        do_not_cache,
        salt: Vec::new(),
        platform,
    }
}

pub fn compute_action_digest(action: &Action) -> Result<TDigest, ActionError> {
    let mut buf = Vec::new();
    action
        .encode(&mut buf)
        .map_err(|e| ActionError::PreparationFailed(format!("Failed to encode Action: {}", e)))?;

    Ok(crate::digest::compute_digest(&buf))
}
