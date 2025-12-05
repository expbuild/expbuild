# Standalone Worker Command Detailed Implementation Plan

## I. Architecture Overview

### 1.1 Overall Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                        Client                                │
│  (expbuild-cli: upload action, execute, download result)    │
└──────────────────────┬───────────────────────────────────────┘
                       │ gRPC (Remote Execution API)
                       ↓
┌──────────────────────────────────────────────────────────────┐
│                     RE Server                                │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  Execution Service                                     │  │
│  │  - Execute() → Create Operation                        │  │
│  │  - WaitExecution() → Stream Operation updates          │  │
│  └─────────────────────┬──────────────────────────────────┘  │
│                        ↓                                      │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  ExecutionManager                                      │  │
│  │  - operations: HashMap<OperationName, State>           │  │
│  │  - Create Operation (QUEUED)                           │  │
│  │  - Submit task to TaskQueue                            │  │
│  └─────────────────────┬──────────────────────────────────┘  │
│                        ↓                                      │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  Worker Scheduler (New)                                │  │
│  │  - task_queue: PriorityQueue<ExecutionTask>           │  │
│  │  - registered_workers: HashMap<WorkerId, WorkerInfo>   │  │
│  │  - active_assignments: HashMap<TaskId, WorkerId>       │  │
│  │  - LeaseTask() gRPC - Worker pulls tasks               │  │
│  │  - UpdateTaskStatus() gRPC - Worker updates status     │  │
│  │  - ReportHeartbeat() gRPC - Worker heartbeat           │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  CAS Manager + Action Cache                            │  │
│  └────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
                       ↑
                       │ gRPC (Worker API - New)
                       │
┌──────────────────────┴───────────────────────────────────────┐
│              Worker Nodes (expbuild-worker)                  │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  Worker Agent                                          │  │
│  │  - worker_id, capabilities, platform_properties        │  │
│  │  - Pull loop: LeaseTask() → Execute → UpdateStatus     │  │
│  │  - Heartbeat thread: ReportHeartbeat() (every 30s)     │  │
│  └─────────────────────┬──────────────────────────────────┘  │
│                        ↓                                      │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  Task Executor                                         │  │
│  │  - Download inputs from CAS                            │  │
│  │  - Execute command (subprocess/docker/sandbox)         │  │
│  │  - Upload outputs to CAS                               │  │
│  │  - Return ActionResult                                 │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  RE Client (for CAS access)                            │  │
│  └────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

### 1.2 Communication Pattern Selection

**Pull Model Adopted**, advantages:
- Workers don't need to expose ports, can be deployed behind NAT
- Workers can control pull frequency based on their own load
- Simplifies firewall configuration
- Easy to implement retry and fault tolerance

## II. Protocol Design

### 2.1 New gRPC Service Definition

Need to add to `remote_execution.proto` or create new `worker_api.proto`:

```protobuf
service WorkerScheduler {
  // Worker registration
  rpc RegisterWorker(RegisterWorkerRequest) returns (RegisterWorkerResponse);

  // Worker pulls tasks (long polling)
  rpc LeaseTask(LeaseTaskRequest) returns (LeaseTaskResponse);

  // Worker updates task status
  rpc UpdateTaskStatus(UpdateTaskStatusRequest) returns (UpdateTaskStatusResponse);

  // Worker heartbeat
  rpc ReportHeartbeat(HeartbeatRequest) returns (HeartbeatResponse);

  // Worker deregistration
  rpc UnregisterWorker(UnregisterWorkerRequest) returns (UnregisterWorkerResponse);
}

message RegisterWorkerRequest {
  string worker_id = 1;
  WorkerCapabilities capabilities = 2;
  map<string, string> platform_properties = 3; // OSFamily, Arch, container, etc.
}

message RegisterWorkerResponse {
  // Empty or return configuration info
}

message WorkerCapabilities {
  int32 max_concurrent_executions = 1;
  ResourceLimits resources = 2;
}

message ResourceLimits {
  double cpu_cores = 1;
  int64 memory_bytes = 2;
  int64 disk_bytes = 3;
}

message LeaseTaskRequest {
  string worker_id = 1;
  int32 max_tasks = 2; // Number of tasks the worker can currently accept
  int64 timeout_seconds = 3; // Long polling timeout (e.g. 30s)
}

message LeaseTaskResponse {
  repeated LeasedTask tasks = 1;
}

message LeasedTask {
  string task_id = 1;
  string operation_name = 2;
  string action_digest = 3; // "{hash}/{size}"
  google.protobuf.Duration timeout = 4;
  google.protobuf.Timestamp lease_expires_at = 5; // Lease expiration time
}

message UpdateTaskStatusRequest {
  string task_id = 1;
  string worker_id = 2;
  TaskStatus status = 3;
  ActionResult result = 4; // If completed
  string error_message = 5; // If failed
}

enum TaskStatus {
  UNKNOWN = 0;
  EXECUTING = 1;
  COMPLETED = 2;
  FAILED = 3;
}

message UpdateTaskStatusResponse {
  // Empty or return confirmation
}

message HeartbeatRequest {
  string worker_id = 1;
  WorkerState state = 2;
  WorkerStats stats = 3;
}

enum WorkerState {
  IDLE = 0;
  BUSY = 1;
  DRAINING = 2; // Preparing to shut down
}

message WorkerStats {
  int32 active_tasks = 1;
  int64 total_completed = 2;
  int64 total_failed = 3;
}

message HeartbeatResponse {
  bool should_shutdown = 1; // Server can notify Worker to shut down
}

message UnregisterWorkerRequest {
  string worker_id = 1;
}

message UnregisterWorkerResponse {}
```

### 2.2 Data Structure Design

#### Server-side New Data Structures

```rust
// re_server/src/execution/scheduler.rs

pub struct WorkerScheduler {
    // Task queue (priority queue)
    task_queue: Arc<Mutex<PriorityQueue<QueuedTask>>>,

    // Registered workers
    registered_workers: Arc<RwLock<HashMap<String, RegisteredWorker>>>,

    // Active task assignments
    active_leases: Arc<RwLock<HashMap<String, TaskLease>>>,

    // Task results (to be fetched by ExecutionManager)
    task_results: Arc<Mutex<HashMap<String, TaskResult>>>,

    // CAS access
    cas_manager: Arc<CasManager>,

    // Configuration
    config: SchedulerConfig,
}

pub struct QueuedTask {
    pub task_id: String,
    pub operation_name: String,
    pub action_digest: Digest,
    pub action: Action,
    pub command: Command,
    pub platform: Option<Platform>,
    pub timeout: Duration,
    pub priority: i32, // Support priority
    pub enqueued_at: SystemTime,
}

pub struct RegisteredWorker {
    pub worker_id: String,
    pub capabilities: WorkerCapabilities,
    pub platform_properties: HashMap<String, String>,
    pub state: WorkerState,
    pub last_heartbeat: SystemTime,
    pub registered_at: SystemTime,
    pub stats: WorkerStats,
}

pub struct TaskLease {
    pub task_id: String,
    pub worker_id: String,
    pub leased_at: SystemTime,
    pub expires_at: SystemTime,
    pub operation_name: String,
}

pub struct SchedulerConfig {
    pub lease_duration: Duration, // Default 5 minutes
    pub heartbeat_timeout: Duration, // Default 2 minutes
    pub long_poll_timeout: Duration, // Default 30 seconds
    pub max_queue_size: usize,
}
```

#### Worker-side Data Structures

```rust
// worker/src/agent.rs

pub struct WorkerAgent {
    pub worker_id: String,
    pub capabilities: WorkerCapabilities,
    pub platform_properties: HashMap<String, String>,

    // gRPC clients
    scheduler_client: WorkerSchedulerClient<Channel>,
    cas_client: Arc<REClient>,

    // Executor
    executor: Arc<dyn TaskExecutor>,

    // State
    state: Arc<RwLock<WorkerState>>,
    active_tasks: Arc<RwLock<HashMap<String, TaskExecution>>>,

    // Configuration
    config: WorkerConfig,
}

pub struct WorkerConfig {
    pub server_url: String,
    pub cas_url: String,
    pub max_concurrent_tasks: usize,
    pub heartbeat_interval: Duration,
    pub lease_poll_interval: Duration,
    pub execution_backend: ExecutionBackend,
}

pub enum ExecutionBackend {
    Host(HostExecutorConfig),
    Docker(DockerExecutorConfig),
    Sandbox(SandboxExecutorConfig),
}

pub struct TaskExecution {
    pub task_id: String,
    pub operation_name: String,
    pub started_at: SystemTime,
    pub cancel_tx: oneshot::Sender<()>,
}
```

## III. Server-side Implementation Plan

### 3.1 WorkerScheduler Implementation

```rust
// re_server/src/execution/scheduler.rs

impl WorkerScheduler {
    pub fn new(
        cas_manager: Arc<CasManager>,
        config: SchedulerConfig,
    ) -> Arc<Self> {
        Arc::new(Self {
            task_queue: Arc::new(Mutex::new(PriorityQueue::new())),
            registered_workers: Arc::new(RwLock::new(HashMap::new())),
            active_leases: Arc::new(RwLock::new(HashMap::new())),
            task_results: Arc::new(Mutex::new(HashMap::new())),
            cas_manager,
            config,
        })
    }

    // Submit task (called by ExecutionManager)
    pub async fn submit_task(&self, task: QueuedTask) -> Result<String> {
        let mut queue = self.task_queue.lock().await;
        if queue.len() >= self.config.max_queue_size {
            anyhow::bail!("Task queue full");
        }
        queue.push(task.task_id.clone(), task);
        Ok(task_id)
    }

    // Worker pulls tasks (gRPC method)
    pub async fn lease_task(
        &self,
        worker_id: String,
        max_tasks: usize,
        timeout: Duration,
    ) -> Result<Vec<LeasedTask>> {
        let deadline = SystemTime::now() + timeout;

        loop {
            // Check if there are matching tasks
            let tasks = self.try_lease_tasks(&worker_id, max_tasks).await?;
            if !tasks.is_empty() {
                return Ok(tasks);
            }

            // Long polling: wait or timeout
            if SystemTime::now() >= deadline {
                return Ok(vec![]);
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
        let worker = workers.get(worker_id)
            .ok_or_else(|| anyhow::anyhow!("Worker not registered"))?;

        let mut queue = self.task_queue.lock().await;
        let mut leases = self.active_leases.write().await;
        let mut leased_tasks = Vec::new();

        // Match Platform and assign tasks
        while leased_tasks.len() < max_tasks {
            let task = queue.iter()
                .find(|(_, t)| self.platform_matches(&t.platform, &worker.platform_properties))
                .map(|(id, _)| id.clone());

            let Some(task_id) = task else {
                break;
            };

            let task = queue.remove(&task_id).unwrap();

            let lease = TaskLease {
                task_id: task.task_id.clone(),
                worker_id: worker_id.to_string(),
                leased_at: SystemTime::now(),
                expires_at: SystemTime::now() + self.config.lease_duration,
                operation_name: task.operation_name.clone(),
            };

            leases.insert(task.task_id.clone(), lease);

            leased_tasks.push(LeasedTask {
                task_id: task.task_id,
                operation_name: task.operation_name,
                action_digest: format!("{}/{}", task.action_digest.hash, task.action_digest.size_bytes),
                timeout: task.timeout,
                lease_expires_at: SystemTime::now() + self.config.lease_duration,
            });
        }

        Ok(leased_tasks)
    }

    // Worker updates task status (gRPC method)
    pub async fn update_task_status(
        &self,
        task_id: String,
        worker_id: String,
        status: TaskStatus,
        result: Option<ActionResult>,
        error: Option<String>,
    ) -> Result<()> {
        // Verify lease
        let mut leases = self.active_leases.write().await;
        let lease = leases.get(&task_id)
            .ok_or_else(|| anyhow::anyhow!("No active lease for task"))?;

        if lease.worker_id != worker_id {
            anyhow::bail!("Worker ID mismatch");
        }

        match status {
            TaskStatus::Executing => {
                // Update Operation status in ExecutionManager
                // (via callback or shared state)
            }
            TaskStatus::Completed => {
                leases.remove(&task_id);
                self.task_results.lock().await.insert(
                    task_id,
                    TaskResult::Success(result.unwrap()),
                );
            }
            TaskStatus::Failed => {
                leases.remove(&task_id);
                self.task_results.lock().await.insert(
                    task_id,
                    TaskResult::Failed(error.unwrap_or_default()),
                );
            }
            _ => {}
        }

        Ok(())
    }

    // Worker heartbeat (gRPC method)
    pub async fn report_heartbeat(
        &self,
        worker_id: String,
        state: WorkerState,
        stats: WorkerStats,
    ) -> Result<HeartbeatResponse> {
        let mut workers = self.registered_workers.write().await;
        if let Some(worker) = workers.get_mut(&worker_id) {
            worker.last_heartbeat = SystemTime::now();
            worker.state = state;
            worker.stats = stats;
        }

        Ok(HeartbeatResponse {
            should_shutdown: false,
        })
    }

    // Background task: detect lease and heartbeat timeouts
    pub async fn start_maintenance_loop(self: Arc<Self>) {
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(30));
            loop {
                interval.tick().await;

                // Check lease timeouts
                self.check_lease_timeouts().await;

                // Check worker heartbeat timeouts
                self.check_worker_timeouts().await;
            }
        });
    }

    async fn check_lease_timeouts(&self) {
        let now = SystemTime::now();
        let mut leases = self.active_leases.write().await;
        let mut queue = self.task_queue.lock().await;

        let expired: Vec<_> = leases.iter()
            .filter(|(_, lease)| lease.expires_at < now)
            .map(|(id, _)| id.clone())
            .collect();

        for task_id in expired {
            if let Some(lease) = leases.remove(&task_id) {
                tracing::warn!(
                    "Task {} lease expired, requeueing (worker: {})",
                    task_id, lease.worker_id
                );
                // Re-enqueue (need to restore from original task info)
                // Actual implementation needs to save original task info
            }
        }
    }

    async fn check_worker_timeouts(&self) {
        let now = SystemTime::now();
        let mut workers = self.registered_workers.write().await;

        let timeout_workers: Vec<_> = workers.iter()
            .filter(|(_, w)| {
                now.duration_since(w.last_heartbeat).unwrap() > self.config.heartbeat_timeout
            })
            .map(|(id, _)| id.clone())
            .collect();

        for worker_id in timeout_workers {
            tracing::warn!("Worker {} timed out, removing", worker_id);
            workers.remove(&worker_id);
            // Reassign tasks from this worker
        }
    }
}
```

### 3.2 ExecutionManager Integration

```rust
// re_server/src/execution/manager.rs

pub struct ExecutionManager {
    cas_manager: Arc<CasManager>,
    cache_manager: Arc<ActionCacheManager>,
    scheduler: Arc<WorkerScheduler>, // New
    operations: Arc<RwLock<HashMap<String, OperationState>>>,
}

impl ExecutionManager {
    pub async fn execute_action(
        &self,
        action_digest: Digest,
        skip_cache: bool,
    ) -> Result<String> {
        let operation_name = self.create_operation(action_digest.clone(), skip_cache).await?;

        // Get Action and Command
        let action = self.get_action(&action_digest).await?;
        let command = self.get_command(&action).await?;

        // Submit to Scheduler
        let task = QueuedTask {
            task_id: Uuid::new_v4().to_string(),
            operation_name: operation_name.clone(),
            action_digest: action_digest.clone(),
            action,
            command,
            platform: None,
            timeout: Duration::from_secs(3600),
            priority: 0,
            enqueued_at: SystemTime::now(),
        };

        self.scheduler.submit_task(task).await?;

        // Start background task to listen for results
        let exec_mgr = Arc::new(self.clone());
        let scheduler = self.scheduler.clone();
        let op_name = operation_name.clone();

        tokio::spawn(async move {
            // Wait for result from Scheduler
            loop {
                if let Some(result) = scheduler.get_task_result(&task_id).await {
                    match result {
                        TaskResult::Success(action_result) => {
                            exec_mgr.complete_operation(&op_name, action_result).await.ok();
                        }
                        TaskResult::Failed(error) => {
                            tracing::error!("Task failed: {}", error);
                        }
                    }
                    break;
                }
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
        });

        Ok(operation_name)
    }
}
```

### 3.3 gRPC Service Implementation

```rust
// re_server/src/grpc/worker_scheduler_service.rs

pub struct WorkerSchedulerService {
    scheduler: Arc<WorkerScheduler>,
}

#[tonic::async_trait]
impl worker_scheduler_server::WorkerScheduler for WorkerSchedulerService {
    async fn register_worker(
        &self,
        request: Request<RegisterWorkerRequest>,
    ) -> Result<Response<RegisterWorkerResponse>, Status> {
        let req = request.into_inner();

        self.scheduler.register_worker(
            req.worker_id,
            req.capabilities.unwrap_or_default(),
            req.platform_properties,
        ).await.map_err(|e| Status::internal(e.to_string()))?;

        Ok(Response::new(RegisterWorkerResponse {}))
    }

    async fn lease_task(
        &self,
        request: Request<LeaseTaskRequest>,
    ) -> Result<Response<LeaseTaskResponse>, Status> {
        let req = request.into_inner();

        let tasks = self.scheduler.lease_task(
            req.worker_id,
            req.max_tasks as usize,
            Duration::from_secs(req.timeout_seconds as u64),
        ).await.map_err(|e| Status::internal(e.to_string()))?;

        Ok(Response::new(LeaseTaskResponse { tasks }))
    }

    async fn update_task_status(
        &self,
        request: Request<UpdateTaskStatusRequest>,
    ) -> Result<Response<UpdateTaskStatusResponse>, Status> {
        let req = request.into_inner();

        self.scheduler.update_task_status(
            req.task_id,
            req.worker_id,
            req.status,
            req.result,
            req.error_message,
        ).await.map_err(|e| Status::internal(e.to_string()))?;

        Ok(Response::new(UpdateTaskStatusResponse {}))
    }

    async fn report_heartbeat(
        &self,
        request: Request<HeartbeatRequest>,
    ) -> Result<Response<HeartbeatResponse>, Status> {
        let req = request.into_inner();

        let response = self.scheduler.report_heartbeat(
            req.worker_id,
            req.state,
            req.stats,
        ).await.map_err(|e| Status::internal(e.to_string()))?;

        Ok(Response::new(response))
    }
}
```

## IV. Worker-side Implementation Plan

### 4.1 Worker Agent Core Logic

```rust
// worker/src/agent.rs

impl WorkerAgent {
    pub async fn run(&self) -> Result<()> {
        // Register with Server
        self.register().await?;

        // Start heartbeat thread
        let heartbeat_handle = self.start_heartbeat_loop();

        // Start task lease loop
        let lease_handle = self.start_lease_loop();

        // Wait for shutdown signal
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {
                tracing::info!("Shutting down worker...");
            }
        }

        // Graceful shutdown
        self.shutdown().await?;
        heartbeat_handle.abort();
        lease_handle.abort();

        Ok(())
    }

    async fn register(&self) -> Result<()> {
        let request = RegisterWorkerRequest {
            worker_id: self.worker_id.clone(),
            capabilities: Some(self.capabilities.clone()),
            platform_properties: self.platform_properties.clone(),
        };

        self.scheduler_client.register_worker(request).await?;
        tracing::info!("Worker {} registered", self.worker_id);
        Ok(())
    }

    fn start_heartbeat_loop(&self) -> JoinHandle<()> {
        let scheduler_client = self.scheduler_client.clone();
        let worker_id = self.worker_id.clone();
        let interval = self.config.heartbeat_interval;
        let state = self.state.clone();
        let active_tasks = self.active_tasks.clone();

        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(interval);
            loop {
                ticker.tick().await;

                let current_state = *state.read().await;
                let active_count = active_tasks.read().await.len();

                let request = HeartbeatRequest {
                    worker_id: worker_id.clone(),
                    state: current_state as i32,
                    stats: Some(WorkerStats {
                        active_tasks: active_count as i32,
                        ..Default::default()
                    }),
                };

                if let Err(e) = scheduler_client.report_heartbeat(request).await {
                    tracing::error!("Heartbeat failed: {}", e);
                }
            }
        })
    }

    fn start_lease_loop(&self) -> JoinHandle<()> {
        let scheduler_client = self.scheduler_client.clone();
        let worker_id = self.worker_id.clone();
        let max_concurrent = self.config.max_concurrent_tasks;
        let active_tasks = self.active_tasks.clone();
        let executor = self.executor.clone();
        let cas_client = self.cas_client.clone();

        tokio::spawn(async move {
            loop {
                // Calculate currently available task slots
                let current_active = active_tasks.read().await.len();
                let available_slots = max_concurrent.saturating_sub(current_active);

                if available_slots == 0 {
                    tokio::time::sleep(Duration::from_secs(5)).await;
                    continue;
                }

                // Pull tasks
                let request = LeaseTaskRequest {
                    worker_id: worker_id.clone(),
                    max_tasks: available_slots as i32,
                    timeout_seconds: 30,
                };

                let response = match scheduler_client.lease_task(request).await {
                    Ok(resp) => resp.into_inner(),
                    Err(e) => {
                        tracing::error!("Failed to lease task: {}", e);
                        tokio::time::sleep(Duration::from_secs(5)).await;
                        continue;
                    }
                };

                // Execute assigned tasks
                for task in response.tasks {
                    let executor_clone = executor.clone();
                    let cas_clone = cas_client.clone();
                    let active_tasks_clone = active_tasks.clone();
                    let scheduler_clone = scheduler_client.clone();
                    let worker_id_clone = worker_id.clone();

                    tokio::spawn(async move {
                        Self::execute_task(
                            task,
                            executor_clone,
                            cas_clone,
                            scheduler_clone,
                            worker_id_clone,
                        ).await;

                        active_tasks_clone.write().await.remove(&task.task_id);
                    });
                }
            }
        })
    }

    async fn execute_task(
        task: LeasedTask,
        executor: Arc<dyn TaskExecutor>,
        cas_client: Arc<REClient>,
        scheduler_client: WorkerSchedulerClient<Channel>,
        worker_id: String,
    ) {
        tracing::info!("Executing task {}", task.task_id);

        // Update status to EXECUTING
        let _ = scheduler_client.update_task_status(UpdateTaskStatusRequest {
            task_id: task.task_id.clone(),
            worker_id: worker_id.clone(),
            status: TaskStatus::Executing as i32,
            result: None,
            error_message: None,
        }).await;

        // 1. Download Action
        let action_digest = parse_digest(&task.action_digest).unwrap();
        let action_bytes = cas_client.get_blob(&action_digest).await.unwrap();
        let action = Action::decode(&action_bytes[..]).unwrap();

        // 2. Download Command
        let command_bytes = cas_client.get_blob(action.command_digest.as_ref().unwrap()).await.unwrap();
        let command = Command::decode(&command_bytes[..]).unwrap();

        // 3. Download input directory tree
        let input_root = action.input_root_digest.unwrap();
        let work_dir = std::env::temp_dir().join("worker-tasks").join(&task.task_id);
        cas_client.download_directory(&input_root, &work_dir.join("inputs")).await.unwrap();

        // 4. Execute command
        let exec_result = executor.execute(ExecutionRequest {
            command,
            work_dir: work_dir.clone(),
            timeout: task.timeout,
        }).await;

        match exec_result {
            Ok(result) => {
                // 5. Upload output files
                let action_result = Self::upload_outputs(
                    &result,
                    &work_dir,
                    &cas_client,
                ).await.unwrap();

                // 6. Report completion
                let _ = scheduler_client.update_task_status(UpdateTaskStatusRequest {
                    task_id: task.task_id.clone(),
                    worker_id: worker_id.clone(),
                    status: TaskStatus::Completed as i32,
                    result: Some(action_result),
                    error_message: None,
                }).await;
            }
            Err(e) => {
                // Report failure
                let _ = scheduler_client.update_task_status(UpdateTaskStatusRequest {
                    task_id: task.task_id.clone(),
                    worker_id: worker_id.clone(),
                    status: TaskStatus::Failed as i32,
                    result: None,
                    error_message: Some(e.to_string()),
                }).await;
            }
        }

        // Clean up work directory
        let _ = std::fs::remove_dir_all(&work_dir);
    }

    async fn upload_outputs(
        result: &ExecutionResult,
        work_dir: &Path,
        cas_client: &REClient,
    ) -> Result<ActionResult> {
        // Upload stdout/stderr
        let stdout_digest = if !result.stdout.is_empty() {
            Some(cas_client.put_blob(result.stdout.clone()).await?)
        } else {
            None
        };

        let stderr_digest = if !result.stderr.is_empty() {
            Some(cas_client.put_blob(result.stderr.clone()).await?)
        } else {
            None
        };

        // Upload output files
        let output_files = vec![]; // Actually need to traverse output directory
        let output_directories = vec![];

        Ok(ActionResult {
            output_files,
            output_directories,
            exit_code: result.exit_code,
            stdout_digest,
            stderr_digest,
            ..Default::default()
        })
    }
}
```

### 4.2 Executor Interface

```rust
// worker/src/executor.rs

#[async_trait]
pub trait TaskExecutor: Send + Sync {
    async fn execute(&self, request: ExecutionRequest) -> Result<ExecutionResult>;
}

pub struct ExecutionRequest {
    pub command: Command,
    pub work_dir: PathBuf,
    pub timeout: Duration,
}

pub struct ExecutionResult {
    pub exit_code: i32,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

// Host Executor
pub struct HostExecutor;

#[async_trait]
impl TaskExecutor for HostExecutor {
    async fn execute(&self, request: ExecutionRequest) -> Result<ExecutionResult> {
        use tokio::process::Command as TokioCommand;

        let output = TokioCommand::new(&request.command.arguments[0])
            .args(&request.command.arguments[1..])
            .current_dir(&request.work_dir)
            .output()
            .await?;

        Ok(ExecutionResult {
            exit_code: output.status.code().unwrap_or(-1),
            stdout: output.stdout,
            stderr: output.stderr,
        })
    }
}
```

### 4.3 Worker CLI Commands

```rust
// worker/src/main.rs

#[derive(Parser)]
struct Args {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Pull tasks from Server and run (daemon mode)
    Daemon {
        #[arg(long)]
        server_url: String,

        #[arg(long)]
        cas_url: String,

        #[arg(long, default_value = "host")]
        backend: String, // host, docker

        #[arg(long)]
        config: Option<PathBuf>,
    },

    /// Execute a specific Action once (debug mode)
    Execute {
        #[arg(long)]
        cas_url: String,

        #[arg(long)]
        action_digest: String, // hash/size

        #[arg(long)]
        work_dir: PathBuf,

        #[arg(long, default_value = "host")]
        backend: String,
    },
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();

    match args.command {
        Command::Daemon { server_url, cas_url, backend, config } => {
            let config = if let Some(path) = config {
                WorkerConfig::from_file(&path)?
            } else {
                WorkerConfig::default()
            };

            let agent = WorkerAgent::new(server_url, cas_url, backend, config).await?;
            agent.run().await?;
        }

        Command::Execute { cas_url, action_digest, work_dir, backend } => {
            // Single execution mode (no Server connection)
            let cas_client = REClient::connect(&cas_url).await?;
            let executor = create_executor(&backend)?;

            // Execute Action directly
            execute_action_once(cas_client, executor, action_digest, work_dir).await?;
        }
    }

    Ok(())
}
```

## V. Fault Tolerance and Monitoring Mechanisms

### 5.1 Fault Tolerance Mechanisms

#### 1. **Lease Timeout Handling**
- Server detects lease expiration and automatically re-enqueues the task
- Worker periodically checks if lease is still valid during task execution

#### 2. **Worker Heartbeat Timeout**
- Server detects worker heartbeat timeout (default 2 minutes)
- Mark worker as offline and reassign its tasks

#### 3. **Task Retry Strategy**
```rust
pub struct RetryPolicy {
    pub max_retries: usize,
    pub retry_on_failure: bool,
    pub retry_on_timeout: bool,
}

// Add to QueuedTask
pub struct QueuedTask {
    // ...
    pub retry_count: usize,
    pub max_retries: usize,
}
```

#### 4. **Worker Graceful Shutdown**
```rust
// Worker receives Ctrl+C
- Stop pulling new tasks
- Wait for current tasks to complete (max 5 minutes)
- Send UnregisterWorker
- Exit
```

### 5.2 Monitoring Mechanisms

#### 1. **Metrics Collection**
```rust
pub struct SchedulerMetrics {
    pub queue_length: AtomicUsize,
    pub registered_workers: AtomicUsize,
    pub active_tasks: AtomicUsize,
    pub completed_tasks: AtomicU64,
    pub failed_tasks: AtomicU64,
    pub avg_queue_time: AtomicU64, // milliseconds
    pub avg_execution_time: AtomicU64,
}

// Expose Prometheus metrics
// /metrics endpoint
```

#### 2. **Log Levels**
- **INFO**: Task submission, assignment, completion
- **WARN**: Lease timeout, worker timeout
- **ERROR**: Task failure, worker errors

#### 3. **Health Checks**
```rust
// Server gRPC health check
impl Health for HealthService {
    async fn check(&self) -> HealthCheckResponse {
        // Check Scheduler status
        // Check Worker availability
    }
}

// Worker self-check
- CAS connection healthy
- Sufficient disk space
- Execution environment ready (Docker daemon, etc.)
```

## VI. Configuration Examples

### 6.1 Server Configuration

```toml
# expbuild-server.toml

[server]
address = "0.0.0.0:8980"
instance_name = "production"

[storage.cas]
backend = "filesystem"
root_dir = "/var/lib/expbuild/cas"

[storage.action_cache]
backend = "filesystem"
root_dir = "/var/lib/expbuild/cache"

[execution]
backend = "scheduler" # New: use remote Worker scheduler

[execution.scheduler]
lease_duration_seconds = 300 # 5 minutes
heartbeat_timeout_seconds = 120 # 2 minutes
long_poll_timeout_seconds = 30
max_queue_size = 10000

[capabilities]
exec_enabled = true
```

### 6.2 Worker Configuration

```toml
# expbuild-worker.toml

[worker]
worker_id = "worker-host-01" # Auto-generated or manually specified
server_url = "http://server.example.com:8980"
cas_url = "http://server.example.com:8980"
max_concurrent_tasks = 4
heartbeat_interval_seconds = 30
backend = "host"

[worker.platform]
OSFamily = "Linux"
Arch = "x86_64"
container = "none"

[worker.host]
work_dir = "/tmp/expbuild-worker"
use_sandbox = false
env_whitelist = ["PATH", "HOME"]

# Docker Worker example
# [worker]
# backend = "docker"
# [worker.docker]
# image = "ubuntu:22.04"
# network_mode = "none"
# cpu_limit = 2.0
# memory_limit = 4294967296
```

## VII. Deployment and Usage

### 7.1 Start Server

```bash
./re-server --config expbuild-server.toml --verbose
```

### 7.2 Start Worker

```bash
# Daemon mode
./expbuild-worker daemon \
  --server-url http://localhost:8980 \
  --cas-url http://localhost:8980 \
  --backend host \
  --config worker.toml

# Single execution mode (debug)
./expbuild-worker execute \
  --cas-url http://localhost:8980 \
  --action-digest abc123/456 \
  --work-dir /tmp/test \
  --backend host
```

### 7.3 Client Usage

```bash
# Client needs no changes, still uses Remote Execution API
./expbuild-cli run echo hello \
  --input . \
  --output ./outputs
```

## VIII. Implementation Priorities and Roadmap

### Phase 1: Core Features (2-3 weeks)
1. Define Worker API proto
2. Implement WorkerScheduler
3. Implement WorkerAgent (Host Executor)
4. Integrate ExecutionManager
5. Basic fault tolerance (lease timeout, heartbeat)

### Phase 2: Enhanced Features (1-2 weeks)
1. Docker Executor
2. Task retry strategy
3. Priority queue
4. Metrics and Monitoring

### Phase 3: Production Ready (1 week)
1. Complete logging and tracing
2. Health checks and self-healing
3. Performance optimization (batch upload/download)
4. Documentation and tests

## IX. Advantages and Trade-offs

### Advantages
1. **Horizontal Scaling**: Can dynamically add worker nodes
2. **Resource Isolation**: Workers can be deployed in different environments
3. **Flexibility**: Supports multiple execution backends
4. **Fault Tolerance**: Automatic retry and failover
5. **Backward Compatibility**: Clients need no modifications

### Trade-offs
1. **Increased Complexity**: Need to maintain worker registration and heartbeat
2. **Network Overhead**: Need to upload/download inputs and outputs
3. **Increased Latency**: Task queuing and dispatching has latency
4. **Debugging Difficulty**: Distributed systems are harder to troubleshoot

### Applicable Scenarios
- Large-scale parallel builds needed
- Heterogeneous execution environments needed (different OS/containers)
- Resource isolation and security needed
- Small teams or simple projects (local Worker Pool is simpler)

## X. Extension Directions

### Future Enhancements
1. **Worker Grouping**: Group by capabilities or location
2. **Affinity Scheduling**: Cache-aware scheduling
3. **Resource Reservation**: Reserve resources for large tasks
4. **Spot Workers**: Support preemptible low-cost workers
5. **Kubernetes Integration**: CRD + Operator
