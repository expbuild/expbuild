use anyhow::Result;
use re_grpc_proto::build::bazel::remote::execution::v2::{Digest, Platform};
use re_grpc_proto::expbuild::worker::v1::{
    HeartbeatRequest, HeartbeatResponse, LeasedTask, LeaseTaskRequest, LeaseTaskResponse,
    RegisterWorkerRequest, RegisterWorkerResponse, TaskStatus, UnregisterWorkerRequest,
    UnregisterWorkerResponse, UpdateTaskStatusRequest, UpdateTaskStatusResponse,
    WorkerCapabilities, WorkerState, WorkerStats,
};
use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use std::time::{Duration, SystemTime};
use tokio::sync::{Mutex, RwLock};

pub struct WorkerScheduler {
    task_queue: Arc<Mutex<VecDeque<QueuedTask>>>,
    registered_workers: Arc<RwLock<HashMap<String, RegisteredWorker>>>,
    active_leases: Arc<RwLock<HashMap<String, TaskLease>>>,
    task_results: Arc<Mutex<HashMap<String, TaskResult>>>,
    config: SchedulerConfig,
}

#[derive(Debug, Clone)]
pub struct QueuedTask {
    pub task_id: String,
    pub operation_name: String,
    pub action_digest: Digest,
    pub platform: Option<Platform>,
    pub timeout: Duration,
    pub priority: i32,
    pub enqueued_at: SystemTime,
}

#[derive(Debug, Clone)]
pub struct RegisteredWorker {
    pub worker_id: String,
    pub capabilities: WorkerCapabilities,
    pub platform_properties: HashMap<String, String>,
    pub state: i32,
    pub last_heartbeat: SystemTime,
    pub registered_at: SystemTime,
    pub stats: WorkerStats,
}

#[derive(Debug, Clone)]
pub struct TaskLease {
    pub task_id: String,
    pub worker_id: String,
    pub leased_at: SystemTime,
    pub expires_at: SystemTime,
    pub operation_name: String,
}

#[derive(Debug, Clone)]
pub enum TaskResult {
    Success(re_grpc_proto::build::bazel::remote::execution::v2::ActionResult),
    Failed(String),
}

#[derive(Debug, Clone)]
pub struct SchedulerConfig {
    pub lease_duration: Duration,
    pub heartbeat_timeout: Duration,
    pub long_poll_timeout: Duration,
    pub max_queue_size: usize,
}

impl Default for SchedulerConfig {
    fn default() -> Self {
        Self {
            lease_duration: Duration::from_secs(300),
            heartbeat_timeout: Duration::from_secs(120),
            long_poll_timeout: Duration::from_secs(30),
            max_queue_size: 10000,
        }
    }
}

impl WorkerScheduler {
    pub fn new(config: SchedulerConfig) -> Arc<Self> {
        Arc::new(Self {
            task_queue: Arc::new(Mutex::new(VecDeque::new())),
            registered_workers: Arc::new(RwLock::new(HashMap::new())),
            active_leases: Arc::new(RwLock::new(HashMap::new())),
            task_results: Arc::new(Mutex::new(HashMap::new())),
            config,
        })
    }

    pub async fn submit_task(&self, task: QueuedTask) -> Result<String> {
        let mut queue = self.task_queue.lock().await;
        if queue.len() >= self.config.max_queue_size {
            anyhow::bail!("Task queue full");
        }
        let task_id = task.task_id.clone();
        queue.push_back(task);
        tracing::info!("Task {} submitted to queue, queue size: {}", task_id, queue.len());
        Ok(task_id)
    }

    pub async fn register_worker(
        &self,
        request: RegisterWorkerRequest,
    ) -> Result<RegisterWorkerResponse> {
        let worker_id = request.worker_id;
        let capabilities = request.capabilities.unwrap_or_default();
        let platform_properties = request.platform_properties;

        let worker = RegisteredWorker {
            worker_id: worker_id.clone(),
            capabilities: capabilities.clone(),
            platform_properties: platform_properties.clone(),
            state: WorkerState::Idle as i32,
            last_heartbeat: SystemTime::now(),
            registered_at: SystemTime::now(),
            stats: WorkerStats::default(),
        };

        self.registered_workers
            .write()
            .await
            .insert(worker_id.clone(), worker);

        tracing::info!(
            "Worker {} registered with platform: {:?}",
            worker_id,
            platform_properties
        );

        Ok(RegisterWorkerResponse {})
    }

    pub async fn lease_task(&self, request: LeaseTaskRequest) -> Result<LeaseTaskResponse> {
        let worker_id = request.worker_id;
        let max_tasks = request.max_tasks as usize;
        let timeout = Duration::from_secs(request.timeout_seconds as u64);

        let deadline = SystemTime::now() + timeout;

        loop {
            let tasks = self.try_lease_tasks(&worker_id, max_tasks).await?;
            if !tasks.is_empty() {
                return Ok(LeaseTaskResponse { tasks });
            }

            if SystemTime::now() >= deadline {
                return Ok(LeaseTaskResponse { tasks: vec![] });
            }

            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    }

    async fn try_lease_tasks(
        &self,
        worker_id: &str,
        max_tasks: usize,
    ) -> Result<Vec<LeasedTask>> {
        let workers = self.registered_workers.read().await;
        let worker = workers
            .get(worker_id)
            .ok_or_else(|| anyhow::anyhow!("Worker not registered"))?;

        let mut queue = self.task_queue.lock().await;
        let mut leases = self.active_leases.write().await;
        let mut leased_tasks = Vec::new();

        let mut i = 0;
        while leased_tasks.len() < max_tasks && i < queue.len() {
            let task = &queue[i];
            if self.platform_matches(&task.platform, &worker.platform_properties) {
                let task = queue.remove(i).unwrap();

                let lease_expires_at = SystemTime::now() + self.config.lease_duration;

                let lease = TaskLease {
                    task_id: task.task_id.clone(),
                    worker_id: worker_id.to_string(),
                    leased_at: SystemTime::now(),
                    expires_at: lease_expires_at,
                    operation_name: task.operation_name.clone(),
                };

                leases.insert(task.task_id.clone(), lease);

                let timeout_duration = Some(prost_types::Duration {
                    seconds: task.timeout.as_secs() as i64,
                    nanos: task.timeout.subsec_nanos() as i32,
                });

                let lease_timestamp = Some(prost_types::Timestamp {
                    seconds: lease_expires_at
                        .duration_since(SystemTime::UNIX_EPOCH)
                        .unwrap()
                        .as_secs() as i64,
                    nanos: 0,
                });

                leased_tasks.push(LeasedTask {
                    task_id: task.task_id.clone(),
                    operation_name: task.operation_name,
                    action_digest: Some(task.action_digest),
                    timeout: timeout_duration,
                    lease_expires_at: lease_timestamp,
                });

                tracing::info!(
                    "Leased task {} to worker {} (platform: {:?})",
                    task.task_id,
                    worker_id,
                    task.platform
                );
            } else {
                i += 1;
            }
        }

        Ok(leased_tasks)
    }

    fn platform_matches(
        &self,
        required: &Option<Platform>,
        worker_props: &HashMap<String, String>,
    ) -> bool {
        let Some(platform) = required else {
            return true;
        };

        for property in &platform.properties {
            if let Some(worker_value) = worker_props.get(&property.name) {
                if worker_value != &property.value {
                    return false;
                }
            } else {
                return false;
            }
        }
        true
    }

    pub async fn update_task_status(
        &self,
        request: UpdateTaskStatusRequest,
    ) -> Result<UpdateTaskStatusResponse> {
        let task_id = request.task_id.clone();
        let worker_id = request.worker_id.clone();
        let status = request.status();

        let mut leases = self.active_leases.write().await;
        let lease = leases
            .get(&task_id)
            .ok_or_else(|| anyhow::anyhow!("No active lease for task {}", task_id))?;

        if lease.worker_id != worker_id {
            anyhow::bail!("Worker ID mismatch for task {}", task_id);
        }

        match status {
            TaskStatus::Executing => {
                tracing::info!("Task {} is executing on worker {}", task_id, worker_id);
            }
            TaskStatus::Completed => {
                leases.remove(&task_id);
                if let Some(result) = request.result {
                    self.task_results
                        .lock()
                        .await
                        .insert(task_id.clone(), TaskResult::Success(result));
                    tracing::info!("Task {} completed on worker {}", task_id, worker_id);
                }
            }
            TaskStatus::Failed => {
                leases.remove(&task_id);
                let error_msg = if request.error_message.is_empty() {
                    "Unknown error".to_string()
                } else {
                    request.error_message
                };
                self.task_results.lock().await.insert(
                    task_id.clone(),
                    TaskResult::Failed(error_msg),
                );
                tracing::error!("Task {} failed on worker {}", task_id, worker_id);
            }
            _ => {}
        }

        Ok(UpdateTaskStatusResponse {})
    }

    pub async fn report_heartbeat(
        &self,
        request: HeartbeatRequest,
    ) -> Result<HeartbeatResponse> {
        let worker_id = request.worker_id;
        let state = request.state;
        let stats = request.stats.unwrap_or_default();

        let mut workers = self.registered_workers.write().await;
        if let Some(worker) = workers.get_mut(&worker_id) {
            worker.last_heartbeat = SystemTime::now();
            worker.state = state;
            worker.stats = stats;
            tracing::debug!("Heartbeat received from worker {}", worker_id);
        } else {
            tracing::warn!("Heartbeat from unregistered worker {}", worker_id);
        }

        Ok(HeartbeatResponse {
            should_shutdown: false,
        })
    }

    pub async fn unregister_worker(
        &self,
        request: UnregisterWorkerRequest,
    ) -> Result<UnregisterWorkerResponse> {
        let worker_id = request.worker_id;
        self.registered_workers.write().await.remove(&worker_id);
        tracing::info!("Worker {} unregistered", worker_id);
        Ok(UnregisterWorkerResponse {})
    }

    pub async fn get_task_result(&self, task_id: &str) -> Option<TaskResult> {
        self.task_results.lock().await.remove(task_id)
    }

    pub async fn start_maintenance_loop(self: Arc<Self>) {
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(30));
            loop {
                interval.tick().await;
                self.check_lease_timeouts().await;
                self.check_worker_timeouts().await;
            }
        });
    }

    async fn check_lease_timeouts(&self) {
        let now = SystemTime::now();
        let mut leases = self.active_leases.write().await;

        let expired: Vec<_> = leases
            .iter()
            .filter(|(_, lease)| lease.expires_at < now)
            .map(|(id, _)| id.clone())
            .collect();

        for task_id in expired {
            if let Some(lease) = leases.remove(&task_id) {
                tracing::warn!(
                    "Task {} lease expired, worker: {} (would requeue in production)",
                    task_id,
                    lease.worker_id
                );
            }
        }
    }

    async fn check_worker_timeouts(&self) {
        let now = SystemTime::now();
        let mut workers = self.registered_workers.write().await;

        let timeout_workers: Vec<_> = workers
            .iter()
            .filter(|(_, w)| {
                now.duration_since(w.last_heartbeat).unwrap_or_default()
                    > self.config.heartbeat_timeout
            })
            .map(|(id, _)| id.clone())
            .collect();

        for worker_id in timeout_workers {
            tracing::warn!("Worker {} timed out, removing", worker_id);
            workers.remove(&worker_id);
        }
    }
}

impl Clone for WorkerScheduler {
    fn clone(&self) -> Self {
        Self {
            task_queue: self.task_queue.clone(),
            registered_workers: self.registered_workers.clone(),
            active_leases: self.active_leases.clone(),
            task_results: self.task_results.clone(),
            config: self.config.clone(),
        }
    }
}
