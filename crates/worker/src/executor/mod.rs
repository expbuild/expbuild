use anyhow::Result;
use async_trait::async_trait;
use re_grpc_proto::build::bazel::remote::execution::v2::{Command, OutputFile};
use std::path::PathBuf;
use std::time::Duration;

pub mod host;
pub mod docker;
pub mod types;

#[cfg(test)]
mod tests;

pub use host::{HostExecutor, HostExecutorConfig};
pub use docker::{DockerExecutor, DockerExecutorConfig};
pub use types::*;

#[async_trait]
pub trait TaskExecutor: Send + Sync {
    async fn execute(&self, request: ExecutionRequest) -> Result<ExecutionResult>;
    
    fn isolation_level(&self) -> IsolationLevel;
    
    async fn health_check(&self) -> Result<()>;
    
    async fn warmup(&self) -> Result<()>;
    
    fn capabilities(&self) -> ExecutorCapabilities;
}

pub struct ExecutionRequest {
    pub command: Command,
    pub work_dir: PathBuf,
    pub resource_limits: ResourceLimits,
    pub timeout: Duration,
}

pub struct ExecutionResult {
    pub exit_code: i32,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub output_files: Vec<OutputFile>,
    pub stats: ExecutionStats,
}
