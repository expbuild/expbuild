# 独立 Worker 命令详细实现方案

## 一、架构概述

### 1.1 整体架构

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
│  │  - 创建 Operation (QUEUED)                              │  │
│  │  - 提交任务到 TaskQueue                                  │  │
│  └─────────────────────┬──────────────────────────────────┘  │
│                        ↓                                      │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  Worker Scheduler (新增)                               │  │
│  │  - task_queue: PriorityQueue<ExecutionTask>           │  │
│  │  - registered_workers: HashMap<WorkerId, WorkerInfo>   │  │
│  │  - active_assignments: HashMap<TaskId, WorkerId>       │  │
│  │  - LeaseTask() gRPC - Worker 拉取任务                   │  │
│  │  - UpdateTaskStatus() gRPC - Worker 更新状态            │  │
│  │  - ReportHeartbeat() gRPC - Worker 心跳                 │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  CAS Manager + Action Cache                            │  │
│  └────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
                       ↑
                       │ gRPC (Worker API - 新增)
                       │
┌──────────────────────┴───────────────────────────────────────┐
│              Worker Nodes (expbuild-worker)                  │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  Worker Agent                                          │  │
│  │  - worker_id, capabilities, platform_properties        │  │
│  │  - 拉取循环: LeaseTask() → Execute → UpdateStatus       │  │
│  │  - 心跳线程: ReportHeartbeat() (每 30s)                 │  │
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

### 1.2 通信模式选择

**采用拉取模式 (Pull Model)**，优点：
- Worker 无需暴露端口，可部署在 NAT 后
- Worker 可按自身负载控制拉取频率
- 简化防火墙配置
- 易于实现重试和容错

## 二、协议设计

### 2.1 新增 gRPC 服务定义

需要在 `remote_execution.proto` 或新建 `worker_api.proto`：

```protobuf
service WorkerScheduler {
  // Worker 注册
  rpc RegisterWorker(RegisterWorkerRequest) returns (RegisterWorkerResponse);
  
  // Worker 拉取任务（长轮询）
  rpc LeaseTask(LeaseTaskRequest) returns (LeaseTaskResponse);
  
  // Worker 更新任务状态
  rpc UpdateTaskStatus(UpdateTaskStatusRequest) returns (UpdateTaskStatusResponse);
  
  // Worker 心跳
  rpc ReportHeartbeat(HeartbeatRequest) returns (HeartbeatResponse);
  
  // Worker 注销
  rpc UnregisterWorker(UnregisterWorkerRequest) returns (UnregisterWorkerResponse);
}

message RegisterWorkerRequest {
  string worker_id = 1;
  WorkerCapabilities capabilities = 2;
  map<string, string> platform_properties = 3; // OSFamily, Arch, container, etc.
}

message RegisterWorkerResponse {
  // 空或返回配置信息
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
  int32 max_tasks = 2; // Worker 当前可接受的任务数
  int64 timeout_seconds = 3; // 长轮询超时（如 30s）
}

message LeaseTaskResponse {
  repeated LeasedTask tasks = 1;
}

message LeasedTask {
  string task_id = 1;
  string operation_name = 2;
  string action_digest = 3; // "{hash}/{size}"
  google.protobuf.Duration timeout = 4;
  google.protobuf.Timestamp lease_expires_at = 5; // 租约过期时间
}

message UpdateTaskStatusRequest {
  string task_id = 1;
  string worker_id = 2;
  TaskStatus status = 3;
  ActionResult result = 4; // 如果完成
  string error_message = 5; // 如果失败
}

enum TaskStatus {
  UNKNOWN = 0;
  EXECUTING = 1;
  COMPLETED = 2;
  FAILED = 3;
}

message UpdateTaskStatusResponse {
  // 空或返回确认
}

message HeartbeatRequest {
  string worker_id = 1;
  WorkerState state = 2;
  WorkerStats stats = 3;
}

enum WorkerState {
  IDLE = 0;
  BUSY = 1;
  DRAINING = 2; // 准备停机
}

message WorkerStats {
  int32 active_tasks = 1;
  int64 total_completed = 2;
  int64 total_failed = 3;
}

message HeartbeatResponse {
  bool should_shutdown = 1; // Server 可以通知 Worker 停机
}

message UnregisterWorkerRequest {
  string worker_id = 1;
}

message UnregisterWorkerResponse {}
```

### 2.2 数据结构设计

#### Server 端新增数据结构

```rust
// re_server/src/execution/scheduler.rs

pub struct WorkerScheduler {
    // 任务队列（优先级队列）
    task_queue: Arc<Mutex<PriorityQueue<QueuedTask>>>,
    
    // 已注册的 Worker
    registered_workers: Arc<RwLock<HashMap<String, RegisteredWorker>>>,
    
    // 活跃的任务分配
    active_leases: Arc<RwLock<HashMap<String, TaskLease>>>,
    
    // 任务结果（待 ExecutionManager 获取）
    task_results: Arc<Mutex<HashMap<String, TaskResult>>>,
    
    // CAS 访问
    cas_manager: Arc<CasManager>,
    
    // 配置
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
    pub priority: i32, // 支持优先级
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
    pub lease_duration: Duration, // 默认 5 分钟
    pub heartbeat_timeout: Duration, // 默认 2 分钟
    pub long_poll_timeout: Duration, // 默认 30 秒
    pub max_queue_size: usize,
}
```

#### Worker 端数据结构

```rust
// worker/src/agent.rs

pub struct WorkerAgent {
    pub worker_id: String,
    pub capabilities: WorkerCapabilities,
    pub platform_properties: HashMap<String, String>,
    
    // gRPC 客户端
    scheduler_client: WorkerSchedulerClient<Channel>,
    cas_client: Arc<REClient>,
    
    // 执行器
    executor: Arc<dyn TaskExecutor>,
    
    // 状态
    state: Arc<RwLock<WorkerState>>,
    active_tasks: Arc<RwLock<HashMap<String, TaskExecution>>>,
    
    // 配置
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

## 三、Server 端实现方案

### 3.1 WorkerScheduler 实现

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
    
    // 提交任务（由 ExecutionManager 调用）
    pub async fn submit_task(&self, task: QueuedTask) -> Result<String> {
        let mut queue = self.task_queue.lock().await;
        if queue.len() >= self.config.max_queue_size {
            anyhow::bail!("Task queue full");
        }
        queue.push(task.task_id.clone(), task);
        Ok(task_id)
    }
    
    // Worker 拉取任务（gRPC 方法）
    pub async fn lease_task(
        &self,
        worker_id: String,
        max_tasks: usize,
        timeout: Duration,
    ) -> Result<Vec<LeasedTask>> {
        let deadline = SystemTime::now() + timeout;
        
        loop {
            // 检查是否有匹配的任务
            let tasks = self.try_lease_tasks(&worker_id, max_tasks).await?;
            if !tasks.is_empty() {
                return Ok(tasks);
            }
            
            // 长轮询：等待或超时
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
        
        // 匹配 Platform 并分配任务
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
    
    // Worker 更新任务状态（gRPC 方法）
    pub async fn update_task_status(
        &self,
        task_id: String,
        worker_id: String,
        status: TaskStatus,
        result: Option<ActionResult>,
        error: Option<String>,
    ) -> Result<()> {
        // 验证租约
        let mut leases = self.active_leases.write().await;
        let lease = leases.get(&task_id)
            .ok_or_else(|| anyhow::anyhow!("No active lease for task"))?;
        
        if lease.worker_id != worker_id {
            anyhow::bail!("Worker ID mismatch");
        }
        
        match status {
            TaskStatus::Executing => {
                // 更新 ExecutionManager 中的 Operation 状态
                // (通过回调或共享状态)
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
    
    // Worker 心跳（gRPC 方法）
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
    
    // 后台任务：检测超时的租约和心跳
    pub async fn start_maintenance_loop(self: Arc<Self>) {
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(30));
            loop {
                interval.tick().await;
                
                // 检查租约超时
                self.check_lease_timeouts().await;
                
                // 检查 Worker 心跳超时
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
                // 重新加入队列（需要从原始任务恢复）
                // 实际实现中需要保存原始任务信息
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
            // 重新分配该 Worker 的任务
        }
    }
}
```

### 3.2 ExecutionManager 集成

```rust
// re_server/src/execution/manager.rs

pub struct ExecutionManager {
    cas_manager: Arc<CasManager>,
    cache_manager: Arc<ActionCacheManager>,
    scheduler: Arc<WorkerScheduler>, // 新增
    operations: Arc<RwLock<HashMap<String, OperationState>>>,
}

impl ExecutionManager {
    pub async fn execute_action(
        &self,
        action_digest: Digest,
        skip_cache: bool,
    ) -> Result<String> {
        let operation_name = self.create_operation(action_digest.clone(), skip_cache).await?;
        
        // 获取 Action 和 Command
        let action = self.get_action(&action_digest).await?;
        let command = self.get_command(&action).await?;
        
        // 提交到 Scheduler
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
        
        // 启动后台任务监听结果
        let exec_mgr = Arc::new(self.clone());
        let scheduler = self.scheduler.clone();
        let op_name = operation_name.clone();
        
        tokio::spawn(async move {
            // 等待 Scheduler 中的结果
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

### 3.3 gRPC 服务实现

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

## 四、Worker 端实现方案

### 4.1 Worker Agent 核心逻辑

```rust
// worker/src/agent.rs

impl WorkerAgent {
    pub async fn run(&self) -> Result<()> {
        // 注册到 Server
        self.register().await?;
        
        // 启动心跳线程
        let heartbeat_handle = self.start_heartbeat_loop();
        
        // 启动任务拉取循环
        let lease_handle = self.start_lease_loop();
        
        // 等待关闭信号
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {
                tracing::info!("Shutting down worker...");
            }
        }
        
        // 优雅关闭
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
                // 计算当前可接受任务数
                let current_active = active_tasks.read().await.len();
                let available_slots = max_concurrent.saturating_sub(current_active);
                
                if available_slots == 0 {
                    tokio::time::sleep(Duration::from_secs(5)).await;
                    continue;
                }
                
                // 拉取任务
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
                
                // 执行分配的任务
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
        
        // 更新状态为 EXECUTING
        let _ = scheduler_client.update_task_status(UpdateTaskStatusRequest {
            task_id: task.task_id.clone(),
            worker_id: worker_id.clone(),
            status: TaskStatus::Executing as i32,
            result: None,
            error_message: None,
        }).await;
        
        // 1. 下载 Action
        let action_digest = parse_digest(&task.action_digest).unwrap();
        let action_bytes = cas_client.get_blob(&action_digest).await.unwrap();
        let action = Action::decode(&action_bytes[..]).unwrap();
        
        // 2. 下载 Command
        let command_bytes = cas_client.get_blob(action.command_digest.as_ref().unwrap()).await.unwrap();
        let command = Command::decode(&command_bytes[..]).unwrap();
        
        // 3. 下载输入目录树
        let input_root = action.input_root_digest.unwrap();
        let work_dir = std::env::temp_dir().join("worker-tasks").join(&task.task_id);
        cas_client.download_directory(&input_root, &work_dir.join("inputs")).await.unwrap();
        
        // 4. 执行命令
        let exec_result = executor.execute(ExecutionRequest {
            command,
            work_dir: work_dir.clone(),
            timeout: task.timeout,
        }).await;
        
        match exec_result {
            Ok(result) => {
                // 5. 上传输出文件
                let action_result = Self::upload_outputs(
                    &result,
                    &work_dir,
                    &cas_client,
                ).await.unwrap();
                
                // 6. 报告完成
                let _ = scheduler_client.update_task_status(UpdateTaskStatusRequest {
                    task_id: task.task_id.clone(),
                    worker_id: worker_id.clone(),
                    status: TaskStatus::Completed as i32,
                    result: Some(action_result),
                    error_message: None,
                }).await;
            }
            Err(e) => {
                // 报告失败
                let _ = scheduler_client.update_task_status(UpdateTaskStatusRequest {
                    task_id: task.task_id.clone(),
                    worker_id: worker_id.clone(),
                    status: TaskStatus::Failed as i32,
                    result: None,
                    error_message: Some(e.to_string()),
                }).await;
            }
        }
        
        // 清理工作目录
        let _ = std::fs::remove_dir_all(&work_dir);
    }
    
    async fn upload_outputs(
        result: &ExecutionResult,
        work_dir: &Path,
        cas_client: &REClient,
    ) -> Result<ActionResult> {
        // 上传 stdout/stderr
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
        
        // 上传输出文件
        let output_files = vec![]; // 实际需要遍历输出目录
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

### 4.2 执行器接口

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

### 4.3 Worker CLI 命令

```rust
// worker/src/main.rs

#[derive(Parser)]
struct Args {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// 从 Server 拉取任务运行（守护模式）
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
    
    /// 单次执行指定 Action（调试模式）
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
            // 单次执行模式（不连接 Server）
            let cas_client = REClient::connect(&cas_url).await?;
            let executor = create_executor(&backend)?;
            
            // 直接执行 Action
            execute_action_once(cas_client, executor, action_digest, work_dir).await?;
        }
    }
    
    Ok(())
}
```

## 五、容错和监控机制

### 5.1 容错机制

#### 1. **租约超时处理**
- Server 检测到租约过期，自动将任务重新加入队列
- Worker 在执行任务时定期检查租约是否仍有效

#### 2. **Worker 心跳超时**
- Server 检测到 Worker 心跳超时（默认 2 分钟）
- 标记 Worker 为离线，重新分配其任务

#### 3. **任务重试策略**
```rust
pub struct RetryPolicy {
    pub max_retries: usize,
    pub retry_on_failure: bool,
    pub retry_on_timeout: bool,
}

// 在 QueuedTask 中添加
pub struct QueuedTask {
    // ...
    pub retry_count: usize,
    pub max_retries: usize,
}
```

#### 4. **Worker 优雅停机**
```rust
// Worker 收到 Ctrl+C
- 停止拉取新任务
- 等待当前任务完成（最多 5 分钟）
- 发送 UnregisterWorker
- 退出
```

### 5.2 监控机制

#### 1. **指标收集**
```rust
pub struct SchedulerMetrics {
    pub queue_length: AtomicUsize,
    pub registered_workers: AtomicUsize,
    pub active_tasks: AtomicUsize,
    pub completed_tasks: AtomicU64,
    pub failed_tasks: AtomicU64,
    pub avg_queue_time: AtomicU64, // 毫秒
    pub avg_execution_time: AtomicU64,
}

// 暴露 Prometheus metrics
// /metrics endpoint
```

#### 2. **日志级别**
- **INFO**: 任务提交、分配、完成
- **WARN**: 租约超时、Worker 超时
- **ERROR**: 任务失败、Worker 错误

#### 3. **健康检查**
```rust
// Server gRPC 健康检查
impl Health for HealthService {
    async fn check(&self) -> HealthCheckResponse {
        // 检查 Scheduler 状态
        // 检查 Worker 可用性
    }
}

// Worker 自检
- CAS 连接正常
- 磁盘空间充足
- 执行环境就绪（Docker daemon 等）
```

## 六、配置示例

### 6.1 Server 配置

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
backend = "scheduler" # 新增：使用远程 Worker 调度器

[execution.scheduler]
lease_duration_seconds = 300 # 5 分钟
heartbeat_timeout_seconds = 120 # 2 分钟
long_poll_timeout_seconds = 30
max_queue_size = 10000

[capabilities]
exec_enabled = true
```

### 6.2 Worker 配置

```toml
# expbuild-worker.toml

[worker]
worker_id = "worker-host-01" # 自动生成或手动指定
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

# Docker Worker 示例
# [worker]
# backend = "docker"
# [worker.docker]
# image = "ubuntu:22.04"
# network_mode = "none"
# cpu_limit = 2.0
# memory_limit = 4294967296
```

## 七、部署和使用

### 7.1 启动 Server

```bash
./re-server --config expbuild-server.toml --verbose
```

### 7.2 启动 Worker

```bash
# 守护模式
./expbuild-worker daemon \
  --server-url http://localhost:8980 \
  --cas-url http://localhost:8980 \
  --backend host \
  --config worker.toml

# 单次执行模式（调试）
./expbuild-worker execute \
  --cas-url http://localhost:8980 \
  --action-digest abc123/456 \
  --work-dir /tmp/test \
  --backend host
```

### 7.3 客户端使用

```bash
# 客户端无需任何改动，仍然使用 Remote Execution API
./expbuild-cli run echo hello \
  --input . \
  --output ./outputs
```

## 八、实现优先级和路线图

### Phase 1: 核心功能（2-3 周）
1. ✅ 定义 Worker API proto
2. ✅ 实现 WorkerScheduler
3. ✅ 实现 WorkerAgent (Host Executor)
4. ✅ 集成 ExecutionManager
5. ✅ 基本容错（租约超时、心跳）

### Phase 2: 增强功能（1-2 周）
1. Docker Executor
2. 任务重试策略
3. 优先级队列
4. Metrics 和 Monitoring

### Phase 3: 生产就绪（1 周）
1. 完整日志和追踪
2. 健康检查和自愈
3. 性能优化（批量上传下载）
4. 文档和测试

## 九、优势和权衡

### 优势
1. **水平扩展**: 可动态增加 Worker 节点
2. **资源隔离**: Worker 可部署在不同环境
3. **灵活性**: 支持多种执行后端
4. **容错性**: 自动重试和故障转移
5. **向后兼容**: 客户端无需修改

### 权衡
1. **复杂性增加**: 需要维护 Worker 注册和心跳
2. **网络开销**: 需要上传下载输入输出
3. **延迟增加**: 任务排队和分发有延迟
4. **调试难度**: 分布式系统更难排查问题

### 适用场景
- ✅ 需要大规模并行构建
- ✅ 需要异构执行环境（不同 OS/容器）
- ✅ 需要资源隔离和安全性
- ❌ 小型团队或简单项目（用本地 Worker Pool 更简单）

## 十、扩展方向

### 未来可能增强
1. **Worker 分组**: 按能力或位置分组
2. **亲和性调度**: 缓存感知调度
3. **资源预留**: 为大任务预留资源
4. **Spot Worker**: 支持可抢占的低成本 Worker
5. **Kubernetes 集成**: CRD + Operator
