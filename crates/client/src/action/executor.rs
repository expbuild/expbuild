use std::path::PathBuf;
use std::time::Duration;

use futures::StreamExt;

use crate::action::builder::ActionBuilder;
use crate::action::directory::DirectoryBuilder;
use crate::action::error::ActionError;
use crate::action::result::ResultProcessor;
use crate::action::types::{CommandSpec, ExecutionMetadata, OutputDirectoryInfo, OutputFileInfo};
use crate::client::REClient;
use crate::digest::TDigest;
use crate::metadata::RemoteExecutionMetadata;
use crate::request::ExecuteRequest as REExecuteRequest;
use crate::response::{ExecuteResponse, Stage};

pub struct ActionExecutor {
    client: REClient,
}

#[derive(Debug, Clone)]
pub struct ExecutionRequest {
    pub command_spec: CommandSpec,
    pub input_directory: Option<PathBuf>,
    pub output_directory: PathBuf,
    pub skip_cache_lookup: bool,
    pub timeout: Option<Duration>,
}

#[derive(Debug, Clone)]
pub struct ExecutionProgress {
    pub stage: Stage,
    pub worker: Option<String>,
    pub cached_result: bool,
}

#[derive(Debug, Clone)]
pub struct ExecutionResult {
    pub exit_code: i32,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub output_files: Vec<OutputFileInfo>,
    pub output_directories: Vec<OutputDirectoryInfo>,
    pub execution_metadata: ExecutionMetadata,
    pub cached_result: bool,
}

impl ActionExecutor {
    pub fn new(client: REClient) -> Self {
        Self { client }
    }

    pub async fn execute<F>(
        &self,
        request: ExecutionRequest,
        metadata: RemoteExecutionMetadata,
        progress_callback: F,
    ) -> Result<ExecutionResult, ActionError>
    where
        F: FnMut(ExecutionProgress),
    {
        tracing::info!("Starting action execution");
        
        let action_digest = self.prepare_action(&request, &metadata).await?;
        
        tracing::info!("Action prepared with digest: {}", action_digest);
        
        self.execute_action_digest(
            action_digest,
            Some(request.output_directory),
            metadata,
            progress_callback,
        )
        .await
    }

    pub async fn execute_action_digest<F>(
        &self,
        action_digest: TDigest,
        output_directory: Option<PathBuf>,
        metadata: RemoteExecutionMetadata,
        mut progress_callback: F,
    ) -> Result<ExecutionResult, ActionError>
    where
        F: FnMut(ExecutionProgress),
    {
        let execute_request = REExecuteRequest {
            action_digest: action_digest.clone(),
            skip_cache_lookup: false,
            ..Default::default()
        };

        let mut stream = self
            .client
            .execute_with_progress(metadata.clone(), execute_request)
            .await?;

        let mut final_response: Option<ExecuteResponse> = None;

        while let Some(progress_result) = stream.next().await {
            match progress_result {
                Ok(progress) => {
                    progress_callback(ExecutionProgress {
                        stage: progress.stage,
                        worker: None,
                        cached_result: false,
                    });

                    if let Some(response) = progress.execute_response {
                        final_response = Some(response);
                        break;
                    }
                }
                Err(e) => {
                    return Err(ActionError::AnyhowError(e));
                }
            }
        }

        let response = final_response.ok_or_else(|| {
            ActionError::ExecutionFailed {
                exit_code: -1,
                message: "No execution response received".to_string(),
                stdout: Vec::new(),
                stderr: Vec::new(),
            }
        })?;

        self.process_results(response, output_directory.as_deref(), &metadata)
            .await
    }

    async fn prepare_action(
        &self,
        request: &ExecutionRequest,
        metadata: &RemoteExecutionMetadata,
    ) -> Result<TDigest, ActionError> {
        let input_root_digest = if let Some(ref input_dir) = request.input_directory {
            tracing::info!("Scanning input directory: {}", input_dir.display());
            let mut dir_builder = DirectoryBuilder::from_directory(input_dir).await?;
            let root_digest = dir_builder.build()?;

            tracing::info!("Uploading input files and directories");
            self.client
                .upload_directory_tree(
                    dir_builder.directories_to_upload(),
                    dir_builder.files_to_upload().to_vec(),
                    metadata.clone(),
                )
                .await?;

            root_digest
        } else {
            let empty_dir = DirectoryBuilder::new();
            empty_dir.root_digest().unwrap_or_default()
        };

        let action_builder = ActionBuilder::new(request.command_spec.clone())
            .with_input_root(input_root_digest)
            .with_timeout(request.timeout.unwrap_or(Duration::from_secs(600)));

        let (command, command_digest) = action_builder.build_command()?;
        tracing::info!("Uploading command with digest: {}", command_digest);
        self.client
            .upload_command(command, metadata.clone())
            .await?;

        let (action, action_digest) = action_builder.build_action(command_digest)?;
        tracing::info!("Uploading action with digest: {}", action_digest);
        self.client
            .upload_action(action, metadata.clone())
            .await?;

        Ok(action_digest)
    }

    async fn process_results(
        &self,
        response: ExecuteResponse,
        output_directory: Option<&std::path::Path>,
        metadata: &RemoteExecutionMetadata,
    ) -> Result<ExecutionResult, ActionError> {
        let action_result = &response.action_result;

        let stdout = action_result.stdout_raw.clone().unwrap_or_default();
        let stderr = action_result.stderr_raw.clone().unwrap_or_default();

        let output_files: Vec<OutputFileInfo> = action_result
            .output_files
            .iter()
            .map(|f| OutputFileInfo {
                path: f.name.clone(),
                digest: f.digest.digest.clone(),
                size_bytes: f.digest.digest.size_in_bytes,
                is_executable: f.executable,
            })
            .collect();

        let output_directories: Vec<OutputDirectoryInfo> = action_result
            .output_directories
            .iter()
            .map(|d| OutputDirectoryInfo {
                path: d.path.clone(),
                tree_digest: d.tree_digest.clone(),
            })
            .collect();

        if let Some(output_dir) = output_directory {
            tracing::info!("Downloading outputs to: {}", output_dir.display());
            let processor = ResultProcessor::new(self.client.clone());
            processor
                .download_outputs(action_result, output_dir, metadata.clone())
                .await?;
        }

        Ok(ExecutionResult {
            exit_code: action_result.exit_code,
            stdout,
            stderr,
            output_files,
            output_directories,
            execution_metadata: ExecutionMetadata::default(),
            cached_result: response.cached_result,
        })
    }
}
