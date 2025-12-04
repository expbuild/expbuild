use crate::config::WorkerConfig;
use crate::executor::{DockerExecutor, ExecutionRequest, HostExecutor, ResourceLimits as ExecutorResourceLimits, TaskExecutor};
use anyhow::{Context, Result};
use prost::Message;
use re_grpc_proto::build::bazel::remote::execution::v2::{Action, Command, ExecutedActionMetadata};
use re_grpc_proto::expbuild::worker::v1::{
    worker_scheduler_client::WorkerSchedulerClient, HeartbeatRequest, LeaseTaskRequest,
    RegisterWorkerRequest, ResourceLimits, TaskStatus, UnregisterWorkerRequest,
    UpdateTaskStatusRequest, WorkerCapabilities, WorkerState, WorkerStats,
};
use remote_execution::{REClient, REClientBuilder, ReConfiguration};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, SystemTime};
use tokio::sync::RwLock;
use tokio::task::JoinHandle;
use tonic::transport::Channel;

pub struct WorkerAgent {
    worker_id: String,
    capabilities: WorkerCapabilities,
    platform_properties: HashMap<String, String>,
    scheduler_client: WorkerSchedulerClient<Channel>,
    re_client: Arc<REClient>,
    executor: Arc<dyn TaskExecutor>,
    state: Arc<RwLock<WorkerState>>,
    active_tasks: Arc<RwLock<HashMap<String, TaskExecution>>>,
    config: WorkerConfig,
    stats: Arc<RwLock<WorkerStats>>,
    work_dir: PathBuf,
}

#[allow(dead_code)]
struct TaskExecution {
    task_id: String,
    operation_name: String,
    started_at: SystemTime,
}

impl WorkerAgent {
    pub async fn new(config: WorkerConfig) -> Result<Self> {
        let worker_id = config
            .worker_id
            .clone()
            .unwrap_or_else(|| format!("worker-{}", uuid::Uuid::new_v4()));

        let scheduler_client = WorkerSchedulerClient::connect(config.server_url.clone())
            .await
            .context("Failed to connect to scheduler")?;

        let re_config = ReConfiguration {
            engine_address: Some(config.cas_url.clone()),
            cas_address: Some(config.cas_url.clone()),
            action_cache_address: Some(config.cas_url.clone()),
            instance_name: String::new(),
            tls: false,
            tls_ca_certs: None,
            tls_client_cert: None,
            http_headers: vec![],
            grpc_keepalive_time_secs: None,
            grpc_keepalive_timeout_secs: None,
            grpc_keepalive_while_idle: None,
            max_decoding_message_size: None,
            max_total_batch_size: None,
            capabilities: Some(true),
            use_fbcode_metadata: false,
            max_concurrent_uploads_per_action: None,
            cas_ttl_secs: Some(60),
        };

        let re_client = Arc::new(
            REClientBuilder::build_and_connect(&re_config)
                .await
                .context("Failed to connect to CAS")?,
        );

        let executor: Arc<dyn TaskExecutor> = match &config.executor {
            crate::config::ExecutorBackend::Host(host_config) => {
                tracing::info!("Using Host executor");
                Arc::new(HostExecutor::new(host_config.clone()))
            }
            crate::config::ExecutorBackend::Docker(docker_config) => {
                tracing::info!("Using Docker executor with image: {}", docker_config.image);
                Arc::new(
                    DockerExecutor::new(docker_config.clone())
                        .await
                        .context("Failed to initialize Docker executor")?,
                )
            }
        };

        let capabilities = WorkerCapabilities {
            max_concurrent_executions: config.max_concurrent_tasks as i32,
            resources: Some(ResourceLimits {
                cpu_cores: num_cpus::get() as f64,
                memory_bytes: 0,
                disk_bytes: 0,
            }),
        };

        let work_dir = config.work_dir.clone();

        Ok(Self {
            worker_id,
            capabilities,
            platform_properties: config.platform.properties.clone(),
            scheduler_client,
            re_client,
            executor,
            state: Arc::new(RwLock::new(WorkerState::Idle)),
            active_tasks: Arc::new(RwLock::new(HashMap::new())),
            config,
            stats: Arc::new(RwLock::new(WorkerStats {
                active_tasks: 0,
                total_completed: 0,
                total_failed: 0,
            })),
            work_dir,
        })
    }

    pub async fn run(&mut self) -> Result<()> {
        self.register().await?;

        let heartbeat_handle = self.start_heartbeat_loop();
        let lease_handle = self.start_lease_loop();

        tokio::select! {
            _ = tokio::signal::ctrl_c() => {
                tracing::info!("Received shutdown signal, draining tasks...");
                *self.state.write().await = WorkerState::Draining;
            }
        }

        self.shutdown().await?;
        heartbeat_handle.abort();
        lease_handle.abort();

        Ok(())
    }

    async fn register(&mut self) -> Result<()> {
        let request = RegisterWorkerRequest {
            worker_id: self.worker_id.clone(),
            capabilities: Some(self.capabilities.clone()),
            platform_properties: self.platform_properties.clone(),
        };

        self.scheduler_client
            .register_worker(request)
            .await
            .context("Failed to register worker")?;

        tracing::info!(
            "Worker {} registered successfully with platform: {:?}",
            self.worker_id,
            self.platform_properties
        );

        Ok(())
    }

    fn start_heartbeat_loop(&self) -> JoinHandle<()> {
        let mut scheduler_client = self.scheduler_client.clone();
        let worker_id = self.worker_id.clone();
        let interval = self.config.heartbeat_interval();
        let state = self.state.clone();
        let stats = self.stats.clone();

        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(interval);
            loop {
                ticker.tick().await;

                let current_state = *state.read().await;
                let current_stats = stats.read().await.clone();

                let request = HeartbeatRequest {
                    worker_id: worker_id.clone(),
                    state: current_state as i32,
                    stats: Some(current_stats),
                };

                match scheduler_client.report_heartbeat(request).await {
                    Ok(response) => {
                        if response.into_inner().should_shutdown {
                            tracing::warn!("Server requested shutdown");
                            break;
                        }
                        tracing::debug!("Heartbeat sent successfully");
                    }
                    Err(e) => {
                        tracing::error!("Heartbeat failed: {}", e);
                    }
                }
            }
        })
    }

    fn start_lease_loop(&self) -> JoinHandle<()> {
        let mut scheduler_client = self.scheduler_client.clone();
        let worker_id = self.worker_id.clone();
        let max_concurrent = self.config.max_concurrent_tasks;
        let active_tasks = self.active_tasks.clone();
        let executor = self.executor.clone();
        let re_client = self.re_client.clone();
        let state = self.state.clone();
        let stats = self.stats.clone();
        let poll_interval = self.config.lease_poll_interval();
        let work_dir = self.work_dir.clone();

        tokio::spawn(async move {
            loop {
                let current_state = *state.read().await;
                if current_state == WorkerState::Draining {
                    if active_tasks.read().await.is_empty() {
                        tracing::info!("All tasks drained, worker can shutdown");
                        break;
                    }
                    tokio::time::sleep(Duration::from_secs(5)).await;
                    continue;
                }

                let current_active = active_tasks.read().await.len();
                let available_slots = max_concurrent.saturating_sub(current_active);

                if available_slots == 0 {
                    tokio::time::sleep(poll_interval).await;
                    continue;
                }

                let request = LeaseTaskRequest {
                    worker_id: worker_id.clone(),
                    max_tasks: available_slots as i32,
                    timeout_seconds: 30,
                };

                let response = match scheduler_client.lease_task(request).await {
                    Ok(resp) => resp.into_inner(),
                    Err(e) => {
                        if e.code() != tonic::Code::DeadlineExceeded {
                            tracing::error!("Failed to lease task: {}", e);
                        }
                        tokio::time::sleep(poll_interval).await;
                        continue;
                    }
                };

                if response.tasks.is_empty() {
                    tokio::time::sleep(poll_interval).await;
                    continue;
                }

                for task in response.tasks {
                    let task_id = task.task_id.clone();
                    let operation_name = task.operation_name.clone();

                    active_tasks.write().await.insert(
                        task_id.clone(),
                        TaskExecution {
                            task_id: task_id.clone(),
                            operation_name: operation_name.clone(),
                            started_at: SystemTime::now(),
                        },
                    );

                    stats.write().await.active_tasks += 1;

                    if *state.read().await == WorkerState::Idle {
                        *state.write().await = WorkerState::Busy;
                    }

                let active_tasks_clone = active_tasks.clone();
                let executor_clone = executor.clone();
                let re_client_clone = re_client.clone();
                let scheduler_clone = scheduler_client.clone();
                let worker_id_clone = worker_id.clone();
                let state_clone = state.clone();
                let stats_clone = stats.clone();
                let work_dir_clone = work_dir.clone();

                tokio::spawn(async move {
                    let result = Self::execute_task(
                        task,
                        executor_clone,
                        re_client_clone,
                        scheduler_clone,
                        worker_id_clone,
                        work_dir_clone,
                    )
                    .await;

                        active_tasks_clone.write().await.remove(&task_id);

                        let mut stats = stats_clone.write().await;
                        stats.active_tasks = stats.active_tasks.saturating_sub(1);
                        match result {
                            Ok(_) => stats.total_completed += 1,
                            Err(_) => stats.total_failed += 1,
                        }

                        if active_tasks_clone.read().await.is_empty() {
                            *state_clone.write().await = WorkerState::Idle;
                        }
                    });
                }
            }
        })
    }

    async fn execute_task(
        task: re_grpc_proto::expbuild::worker::v1::LeasedTask,
        executor: Arc<dyn TaskExecutor>,
        re_client: Arc<REClient>,
        mut scheduler_client: WorkerSchedulerClient<Channel>,
        worker_id: String,
        work_dir: PathBuf,
    ) -> Result<()> {
        let task_id = task.task_id.clone();
        tracing::info!("Starting execution of task {}", task_id);

        let _ = scheduler_client
            .update_task_status(UpdateTaskStatusRequest {
                task_id: task_id.clone(),
                worker_id: worker_id.clone(),
                status: TaskStatus::Executing as i32,
                result: None,
                error_message: String::new(),
            })
            .await;

        let result = Self::execute_task_inner(task.clone(), executor, re_client, work_dir).await;

        match result {
            Ok(action_result) => {
                scheduler_client
                    .update_task_status(UpdateTaskStatusRequest {
                        task_id: task_id.clone(),
                        worker_id: worker_id.clone(),
                        status: TaskStatus::Completed as i32,
                        result: Some(action_result),
                        error_message: String::new(),
                    })
                    .await
                    .context("Failed to report task completion")?;

                tracing::info!("Task {} completed successfully", task_id);
            }
            Err(e) => {
                let error_msg = format!("{:#}", e);
                scheduler_client
                    .update_task_status(UpdateTaskStatusRequest {
                        task_id: task_id.clone(),
                        worker_id: worker_id.clone(),
                        status: TaskStatus::Failed as i32,
                        result: None,
                        error_message: error_msg.clone(),
                    })
                    .await
                    .context("Failed to report task failure")?;

                tracing::error!("Task {} failed: {}", task_id, error_msg);
                return Err(e);
            }
        }

        Ok(())
    }

    async fn execute_task_inner(
        task: re_grpc_proto::expbuild::worker::v1::LeasedTask,
        executor: Arc<dyn TaskExecutor>,
        re_client: Arc<REClient>,
        work_dir: PathBuf,
    ) -> Result<re_grpc_proto::build::bazel::remote::execution::v2::ActionResult> {
        let action_digest = task
            .action_digest
            .ok_or_else(|| anyhow::anyhow!("Missing action digest"))?;

        tracing::info!(
            "Downloading action {}/{}",
            action_digest.hash,
            action_digest.size_bytes
        );
        let action_bytes = re_client
            .download_blob(&action_digest)
            .await
            .context("Failed to download action")?;
        let action = Action::decode(&action_bytes[..]).context("Failed to decode action")?;

        let command_digest = action
            .command_digest
            .ok_or_else(|| anyhow::anyhow!("Missing command digest"))?;
        tracing::info!(
            "Downloading command {}/{}",
            command_digest.hash,
            command_digest.size_bytes
        );
        let command_bytes = re_client
            .download_blob(&command_digest)
            .await
            .context("Failed to download command")?;
        let command = Command::decode(&command_bytes[..]).context("Failed to decode command")?;

        let input_root_digest = action
            .input_root_digest
            .ok_or_else(|| anyhow::anyhow!("Missing input root digest"))?;

        let work_root = work_dir.join(&task.task_id);
        let input_dir = work_root.join("inputs");
        std::fs::create_dir_all(&input_dir).context("Failed to create input directory")?;

        tracing::info!(
            "Downloading input tree {}/{}",
            input_root_digest.hash,
            input_root_digest.size_bytes
        );
        re_client
            .download_directory_tree(&input_root_digest, &input_dir)
            .await
            .context("Failed to download input directory")?;

        for output_path in &command.output_paths {
            let full_path = input_dir.join(output_path);
            if let Some(parent) = full_path.parent() {
                if !parent.exists() {
                    std::fs::create_dir_all(parent)
                        .with_context(|| format!("Failed to create output directory: {:?}", parent))?;
                }
            }
        }

        #[allow(deprecated)]
        for output_dir in &command.output_directories {
            let full_path = input_dir.join(output_dir);
            std::fs::create_dir_all(&full_path)
                .with_context(|| format!("Failed to create output directory: {:?}", full_path))?;
        }

        let timeout = task
            .timeout
            .map(|d| Duration::from_secs(d.seconds as u64))
            .unwrap_or(Duration::from_secs(3600));

        tracing::info!(
            "Executing command: {:?} (timeout: {:?})",
            command.arguments,
            timeout
        );
        let exec_result = executor
            .execute(ExecutionRequest {
                command: command.clone(),
                work_dir: input_dir.clone(),
                timeout,
                resource_limits: ExecutorResourceLimits::default(),
            })
            .await
            .context("Failed to execute command")?;

        tracing::info!("Command exited with code: {}", exec_result.exit_code);

        let execution_start_timestamp = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .ok()
            .map(|d| prost_types::Timestamp {
                seconds: d.as_secs() as i64,
                nanos: 0,
            });

        let execution_completed_timestamp = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .ok()
            .map(|d| prost_types::Timestamp {
                seconds: d.as_secs() as i64,
                nanos: 0,
            });

        const MAX_INLINE_SIZE: usize = 1024 * 1024;

        let (stdout_raw, stdout_digest) = if exec_result.stdout.is_empty() {
            (vec![], None)
        } else if exec_result.stdout.len() <= MAX_INLINE_SIZE {
            (exec_result.stdout, None)
        } else {
            let digest = re_client
                .upload_blob(exec_result.stdout)
                .await
                .context("Failed to upload stdout")?;
            (vec![], Some(digest))
        };

        let (stderr_raw, stderr_digest) = if exec_result.stderr.is_empty() {
            (vec![], None)
        } else if exec_result.stderr.len() <= MAX_INLINE_SIZE {
            (exec_result.stderr, None)
        } else {
            let digest = re_client
                .upload_blob(exec_result.stderr)
                .await
                .context("Failed to upload stderr")?;
            (vec![], Some(digest))
        };

        let output_files = Self::upload_output_files(&exec_result.output_files, &re_client)
            .await
            .context("Failed to upload output files")?;

        let output_directories =
            Self::collect_output_directories(&input_dir, &command, &re_client)
                .await
                .context("Failed to collect output directories")?;

        //if let Err(e) = std::fs::remove_dir_all(&work_root) {
        //    tracing::warn!("Failed to cleanup workspace {:?}: {}", work_root, e);
        //}

        #[allow(deprecated)]
        Ok(re_grpc_proto::build::bazel::remote::execution::v2::ActionResult {
            output_files,
            output_file_symlinks: vec![],
            output_symlinks: vec![],
            output_directories,
            output_directory_symlinks: vec![],
            exit_code: exec_result.exit_code,
            stdout_raw,
            stdout_digest,
            stderr_raw,
            stderr_digest,
            execution_metadata: Some(ExecutedActionMetadata {
                worker: format!("expbuild-worker"),
                queued_timestamp: execution_start_timestamp.clone(),
                worker_start_timestamp: execution_start_timestamp.clone(),
                worker_completed_timestamp: execution_completed_timestamp.clone(),
                input_fetch_start_timestamp: execution_start_timestamp.clone(),
                input_fetch_completed_timestamp: execution_start_timestamp.clone(),
                execution_start_timestamp,
                execution_completed_timestamp,
                output_upload_start_timestamp: None,
                output_upload_completed_timestamp: None,
                virtual_execution_duration: None,
                auxiliary_metadata: vec![],
            }),
        })
    }

    async fn upload_output_files(
        output_file_infos: &[re_grpc_proto::build::bazel::remote::execution::v2::OutputFile],
        re_client: &REClient,
    ) -> Result<Vec<re_grpc_proto::build::bazel::remote::execution::v2::OutputFile>> {
        let mut output_files = vec![];
        for output_file in output_file_infos {
            let digest = if !output_file.contents.is_empty() {
                re_client
                    .upload_blob(output_file.contents.clone())
                    .await
                    .context("Failed to upload output file")?
            } else {
                continue;
            };
            
            output_files.push(re_grpc_proto::build::bazel::remote::execution::v2::OutputFile {
                path: output_file.path.clone(),
                digest: Some(digest),
                is_executable: output_file.is_executable,
                contents: vec![],
                node_properties: None,
            });
        }
        Ok(output_files)
    }

    async fn collect_output_directories(
        work_dir: &PathBuf,
        command: &Command,
        re_client: &REClient,
    ) -> Result<Vec<re_grpc_proto::build::bazel::remote::execution::v2::OutputDirectory>> {
        let mut output_directories = Vec::new();

        #[allow(deprecated)]
        for output_path in &command.output_directories {
            let dir_path = work_dir.join(output_path);
            if !dir_path.exists() {
                continue;
            }

            let tree_digest = re_client
                .upload_directory_tree_from_path(&dir_path)
                .await
                .context("Failed to upload output directory")?;

            output_directories.push(
                re_grpc_proto::build::bazel::remote::execution::v2::OutputDirectory {
                    path: output_path.clone(),
                    tree_digest: Some(tree_digest.clone()),
                    root_directory_digest: Some(tree_digest),
                    is_topologically_sorted: false,
                },
            );
        }

        Ok(output_directories)
    }

    async fn shutdown(&mut self) -> Result<()> {
        tracing::info!("Waiting for active tasks to complete...");
        let timeout = Duration::from_secs(300);
        let start = SystemTime::now();

        while !self.active_tasks.read().await.is_empty() {
            if SystemTime::now().duration_since(start)? > timeout {
                tracing::warn!("Shutdown timeout reached, forcing exit");
                break;
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }

        tracing::info!("Unregistering worker...");
        self.scheduler_client
            .unregister_worker(UnregisterWorkerRequest {
                worker_id: self.worker_id.clone(),
            })
            .await
            .context("Failed to unregister worker")?;

        tracing::info!("Worker {} shutdown complete", self.worker_id);
        Ok(())
    }
}
