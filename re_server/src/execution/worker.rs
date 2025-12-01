use anyhow::Result;
use async_trait::async_trait;
use re_grpc_proto::build::bazel::remote::execution::v2::{
    Action, Command, Digest, OutputDirectory, OutputFile, Platform,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, SystemTime};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorkerState {
    Idle,
    Busy,
    Draining,
    Unhealthy,
    Offline,
}

#[derive(Debug, Clone)]
pub struct WorkerCapabilities {
    pub platform_properties: HashMap<String, String>,
    pub max_concurrent_executions: usize,
    pub resources: WorkerResources,
}

#[derive(Debug, Clone)]
pub struct WorkerResources {
    pub cpu_cores: f64,
    pub memory_bytes: u64,
    pub disk_bytes: u64,
}

#[derive(Debug, Clone)]
pub struct WorkerHealth {
    pub healthy: bool,
    pub message: String,
    pub last_check: SystemTime,
}

#[derive(Debug, Clone)]
pub struct WorkerExecutionRequest {
    pub task_id: String,
    pub action: Action,
    pub command: Command,
    pub input_root_digest: Digest,
    pub platform: Option<Platform>,
    pub timeout: Duration,
    pub paths: ExecutionPaths,
}

#[derive(Debug, Clone)]
pub struct ExecutionPaths {
    pub work_dir: PathBuf,
    pub input_root: PathBuf,
    pub output_dir: PathBuf,
}

#[derive(Debug)]
pub struct WorkerExecutionResult {
    pub exit_code: i32,
    pub stdout: OutputContent,
    pub stderr: OutputContent,
    pub output_files: Vec<OutputFile>,
    pub output_directories: Vec<OutputDirectory>,
    pub execution_metadata: ExecutionMetadata,
}

#[derive(Debug)]
pub enum OutputContent {
    Inline(Vec<u8>),
    Digest(Digest),
}

#[derive(Debug, Clone)]
pub struct ExecutionMetadata {
    pub worker_id: String,
    pub start_time: SystemTime,
    pub end_time: SystemTime,
    pub execution_duration: Duration,
    pub queue_duration: Duration,
}

#[async_trait]
pub trait Worker: Send + Sync {
    async fn execute(&self, request: WorkerExecutionRequest) -> Result<WorkerExecutionResult>;
    
    fn worker_id(&self) -> &str;
    
    fn capabilities(&self) -> &WorkerCapabilities;
    
    async fn health_check(&self) -> Result<WorkerHealth>;
    
    async fn shutdown(&self) -> Result<()>;
    
    fn state(&self) -> WorkerState;
}

pub type DynWorker = Arc<dyn Worker>;

#[derive(Debug, Clone)]
pub struct ExecutionTask {
    pub task_id: String,
    pub operation_name: String,
    pub action: Action,
    pub command: Command,
    pub input_root_digest: Digest,
    pub platform: Option<Platform>,
    pub timeout: Duration,
}

#[derive(Debug, Clone)]
pub struct TaskHandle {
    pub task_id: String,
    pub operation_name: String,
}

#[derive(Debug, Clone, Default)]
pub struct WorkerPoolStats {
    pub total_workers: usize,
    pub idle_workers: usize,
    pub busy_workers: usize,
    pub queued_tasks: usize,
    pub completed_tasks: u64,
    pub failed_tasks: u64,
}

#[async_trait]
pub trait WorkerPool: Send + Sync {
    async fn submit_task(&self, task: ExecutionTask) -> Result<TaskHandle>;
    
    async fn wait_for_task(&self, handle: TaskHandle) -> Result<WorkerExecutionResult>;
    
    async fn cancel_task(&self, handle: &TaskHandle) -> Result<()>;
    
    async fn get_stats(&self) -> WorkerPoolStats;
    
    async fn shutdown(&self) -> Result<()>;
}

pub type DynWorkerPool = Arc<dyn WorkerPool>;
