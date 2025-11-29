use std::path::Path;

use tokio::fs;

use crate::action::error::ActionError;
use crate::action::types::ExecutionMetadata;
use crate::client::REClient;
use crate::metadata::RemoteExecutionMetadata;
use crate::request::{DownloadRequest, NamedDigest, NamedDigestWithPermissions};
use crate::response::TActionResult2;

pub struct ResultProcessor {
    client: REClient,
}

impl ResultProcessor {
    pub fn new(client: REClient) -> Self {
        Self { client }
    }

    pub async fn download_outputs(
        &self,
        action_result: &TActionResult2,
        output_directory: &Path,
        metadata: RemoteExecutionMetadata,
    ) -> Result<(), ActionError> {
        fs::create_dir_all(output_directory).await?;

        let mut files_to_download = Vec::new();

        for output_file in &action_result.output_files {
            let file_path = output_directory.join(&output_file.name);
            
            if let Some(parent) = file_path.parent() {
                fs::create_dir_all(parent).await?;
            }

            files_to_download.push(NamedDigestWithPermissions {
                named_digest: NamedDigest {
                    name: file_path.to_string_lossy().to_string(),
                    digest: output_file.digest.digest.clone(),
                    _dot_dot: (),
                },
                is_executable: output_file.executable,
                _dot_dot: (),
            });
        }

        if !files_to_download.is_empty() {
            tracing::info!("Downloading {} output files", files_to_download.len());
            
            let download_request = DownloadRequest {
                inlined_digests: None,
                file_digests: Some(files_to_download),
                _dot_dot: (),
            };

            self.client
                .download(metadata.clone(), download_request)
                .await
                .map_err(|e| ActionError::OutputDownloadFailed(e.to_string()))?;
        }

        for output_dir in &action_result.output_directories {
            tracing::info!("Output directory: {}", output_dir.path);
        }

        Ok(())
    }

    pub async fn fetch_stdout_stderr(
        &self,
        action_result: &TActionResult2,
        _metadata: RemoteExecutionMetadata,
    ) -> Result<(Vec<u8>, Vec<u8>), ActionError> {
        let stdout = action_result.stdout_raw.clone().unwrap_or_default();
        let stderr = action_result.stderr_raw.clone().unwrap_or_default();

        Ok((stdout, stderr))
    }

    pub fn extract_metadata(_action_result: &TActionResult2) -> ExecutionMetadata {
        ExecutionMetadata::default()
    }
}
