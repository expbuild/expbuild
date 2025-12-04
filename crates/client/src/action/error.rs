use std::time::Duration;
use thiserror::Error;

use crate::digest::TDigest;

#[derive(Debug, Error)]
pub enum ActionError {
    #[error("Missing blob: {0}")]
    MissingBlob(TDigest),

    #[error("Action preparation failed: {0}")]
    PreparationFailed(String),

    #[error("Execution failed with exit code {exit_code}: {message}")]
    ExecutionFailed {
        exit_code: i32,
        message: String,
        stdout: Vec<u8>,
        stderr: Vec<u8>,
    },

    #[error("Execution timeout after {0:?}")]
    ExecutionTimeout(Duration),

    #[error("Output download failed: {0}")]
    OutputDownloadFailed(String),

    #[error("Invalid action specification: {0}")]
    InvalidSpec(String),

    #[error("gRPC error: {0}")]
    GrpcError(#[from] tonic::Status),

    #[error("IO error: {0}")]
    IoError(#[from] std::io::Error),

    #[error("Anyhow error: {0}")]
    AnyhowError(#[from] anyhow::Error),
}
