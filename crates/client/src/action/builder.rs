use std::time::Duration;

use re_grpc_proto::build::bazel::remote::execution::v2::{Action, Command, Platform};

use crate::action::error::ActionError;
use crate::action::proto::{
    build_action_proto, command_spec_to_proto, compute_action_digest, compute_command_digest,
};
use crate::action::types::CommandSpec;
use crate::digest::TDigest;

pub struct ActionBuilder {
    command_spec: CommandSpec,
    input_root_digest: Option<TDigest>,
    timeout: Option<Duration>,
    platform: Option<Platform>,
    do_not_cache: bool,
}

impl ActionBuilder {
    pub fn new(command_spec: CommandSpec) -> Self {
        Self {
            command_spec,
            input_root_digest: None,
            timeout: None,
            platform: None,
            do_not_cache: false,
        }
    }

    pub fn with_input_root(mut self, digest: TDigest) -> Self {
        self.input_root_digest = Some(digest);
        self
    }

    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = Some(timeout);
        self
    }

    pub fn with_platform(mut self, platform: Platform) -> Self {
        self.platform = Some(platform);
        self
    }

    pub fn do_not_cache(mut self, do_not_cache: bool) -> Self {
        self.do_not_cache = do_not_cache;
        self
    }

    pub fn build_command(&self) -> Result<(Command, TDigest), ActionError> {
        let command = command_spec_to_proto(&self.command_spec)?;
        let digest = compute_command_digest(&command)?;
        Ok((command, digest))
    }

    pub fn build_action(&self, command_digest: TDigest) -> Result<(Action, TDigest), ActionError> {
        let input_root_digest = self
            .input_root_digest
            .clone()
            .ok_or_else(|| ActionError::InvalidSpec("input_root_digest is required".to_string()))?;

        let action = build_action_proto(
            command_digest,
            input_root_digest,
            self.timeout,
            self.do_not_cache,
            self.platform.clone(),
        );

        let digest = compute_action_digest(&action)?;
        Ok((action, digest))
    }
}
