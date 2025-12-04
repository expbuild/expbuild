use anyhow::Result;
use async_trait::async_trait;
use re_grpc_proto::build::bazel::remote::execution::v2::OutputFile;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use std::time::SystemTime;
use tokio::fs;

use super::{
    ExecutionRequest, ExecutionResult, ExecutionStats, ExecutorCapabilities, IsolationLevel,
    OutputFileInfo, TaskExecutor,
};

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct HostExecutorConfig {
    #[serde(default = "default_env_whitelist")]
    pub env_whitelist: Vec<String>,
    #[serde(default = "default_cleanup_workspace")]
    pub cleanup_workspace: bool,
}

fn default_env_whitelist() -> Vec<String> {
    vec![
        "PATH".to_string(),
        "HOME".to_string(),
        "USER".to_string(),
        "TMPDIR".to_string(),
        "TEMP".to_string(),
        "TMP".to_string(),
    ]
}

fn default_cleanup_workspace() -> bool {
    true
}

impl Default for HostExecutorConfig {
    fn default() -> Self {
        Self {
            env_whitelist: default_env_whitelist(),
            cleanup_workspace: default_cleanup_workspace(),
        }
    }
}

pub struct HostExecutor {
    config: HostExecutorConfig,
}

impl HostExecutor {
    pub fn new(config: HostExecutorConfig) -> Self {
        Self { config }
    }

    #[allow(dead_code)]
    async fn cleanup_workspace(&self, workspace_root: &Path) -> Result<()> {
        if workspace_root.exists() {
            tracing::debug!("Cleaning up workspace: {:?}", workspace_root);
            fs::remove_dir_all(workspace_root).await?;
        }
        Ok(())
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

        if filtered.is_empty() {
            for env_var in env_vars {
                filtered.insert(env_var.name.clone(), env_var.value.clone());
            }
        }

        filtered
    }

    async fn collect_outputs(
        &self,
        work_dir: &Path,
        output_paths: &[String],
    ) -> Result<Vec<OutputFileInfo>> {
        let mut output_files = Vec::new();

        for output_path in output_paths {
            let full_path = work_dir.join(output_path);

            if !full_path.exists() {
                tracing::debug!("Output path does not exist: {:?}", full_path);
                continue;
            }

            if full_path.is_file() {
                let data = fs::read(&full_path).await?;

                #[cfg(unix)]
                let is_executable = {
                    use std::os::unix::fs::PermissionsExt;
                    std::fs::metadata(&full_path)?.permissions().mode() & 0o111 != 0
                };

                #[cfg(not(unix))]
                let is_executable = false;

                output_files.push(OutputFileInfo {
                    path: output_path.clone(),
                    data,
                    is_executable,
                });
            }
        }

        Ok(output_files)
    }
}

#[async_trait]
impl TaskExecutor for HostExecutor {
    async fn execute(&self, request: ExecutionRequest) -> Result<ExecutionResult> {
        use tokio::process::Command as TokioCommand;

        if request.command.arguments.is_empty() {
            anyhow::bail!("No arguments provided");
        }

        let work_dir = if request.command.working_directory.is_empty() {
            request.work_dir.clone()
        } else {
            request.work_dir.join(&request.command.working_directory)
        };

        fs::create_dir_all(&work_dir).await?;

        tracing::info!(
            "Executing command: {:?} in {:?}",
            request.command.arguments,
            work_dir
        );

        let mut cmd = TokioCommand::new(&request.command.arguments[0]);
        cmd.args(&request.command.arguments[1..])
            .current_dir(&work_dir)
            .envs(self.filter_environment(&request.command.environment_variables));

        let start_time = SystemTime::now();
        let output = tokio::time::timeout(request.timeout, cmd.output()).await??;
        let end_time = SystemTime::now();

        let duration = end_time.duration_since(start_time)?;
        tracing::info!(
            "Command completed: exit_code={}, duration={:.2}s",
            output.status.code().unwrap_or(-1),
            duration.as_secs_f64()
        );

        let output_file_infos = self
            .collect_outputs(&request.work_dir, &request.command.output_paths)
            .await?;

        tracing::info!("Collected {} output files", output_file_infos.len());

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
            exit_code: output.status.code().unwrap_or(-1),
            stdout: output.stdout,
            stderr: output.stderr,
            output_files,
            stats: ExecutionStats {
                duration,
                ..Default::default()
            },
        })
    }

    fn isolation_level(&self) -> IsolationLevel {
        IsolationLevel::None
    }

    async fn health_check(&self) -> Result<()> {
        Ok(())
    }

    async fn warmup(&self) -> Result<()> {
        Ok(())
    }

    fn capabilities(&self) -> ExecutorCapabilities {
        ExecutorCapabilities {
            isolation_level: IsolationLevel::None,
            supports_cpu_limit: false,
            supports_memory_limit: false,
            supports_disk_limit: false,
            supports_network_isolation: false,
            supports_readonly_rootfs: false,
            platform: std::env::consts::OS.to_string(),
        }
    }
}
