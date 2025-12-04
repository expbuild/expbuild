use anyhow::{Context, Result};
use async_trait::async_trait;
use bollard::container::*;
use bollard::image::*;
use bollard::models::HostConfig;
use bollard::Docker;
use futures::StreamExt;
use re_grpc_proto::build::bazel::remote::execution::v2::OutputFile;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::Instant;

use super::{
    ContainerLogs, ExecutionRequest, ExecutionResult, ExecutionStats, ExecutorCapabilities,
    IsolationLevel, NetworkPolicy, OutputFileInfo, ResourceLimits, TaskExecutor,
};

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct DockerExecutorConfig {
    pub image: String,

    #[serde(default)]
    pub always_pull: bool,

    #[serde(default = "default_network_mode")]
    pub network_mode: String,

    #[serde(default = "default_true")]
    pub readonly_rootfs: bool,

    #[serde(default = "default_true")]
    pub mount_tmpfs: bool,

    #[serde(default = "default_security_opts")]
    pub security_opts: Vec<String>,

    #[serde(default)]
    pub default_limits: ResourceLimits,

    pub socket_path: Option<String>,
}

fn default_network_mode() -> String {
    "none".to_string()
}

fn default_true() -> bool {
    true
}

fn default_security_opts() -> Vec<String> {
    vec!["no-new-privileges".to_string()]
}

impl Default for DockerExecutorConfig {
    fn default() -> Self {
        Self {
            image: "alpine:latest".to_string(),
            always_pull: false,
            network_mode: default_network_mode(),
            readonly_rootfs: true,
            mount_tmpfs: true,
            security_opts: default_security_opts(),
            default_limits: ResourceLimits::default(),
            socket_path: None,
        }
    }
}

pub struct DockerExecutor {
    docker: Docker,
    config: DockerExecutorConfig,
}

impl DockerExecutor {
    pub async fn new(config: DockerExecutorConfig) -> Result<Self> {
        let docker = if let Some(socket) = &config.socket_path {
            Docker::connect_with_socket(socket, 120, bollard::API_DEFAULT_VERSION)
                .context("Failed to connect to Docker socket")?
        } else {
            Docker::connect_with_local_defaults().context("Failed to connect to Docker daemon")?
        };

        docker
            .ping()
            .await
            .context("Failed to ping Docker daemon")?;

        tracing::info!("Connected to Docker daemon");

        if config.always_pull {
            Self::pull_image(&docker, &config.image).await?;
        }

        Ok(Self { docker, config })
    }

    async fn pull_image(docker: &Docker, image: &str) -> Result<()> {
        tracing::info!("Pulling Docker image: {}", image);

        let mut stream = docker.create_image(
            Some(CreateImageOptions {
                from_image: image,
                ..Default::default()
            }),
            None,
            None,
        );

        while let Some(result) = stream.next().await {
            let info = result.context("Failed to pull image")?;
            if let Some(progress) = info.progress {
                tracing::debug!("Pull progress: {}", progress);
            }
            if let Some(status) = info.status {
                tracing::debug!("Pull status: {}", status);
            }
        }

        tracing::info!("Image pulled successfully: {}", image);
        Ok(())
    }

    fn merge_limits(&self, request_limits: &ResourceLimits) -> ResourceLimits {
        ResourceLimits {
            cpu_cores: request_limits
                .cpu_cores
                .or(self.config.default_limits.cpu_cores),
            memory_bytes: request_limits
                .memory_bytes
                .or(self.config.default_limits.memory_bytes),
            disk_bytes: request_limits
                .disk_bytes
                .or(self.config.default_limits.disk_bytes),
            network: match &request_limits.network {
                NetworkPolicy::None => self.config.default_limits.network.clone(),
                other => other.clone(),
            },
            max_processes: request_limits
                .max_processes
                .or(self.config.default_limits.max_processes),
        }
    }

    fn build_env_vars(
        &self,
        env_vars: &[re_grpc_proto::build::bazel::remote::execution::v2::command::EnvironmentVariable],
    ) -> Vec<String> {
        env_vars
            .iter()
            .map(|ev| format!("{}={}", ev.name, ev.value))
            .collect()
    }

    fn build_container_config(&self, request: &ExecutionRequest) -> Result<Config<String>> {
        let work_dir_str = request.work_dir.to_string_lossy().to_string();
        let limits = self.merge_limits(&request.resource_limits);

        let mut tmpfs = HashMap::new();
        if self.config.mount_tmpfs {
            tmpfs.insert(
                "/tmp".to_string(),
                "rw,noexec,nosuid,size=100m".to_string(),
            );
        }

        Ok(Config {
            image: Some(self.config.image.clone()),
            cmd: Some(request.command.arguments.clone()),
            working_dir: Some("/workspace".to_string()),
            env: Some(self.build_env_vars(&request.command.environment_variables)),
            host_config: Some(HostConfig {
                binds: Some(vec![format!("{}:/workspace", work_dir_str)]),
                nano_cpus: limits.cpu_cores.map(|c| (c * 1_000_000_000.0) as i64),
                memory: limits.memory_bytes.map(|m| m as i64),
                memory_swap: limits.memory_bytes.map(|m| m as i64),
                network_mode: Some(self.config.network_mode.clone()),
                readonly_rootfs: Some(self.config.readonly_rootfs),
                tmpfs: if !tmpfs.is_empty() {
                    Some(tmpfs)
                } else {
                    None
                },
                security_opt: Some(self.config.security_opts.clone()),
                pids_limit: limits.max_processes.map(|p| p as i64),
                privileged: Some(false),
                auto_remove: Some(true),
                ..Default::default()
            }),
            ..Default::default()
        })
    }

    async fn get_container_logs(&self, container_id: &str) -> Result<ContainerLogs> {
        let log_options = LogsOptions::<String> {
            stdout: true,
            stderr: true,
            ..Default::default()
        };

        let mut stream = self.docker.logs(container_id, Some(log_options));
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();

        while let Some(log_result) = stream.next().await {
            match log_result {
                Ok(log) => match log {
                    bollard::container::LogOutput::StdOut { message } => {
                        stdout.extend_from_slice(&message);
                    }
                    bollard::container::LogOutput::StdErr { message } => {
                        stderr.extend_from_slice(&message);
                    }
                    _ => {}
                },
                Err(e) => {
                    tracing::warn!("Error reading container logs: {}", e);
                }
            }
        }

        Ok(ContainerLogs { stdout, stderr })
    }

    async fn collect_outputs(
        &self,
        container_id: &str,
        output_paths: &[String],
    ) -> Result<Vec<OutputFileInfo>> {
        let mut output_files = Vec::new();

        for output_path in output_paths {
            let path_in_container = format!("/workspace/{}", output_path);

            let mut stream = self.docker.download_from_container(
                container_id,
                Some(DownloadFromContainerOptions {
                    path: path_in_container.clone(),
                }),
            );

            let mut data = Vec::new();
            let mut found = false;

            while let Some(chunk_result) = stream.next().await {
                match chunk_result {
                    Ok(bytes) => {
                        found = true;
                        data.extend_from_slice(&bytes[..]);
                    }
                    Err(e) => {
                        tracing::debug!("Output file {} not found or error: {}", output_path, e);
                        break;
                    }
                }
            }

            if found && !data.is_empty() {
                let tar_data = Self::extract_from_tar(&data)?;
                output_files.push(OutputFileInfo {
                    path: output_path.clone(),
                    data: tar_data,
                    is_executable: false,
                });
            }
        }

        Ok(output_files)
    }

    fn extract_from_tar(tar_data: &[u8]) -> Result<Vec<u8>> {
        use std::io::Read;
        let mut archive = tar::Archive::new(tar_data);

        for entry_result in archive.entries()? {
            let mut entry = entry_result?;
            let mut contents = Vec::new();
            entry.read_to_end(&mut contents)?;
            return Ok(contents);
        }

        Ok(Vec::new())
    }

    async fn get_container_stats(&self, container_id: &str) -> Result<ExecutionStats> {
        let stats_options = StatsOptions {
            stream: false,
            one_shot: true,
        };

        let mut stream = self.docker.stats(container_id, Some(stats_options));

        if let Some(stats_result) = stream.next().await {
            let stats = stats_result.context("Failed to get container stats")?;

            let cpu_time_us = stats
                .cpu_stats
                .cpu_usage
                .total_usage
                .wrapping_div(1000);

            let peak_memory_bytes = stats.memory_stats.max_usage.unwrap_or(0);

            return Ok(ExecutionStats {
                cpu_time_us,
                peak_memory_bytes,
                ..Default::default()
            });
        }

        Ok(ExecutionStats::default())
    }
}

#[async_trait]
impl TaskExecutor for DockerExecutor {
    async fn execute(&self, request: ExecutionRequest) -> Result<ExecutionResult> {
        let start_time = Instant::now();

        let config = self
            .build_container_config(&request)
            .context("Failed to build container config")?;

        let container = self
            .docker
            .create_container::<String, String>(None, config)
            .await
            .context("Failed to create container")?;

        let container_id = &container.id;
        tracing::info!("Created container: {}", container_id);

        let docker_clone = self.docker.clone();
        let container_id_clone = container_id.clone();
        let _cleanup_guard = scopeguard::guard((), move |_| {
            tokio::spawn(async move {
                let _ = docker_clone
                    .remove_container(
                        &container_id_clone,
                        Some(RemoveContainerOptions {
                            force: true,
                            v: true,
                            ..Default::default()
                        }),
                    )
                    .await;
            });
        });

        self.docker
            .start_container::<String>(container_id, None)
            .await
            .context("Failed to start container")?;

        tracing::info!("Started container: {}", container_id);

        let wait_result = tokio::time::timeout(
            request.timeout,
            async {
                let mut stream = self.docker.wait_container::<String>(container_id, None);
                stream.next().await
            },
        )
        .await;

        let exit_code = match wait_result {
            Ok(Some(Ok(result))) => result.status_code,
            Ok(Some(Err(e))) => {
                tracing::error!("Container wait error: {}", e);
                -1
            }
            Ok(None) => {
                tracing::warn!("Container wait stream ended unexpectedly");
                -1
            }
            Err(_) => {
                tracing::warn!("Container timeout, killing...");
                let _ = self
                    .docker
                    .kill_container::<String>(container_id, None)
                    .await;
                -124
            }
        };

        let logs = self
            .get_container_logs(container_id)
            .await
            .unwrap_or_else(|e| {
                tracing::warn!("Failed to get container logs: {}", e);
                ContainerLogs {
                    stdout: Vec::new(),
                    stderr: Vec::new(),
                }
            });

        let output_file_infos = self
            .collect_outputs(container_id, &request.command.output_paths)
            .await
            .unwrap_or_else(|e| {
                tracing::warn!("Failed to collect output files: {}", e);
                Vec::new()
            });

        let stats = self
            .get_container_stats(container_id)
            .await
            .unwrap_or_default();

        let duration = start_time.elapsed();
        tracing::info!(
            "Container {} finished: exit_code={}, duration={:.2}s",
            container_id,
            exit_code,
            duration.as_secs_f64()
        );

        let output_files = output_file_infos
            .into_iter()
            .map(|info| OutputFile {
                path: info.path,
                digest: None,
                is_executable: info.is_executable,
                contents: info.data,
                node_properties: None,
            })
            .collect();

        Ok(ExecutionResult {
            exit_code: exit_code as i32,
            stdout: logs.stdout,
            stderr: logs.stderr,
            output_files,
            stats: ExecutionStats {
                duration,
                ..stats
            },
        })
    }

    fn isolation_level(&self) -> IsolationLevel {
        IsolationLevel::Container
    }

    async fn health_check(&self) -> Result<()> {
        self.docker
            .ping()
            .await
            .context("Docker daemon not responding")?;

        self.docker
            .inspect_image(&self.config.image)
            .await
            .context("Container image not found")?;

        Ok(())
    }

    async fn warmup(&self) -> Result<()> {
        Self::pull_image(&self.docker, &self.config.image).await
    }

    fn capabilities(&self) -> ExecutorCapabilities {
        ExecutorCapabilities {
            isolation_level: IsolationLevel::Container,
            supports_cpu_limit: true,
            supports_memory_limit: true,
            supports_disk_limit: false,
            supports_network_isolation: true,
            supports_readonly_rootfs: true,
            platform: std::env::consts::OS.to_string(),
        }
    }
}
