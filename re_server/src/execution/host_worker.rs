use super::worker::*;
use crate::cas::CasManager;
use anyhow::{Context, Result};
use async_trait::async_trait;
use re_grpc_proto::build::bazel::remote::execution::v2::{Digest, OutputDirectory, OutputFile};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::SystemTime;
use tokio::fs;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use tokio::sync::RwLock;

#[derive(Debug, Clone)]
pub struct HostWorkerConfig {
    pub work_dir: PathBuf,
    pub use_chroot: bool,
    pub env_whitelist: Vec<String>,
    pub run_as_user: Option<String>,
    pub run_as_group: Option<String>,
}

impl Default for HostWorkerConfig {
    fn default() -> Self {
        Self {
            work_dir: PathBuf::from("/tmp/expbuild-workers/host"),
            use_chroot: false,
            env_whitelist: vec![
                "PATH".to_string(),
                "HOME".to_string(),
                "USER".to_string(),
                "TMPDIR".to_string(),
            ],
            run_as_user: None,
            run_as_group: None,
        }
    }
}

pub struct HostWorker {
    worker_id: String,
    capabilities: WorkerCapabilities,
    config: HostWorkerConfig,
    cas_manager: Arc<CasManager>,
    state: Arc<RwLock<WorkerState>>,
}

struct Workspace {
    root: PathBuf,
    input_root: PathBuf,
    work_dir: PathBuf,
    output_dir: PathBuf,
}

impl HostWorker {
    pub fn new(
        worker_id: String,
        config: HostWorkerConfig,
        cas_manager: Arc<CasManager>,
    ) -> Self {
        let capabilities = WorkerCapabilities {
            platform_properties: {
                let mut props = HashMap::new();
                props.insert("OSFamily".to_string(), std::env::consts::OS.to_string());
                props.insert("Arch".to_string(), std::env::consts::ARCH.to_string());
                props
            },
            max_concurrent_executions: 1,
            resources: WorkerResources {
                cpu_cores: num_cpus::get() as f64,
                memory_bytes: sys_info::mem_info()
                    .map(|m| m.total * 1024)
                    .unwrap_or(8 * 1024 * 1024 * 1024),
                disk_bytes: 100 * 1024 * 1024 * 1024,
            },
        };

        Self {
            worker_id,
            capabilities,
            config,
            cas_manager,
            state: Arc::new(RwLock::new(WorkerState::Idle)),
        }
    }

    async fn create_workspace(&self, task_id: &str) -> Result<Workspace> {
        let root = self.config.work_dir.join(task_id);
        let work_dir = root.join("work");
        let output_dir = root.join("outputs");

        fs::create_dir_all(&root).await?;
        fs::create_dir_all(&work_dir).await?;
        fs::create_dir_all(&output_dir).await?;

        Ok(Workspace {
            root,
            input_root: work_dir.clone(),
            work_dir,
            output_dir,
        })
    }

    async fn download_inputs(&self, digest: &Digest, target_dir: &Path) -> Result<()> {
        self.download_inputs_recursive(digest, target_dir).await
    }
    
    fn download_inputs_recursive<'a>(
        &'a self,
        digest: &'a Digest,
        target_dir: &'a Path,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<()>> + Send + 'a>> {
        Box::pin(async move {
            let directory = self.cas_manager.get_directory(digest).await?;

            for file_node in &directory.files {
                let file_digest = file_node
                    .digest
                    .as_ref()
                    .context("File node missing digest")?;
                let file_data = self.cas_manager.get_blob(file_digest).await?;

                let file_path = target_dir.join(&file_node.name);
                let mut file = fs::File::create(&file_path).await?;
                file.write_all(&file_data).await?;

                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    if file_node.is_executable {
                        let perms = std::fs::Permissions::from_mode(0o755);
                        std::fs::set_permissions(&file_path, perms)?;
                    }
                }
            }

            for dir_node in &directory.directories {
                let dir_digest = dir_node
                    .digest
                    .as_ref()
                    .context("Directory node missing digest")?;
                let dir_path = target_dir.join(&dir_node.name);
                fs::create_dir_all(&dir_path).await?;

                self.download_inputs_recursive(dir_digest, &dir_path).await?;
            }

            Ok(())
        })
    }

    fn filter_environment(
        &self,
        env_vars: &[re_grpc_proto::build::bazel::remote::execution::v2::command::EnvironmentVariable],
    ) -> HashMap<String, String> {
        let mut filtered = HashMap::new();

        for env_var in env_vars {
            if self.config.env_whitelist.contains(&env_var.name) {
                filtered.insert(env_var.name.clone(), env_var.value.clone());
            }
        }

        filtered
    }

    async fn collect_outputs(
        &self,
        work_dir: &Path,
        output_paths: &[String],
    ) -> Result<Vec<OutputFile>> {
        let mut output_files = Vec::new();

        for output_path in output_paths {
            let full_path = work_dir.join(output_path);

            if !full_path.exists() {
                continue;
            }

            if full_path.is_file() {
                let data = fs::read(&full_path).await?;
                let digest = self.cas_manager.put_blob(data).await?;

                #[cfg(unix)]
                let is_executable = {
                    use std::os::unix::fs::PermissionsExt;
                    std::fs::metadata(&full_path)?.permissions().mode() & 0o111 != 0
                };

                #[cfg(not(unix))]
                let is_executable = false;

                output_files.push(OutputFile {
                    path: output_path.clone(),
                    digest: Some(digest),
                    is_executable,
                    contents: vec![],
                    node_properties: None,
                });
            }
        }

        Ok(output_files)
    }

    async fn handle_output_streams(
        &self,
        stdout: Vec<u8>,
        stderr: Vec<u8>,
    ) -> Result<(OutputContent, OutputContent)> {
        const MAX_INLINE_SIZE: usize = 1024 * 1024;

        let stdout_content = if stdout.len() > MAX_INLINE_SIZE {
            let digest = self.cas_manager.put_blob(stdout).await?;
            OutputContent::Digest(digest)
        } else {
            OutputContent::Inline(stdout)
        };

        let stderr_content = if stderr.len() > MAX_INLINE_SIZE {
            let digest = self.cas_manager.put_blob(stderr).await?;
            OutputContent::Digest(digest)
        } else {
            OutputContent::Inline(stderr)
        };

        Ok((stdout_content, stderr_content))
    }

    async fn cleanup_workspace(&self, workspace: &Workspace) -> Result<()> {
        if workspace.root.exists() {
            fs::remove_dir_all(&workspace.root).await?;
        }
        Ok(())
    }

    async fn execute_impl(
        &self,
        request: WorkerExecutionRequest,
    ) -> Result<WorkerExecutionResult> {
        let queue_start = SystemTime::now();

        tracing::info!(
            "[{}] Starting task execution: task_id={}",
            self.worker_id,
            request.task_id
        );

        tracing::debug!(
            "[{}] Creating workspace for task {}",
            self.worker_id,
            request.task_id
        );
        let workspace = self.create_workspace(&request.task_id).await?;

        tracing::debug!(
            "[{}] Downloading inputs: digest={}/{}",
            self.worker_id,
            request.input_root_digest.hash,
            request.input_root_digest.size_bytes
        );
        self.download_inputs(&request.input_root_digest, &workspace.input_root)
            .await?;

        if request.command.arguments.is_empty() {
            anyhow::bail!("Command has no arguments");
        }

        tracing::info!(
            "[{}] Creating output directories for {} output paths",
            self.worker_id,
            request.command.output_paths.len()
        );
        for output_path in &request.command.output_paths {
            let full_output_path = workspace.work_dir.join(output_path);
            if let Some(parent) = full_output_path.parent() {
                if !parent.exists() {
                    tracing::debug!(
                        "[{}] Creating output directory: {:?}",
                        self.worker_id,
                        parent
                    );
                    fs::create_dir_all(parent).await?;
                }
            }
        }

        tracing::info!(
            "[{}] Executing command: {:?}",
            self.worker_id,
            request.command.arguments
        );

        let mut cmd = Command::new(&request.command.arguments[0]);
        cmd.args(&request.command.arguments[1..]);
        cmd.current_dir(&workspace.work_dir);
        cmd.envs(self.filter_environment(&request.command.environment_variables));

        let start_time = SystemTime::now();
        let output = tokio::time::timeout(request.timeout, cmd.output()).await??;
        let end_time = SystemTime::now();
        
        let duration = end_time.duration_since(start_time)?;
        tracing::info!(
            "[{}] Command completed: exit_code={}, duration={:.2}s",
            self.worker_id,
            output.status.code().unwrap_or(-1),
            duration.as_secs_f64()
        );

        tracing::info!(
            "[{}] Collecting {} output paths",
            self.worker_id,
            request.command.output_paths.len()
        );
        tracing::info!(
            "[{}] Output paths from command: {:?}",
            self.worker_id,
            request.command.output_paths
        );
        tracing::info!(
            "[{}] Working directory: {:?}",
            self.worker_id,
            workspace.work_dir
        );
        let output_files = self
            .collect_outputs(&workspace.work_dir, &request.command.output_paths)
            .await?;
        
        tracing::debug!(
            "[{}] Collected {} output files",
            self.worker_id,
            output_files.len()
        );

        let (stdout, stderr) = self
            .handle_output_streams(output.stdout, output.stderr)
            .await?;

        tracing::debug!(
            "[{}] Cleaning up workspace",
            self.worker_id
        );
        self.cleanup_workspace(&workspace).await?;

        Ok(WorkerExecutionResult {
            exit_code: output.status.code().unwrap_or(-1),
            stdout,
            stderr,
            output_files,
            output_directories: vec![],
            execution_metadata: ExecutionMetadata {
                worker_id: self.worker_id.clone(),
                start_time,
                end_time,
                execution_duration: end_time.duration_since(start_time)?,
                queue_duration: start_time.duration_since(queue_start)?,
            },
        })
    }
}

#[async_trait]
impl Worker for HostWorker {
    async fn execute(&self, request: WorkerExecutionRequest) -> Result<WorkerExecutionResult> {
        *self.state.write().await = WorkerState::Busy;

        let result = self.execute_impl(request).await;
        
        match &result {
            Ok(res) => {
                tracing::info!(
                    "[{}] Task execution succeeded: exit_code={}, execution_time={:.2}s",
                    self.worker_id,
                    res.exit_code,
                    res.execution_metadata.execution_duration.as_secs_f64()
                );
            }
            Err(e) => {
                tracing::error!(
                    "[{}] Task execution failed: {}",
                    self.worker_id,
                    e
                );
            }
        }

        *self.state.write().await = WorkerState::Idle;

        result
    }

    fn worker_id(&self) -> &str {
        &self.worker_id
    }

    fn capabilities(&self) -> &WorkerCapabilities {
        &self.capabilities
    }

    async fn health_check(&self) -> Result<WorkerHealth> {
        Ok(WorkerHealth {
            healthy: true,
            message: "Host worker is healthy".to_string(),
            last_check: SystemTime::now(),
        })
    }

    async fn shutdown(&self) -> Result<()> {
        *self.state.write().await = WorkerState::Offline;
        Ok(())
    }

    fn state(&self) -> WorkerState {
        let state = self.state.try_read();
        match state {
            Ok(s) => s.clone(),
            Err(_) => WorkerState::Busy,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::FileSystemBlobStore;
    use tempfile::TempDir;

    #[tokio::test]
    async fn test_host_worker_simple_execution() {
        let temp_dir = TempDir::new().unwrap();
        let blob_store = Arc::new(FileSystemBlobStore::new(temp_dir.path().to_path_buf()));
        let cas_manager = Arc::new(CasManager::new(blob_store));

        let work_dir = temp_dir.path().join("work");
        let config = HostWorkerConfig {
            work_dir,
            ..Default::default()
        };

        let worker = HostWorker::new("test-worker-1".to_string(), config, cas_manager.clone());

        let empty_dir = re_grpc_proto::build::bazel::remote::execution::v2::Directory {
            files: vec![],
            directories: vec![],
            symlinks: vec![],
            node_properties: None,
        };
        let input_digest = cas_manager.put_directory(&empty_dir).await.unwrap();

        let command = re_grpc_proto::build::bazel::remote::execution::v2::Command {
            arguments: vec!["echo".to_string(), "hello".to_string()],
            environment_variables: vec![],
            output_paths: vec![],
            platform: None,
            working_directory: String::new(),
            output_files: vec![],
            output_directories: vec![],
            output_paths_v2: vec![],
            output_node_properties: vec![],
        };

        let request = WorkerExecutionRequest {
            task_id: "test-task-1".to_string(),
            action: re_grpc_proto::build::bazel::remote::execution::v2::Action {
                command_digest: None,
                input_root_digest: Some(input_digest.clone()),
                timeout: None,
                do_not_cache: false,
                salt: vec![],
                platform: None,
                output_node_properties: None,
            },
            command,
            input_root_digest: input_digest,
            platform: None,
            timeout: std::time::Duration::from_secs(10),
            paths: ExecutionPaths {
                work_dir: PathBuf::from("/tmp/test"),
                input_root: PathBuf::from("/tmp/test/inputs"),
                output_dir: PathBuf::from("/tmp/test/outputs"),
            },
        };

        let result = worker.execute(request).await.unwrap();

        assert_eq!(result.exit_code, 0);
        match result.stdout {
            OutputContent::Inline(data) => {
                assert_eq!(String::from_utf8_lossy(&data).trim(), "hello");
            }
            _ => panic!("Expected inline stdout"),
        }
    }
}
