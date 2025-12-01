use super::worker::*;
use crate::cas::CasManager;
use anyhow::{Context, Result};
use async_trait::async_trait;
use re_grpc_proto::build::bazel::remote::execution::v2::{Digest, OutputFile};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::SystemTime;
use tokio::fs;
use tokio::io::AsyncWriteExt;
use tokio::sync::RwLock;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DockerWorkerConfig {
    pub image: String,
    pub always_pull: bool,
    pub cpu_limit: Option<f64>,
    pub memory_limit: Option<u64>,
    pub network_mode: String,
    pub volumes: Vec<VolumeMount>,
    pub user: Option<String>,
    pub docker_host: Option<String>,
}

impl Default for DockerWorkerConfig {
    fn default() -> Self {
        Self {
            image: "alpine:latest".to_string(),
            always_pull: false,
            cpu_limit: None,
            memory_limit: None,
            network_mode: "none".to_string(),
            volumes: vec![],
            user: None,
            docker_host: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VolumeMount {
    pub host_path: PathBuf,
    pub container_path: PathBuf,
    pub read_only: bool,
}

pub struct DockerWorker {
    worker_id: String,
    capabilities: WorkerCapabilities,
    config: DockerWorkerConfig,
    cas_manager: Arc<CasManager>,
    state: Arc<RwLock<WorkerState>>,
}

impl DockerWorker {
    pub fn new(
        worker_id: String,
        config: DockerWorkerConfig,
        cas_manager: Arc<CasManager>,
    ) -> Self {
        let capabilities = WorkerCapabilities {
            platform_properties: {
                let mut props = HashMap::new();
                props.insert("container".to_string(), "docker".to_string());
                props.insert("OSFamily".to_string(), "Linux".to_string());
                props
            },
            max_concurrent_executions: 1,
            resources: WorkerResources {
                cpu_cores: config.cpu_limit.unwrap_or(2.0),
                memory_bytes: config.memory_limit.unwrap_or(4 * 1024 * 1024 * 1024),
                disk_bytes: 50 * 1024 * 1024 * 1024,
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
        let root = std::env::temp_dir().join("expbuild-docker").join(task_id);
        let input_root = root.join("inputs");
        let work_dir = root.join("work");
        let output_dir = root.join("outputs");

        fs::create_dir_all(&root).await?;
        fs::create_dir_all(&input_root).await?;
        fs::create_dir_all(&work_dir).await?;
        fs::create_dir_all(&output_dir).await?;

        Ok(Workspace {
            root,
            input_root,
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

    async fn cleanup_workspace(&self, workspace: &Workspace) -> Result<()> {
        if workspace.root.exists() {
            fs::remove_dir_all(&workspace.root).await?;
        }
        Ok(())
    }

    async fn execute_with_docker_command(
        &self,
        request: &WorkerExecutionRequest,
        workspace: &Workspace,
    ) -> Result<WorkerExecutionResult> {
        let container_name = format!("expbuild-{}", request.task_id);
        
        tracing::debug!(
            "[{}] Preparing Docker container: name={}, image={}",
            self.worker_id,
            container_name,
            self.config.image
        );

        let mut docker_args = vec![
            "run".to_string(),
            "--rm".to_string(),
            "--name".to_string(),
            container_name.clone(),
        ];

        if let Some(cpu) = self.config.cpu_limit {
            docker_args.push("--cpus".to_string());
            docker_args.push(cpu.to_string());
        }

        if let Some(mem) = self.config.memory_limit {
            docker_args.push("--memory".to_string());
            docker_args.push(format!("{}b", mem));
        }

        docker_args.push("--network".to_string());
        docker_args.push(self.config.network_mode.clone());

        docker_args.push("-v".to_string());
        docker_args.push(format!("{}:/workspace", workspace.work_dir.display()));

        for volume in &self.config.volumes {
            docker_args.push("-v".to_string());
            let ro = if volume.read_only { ":ro" } else { "" };
            docker_args.push(format!(
                "{}:{}{}",
                volume.host_path.display(),
                volume.container_path.display(),
                ro
            ));
        }

        docker_args.push("-w".to_string());
        docker_args.push("/workspace".to_string());

        if let Some(user) = &self.config.user {
            docker_args.push("--user".to_string());
            docker_args.push(user.clone());
        }

        for env_var in &request.command.environment_variables {
            docker_args.push("-e".to_string());
            docker_args.push(format!("{}={}", env_var.name, env_var.value));
        }

        docker_args.push(self.config.image.clone());

        docker_args.extend(request.command.arguments.clone());
        
        tracing::info!(
            "[{}] Running Docker command: {:?}",
            self.worker_id,
            request.command.arguments
        );
        tracing::debug!("[{}] Docker args: {:?}", self.worker_id, docker_args);

        let start_time = SystemTime::now();

        let output = tokio::time::timeout(
            request.timeout,
            tokio::process::Command::new("docker")
                .args(&docker_args)
                .output(),
        )
        .await??;

        let end_time = SystemTime::now();
        
        let duration = end_time.duration_since(start_time)?;
        tracing::info!(
            "[{}] Docker execution completed: exit_code={}, duration={:.2}s",
            self.worker_id,
            output.status.code().unwrap_or(-1),
            duration.as_secs_f64()
        );

        Ok(WorkerExecutionResult {
            exit_code: output.status.code().unwrap_or(-1),
            stdout: OutputContent::Inline(output.stdout),
            stderr: OutputContent::Inline(output.stderr),
            output_files: vec![],
            output_directories: vec![],
            execution_metadata: ExecutionMetadata {
                worker_id: self.worker_id.clone(),
                start_time,
                end_time,
                execution_duration: end_time.duration_since(start_time)?,
                queue_duration: std::time::Duration::from_secs(0),
            },
        })
    }

    async fn execute_impl(
        &self,
        request: WorkerExecutionRequest,
    ) -> Result<WorkerExecutionResult> {
        tracing::info!(
            "[{}] Starting Docker task execution: task_id={}",
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
        self.download_inputs(&request.input_root_digest, &workspace.work_dir)
            .await?;

        if self.config.always_pull {
            tracing::info!(
                "[{}] Pulling Docker image: {}",
                self.worker_id,
                self.config.image
            );
            let pull_output = tokio::process::Command::new("docker")
                .args(&["pull", &self.config.image])
                .output()
                .await?;

            if !pull_output.status.success() {
                anyhow::bail!(
                    "Failed to pull Docker image: {}",
                    String::from_utf8_lossy(&pull_output.stderr)
                );
            }
        }

        let mut result = self.execute_with_docker_command(&request, &workspace).await?;

        tracing::debug!(
            "[{}] Collecting {} output paths",
            self.worker_id,
            request.command.output_paths.len()
        );
        result.output_files = self
            .collect_outputs(&workspace.work_dir, &request.command.output_paths)
            .await?;
        
        tracing::debug!(
            "[{}] Collected {} output files",
            self.worker_id,
            result.output_files.len()
        );

        tracing::debug!(
            "[{}] Cleaning up workspace",
            self.worker_id
        );
        self.cleanup_workspace(&workspace).await?;

        Ok(result)
    }
}

struct Workspace {
    root: PathBuf,
    input_root: PathBuf,
    work_dir: PathBuf,
    output_dir: PathBuf,
}

#[async_trait]
impl Worker for DockerWorker {
    async fn execute(&self, request: WorkerExecutionRequest) -> Result<WorkerExecutionResult> {
        *self.state.write().await = WorkerState::Busy;

        let result = self.execute_impl(request).await;
        
        match &result {
            Ok(res) => {
                tracing::info!(
                    "[{}] Docker task execution succeeded: exit_code={}, execution_time={:.2}s",
                    self.worker_id,
                    res.exit_code,
                    res.execution_metadata.execution_duration.as_secs_f64()
                );
            }
            Err(e) => {
                tracing::error!(
                    "[{}] Docker task execution failed: {}",
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
        let output = tokio::process::Command::new("docker")
            .args(&["version"])
            .output()
            .await?;

        Ok(WorkerHealth {
            healthy: output.status.success(),
            message: if output.status.success() {
                "Docker worker is healthy".to_string()
            } else {
                format!("Docker check failed: {}", String::from_utf8_lossy(&output.stderr))
            },
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
