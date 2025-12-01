use super::worker::*;
use crate::cas::CasManager;
use anyhow::{Context, Result};
use async_trait::async_trait;
use re_grpc_proto::build::bazel::remote::execution::v2::Platform;
use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use std::time::{Duration, SystemTime};
use tokio::sync::{oneshot, Mutex, RwLock};
use uuid::Uuid;

pub struct DefaultWorkerPool {
    workers: Arc<RwLock<HashMap<String, Arc<dyn Worker>>>>,
    
    task_queue: Arc<Mutex<VecDeque<QueuedTask>>>,
    
    active_tasks: Arc<RwLock<HashMap<String, ActiveTask>>>,
    
    task_results: Arc<Mutex<HashMap<String, TaskResult>>>,
    
    cas_manager: Arc<CasManager>,
    
    config: WorkerPoolConfig,
    
    scheduler_handle: Arc<Mutex<Option<tokio::task::JoinHandle<()>>>>,
    
    stats: Arc<RwLock<WorkerPoolStats>>,
    
    shutdown_signal: Arc<Mutex<Option<oneshot::Sender<()>>>>,
}

impl Clone for DefaultWorkerPool {
    fn clone(&self) -> Self {
        Self {
            workers: self.workers.clone(),
            task_queue: self.task_queue.clone(),
            active_tasks: self.active_tasks.clone(),
            task_results: self.task_results.clone(),
            cas_manager: self.cas_manager.clone(),
            config: self.config.clone(),
            scheduler_handle: self.scheduler_handle.clone(),
            stats: self.stats.clone(),
            shutdown_signal: self.shutdown_signal.clone(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct WorkerPoolConfig {
    pub max_queue_size: usize,
    pub scheduler_interval: Duration,
    pub default_task_timeout: Duration,
    pub result_ttl: Duration,
}

impl Default for WorkerPoolConfig {
    fn default() -> Self {
        Self {
            max_queue_size: 1000,
            scheduler_interval: Duration::from_millis(100),
            default_task_timeout: Duration::from_secs(3600),
            result_ttl: Duration::from_secs(300),
        }
    }
}

struct QueuedTask {
    task_id: String,
    operation_name: String,
    action: re_grpc_proto::build::bazel::remote::execution::v2::Action,
    command: re_grpc_proto::build::bazel::remote::execution::v2::Command,
    input_root_digest: re_grpc_proto::build::bazel::remote::execution::v2::Digest,
    platform: Option<Platform>,
    timeout: Duration,
    enqueued_at: SystemTime,
}

struct ActiveTask {
    worker_id: String,
    started_at: SystemTime,
}

enum TaskResult {
    Success(WorkerExecutionResult),
    Failed(String),
}

impl DefaultWorkerPool {
    pub fn new(cas_manager: Arc<CasManager>, config: WorkerPoolConfig) -> Arc<Self> {
        Arc::new(Self {
            workers: Arc::new(RwLock::new(HashMap::new())),
            task_queue: Arc::new(Mutex::new(VecDeque::new())),
            active_tasks: Arc::new(RwLock::new(HashMap::new())),
            task_results: Arc::new(Mutex::new(HashMap::new())),
            cas_manager,
            config,
            scheduler_handle: Arc::new(Mutex::new(None)),
            stats: Arc::new(RwLock::new(WorkerPoolStats::default())),
            shutdown_signal: Arc::new(Mutex::new(None)),
        })
    }
    
    pub async fn start(self: &Arc<Self>) {
        let (shutdown_tx, mut shutdown_rx) = oneshot::channel();
        *self.shutdown_signal.lock().await = Some(shutdown_tx);
        
        let pool = self.clone();
        let interval = self.config.scheduler_interval;
        
        let handle = tokio::spawn(async move {
            let mut ticker = tokio::time::interval(interval);
            
            loop {
                tokio::select! {
                    _ = ticker.tick() => {
                        if let Err(e) = pool.schedule_tasks().await {
                            tracing::error!("Scheduler error: {}", e);
                        }
                    }
                    _ = &mut shutdown_rx => {
                        tracing::info!("Worker pool scheduler shutting down");
                        break;
                    }
                }
            }
        });
        
        *self.scheduler_handle.lock().await = Some(handle);
    }
    
    async fn schedule_tasks(&self) -> Result<()> {
        let workers = self.workers.read().await;
        let mut queue = self.task_queue.lock().await;
        
        if queue.is_empty() {
            return Ok(());
        }
        
        tracing::debug!(
            "Scheduler: {} tasks in queue, checking for idle workers",
            queue.len()
        );
        
        let idle_workers: Vec<_> = workers
            .iter()
            .filter(|(_, w)| w.state() == WorkerState::Idle)
            .collect();
        
        if idle_workers.is_empty() {
            tracing::debug!("Scheduler: No idle workers available");
            return Ok(());
        }
        
        tracing::debug!(
            "Scheduler: {} idle workers available",
            idle_workers.len()
        );
        
        let mut tasks_to_execute = Vec::new();
        
        for (worker_id, worker) in idle_workers {
            if queue.is_empty() {
                break;
            }
            
            if let Some(pos) = queue.iter().position(|task| {
                Self::platform_matches(task.platform.as_ref(), worker.capabilities())
            }) {
                let task = queue.remove(pos).unwrap();
                tasks_to_execute.push((worker_id.clone(), worker.clone(), task));
            }
        }
        
        drop(queue);
        drop(workers);
        
        tracing::info!(
            "Scheduler: Dispatching {} tasks to workers",
            tasks_to_execute.len()
        );
        
        for (worker_id, worker, task) in tasks_to_execute {
            self.execute_task_on_worker(worker_id, worker, task).await?;
        }
        
        Ok(())
    }
    
    async fn execute_task_on_worker(
        &self,
        worker_id: String,
        worker: Arc<dyn Worker>,
        task: QueuedTask,
    ) -> Result<()> {
        let task_id = task.task_id.clone();
        
        tracing::info!(
            "Dispatching task {} to worker {} (platform: {:?})",
            task_id,
            worker_id,
            task.platform
        );

        self.active_tasks.write().await.insert(
            task_id.clone(),
            ActiveTask {
                worker_id: worker_id.clone(),
                started_at: SystemTime::now(),
            },
        );

        {
            let mut stats = self.stats.write().await;
            stats.queued_tasks = stats.queued_tasks.saturating_sub(1);
            stats.busy_workers += 1;
        }

        let pool = self.clone();
        let cas_manager = self.cas_manager.clone();
        
        tokio::spawn(async move {
            let work_dir = std::env::temp_dir().join("expbuild-exec").join(&task.task_id);
            
            let request = WorkerExecutionRequest {
                task_id: task.task_id.clone(),
                action: task.action,
                command: task.command,
                input_root_digest: task.input_root_digest,
                platform: task.platform,
                timeout: task.timeout,
                paths: ExecutionPaths {
                    work_dir: work_dir.clone(),
                    input_root: work_dir.join("inputs"),
                    output_dir: work_dir.join("outputs"),
                },
            };
            tracing::info!(
            "Dispatched task {} to worker {}",
            task_id,
            worker_id
            );
            let result = worker.execute(request).await;
            
            pool.active_tasks.write().await.remove(&task.task_id);
            
            let mut stats: tokio::sync::RwLockWriteGuard<'_, WorkerPoolStats> = pool.stats.write().await;
            stats.busy_workers = stats.busy_workers.saturating_sub(1);
            
            match result {
                Ok(exec_result) => {
                    stats.completed_tasks += 1;
                    tracing::info!(
                        "Task {} completed successfully on worker {}: exit_code={}, duration={:.2}s",
                        task.task_id,
                        worker_id,
                        exec_result.exit_code,
                        exec_result.execution_metadata.execution_duration.as_secs_f64()
                    );
                    pool.task_results.lock().await.insert(
                        task.task_id.clone(),
                        TaskResult::Success(exec_result),
                    );
                }
                Err(e) => {
                    stats.failed_tasks += 1;
                    tracing::error!(
                        "Task {} failed on worker {}: {}",
                        task.task_id,
                        worker_id,
                        e
                    );
                    pool.task_results.lock().await.insert(
                        task.task_id.clone(),
                        TaskResult::Failed(e.to_string()),
                    );
                }
            }
        });
        
        Ok(())
    }
    
    fn platform_matches(required: Option<&Platform>, worker_caps: &WorkerCapabilities) -> bool {
        let Some(platform) = required else {
            return true;
        };
        
        for property in &platform.properties {
            if let Some(worker_value) = worker_caps.platform_properties.get(&property.name) {
                if worker_value != &property.value {
                    return false;
                }
            } else {
                return false;
            }
        }
        true
    }
    
    pub async fn register_worker(&self, worker: Arc<dyn Worker>) -> Result<()> {
        let worker_id = worker.worker_id().to_string();
        tracing::info!(
            "Registering worker: id={}, platform={:?}",
            worker_id,
            worker.capabilities().platform_properties
        );
        self.workers.write().await.insert(worker_id, worker);
        {
            let mut stats = self.stats.write().await;
            stats.total_workers += 1;
            stats.idle_workers += 1;
        }
        Ok(())
    }
    
    pub async fn unregister_worker(&self, worker_id: &str) -> Result<()> {
        if let Some(_worker) = self.workers.write().await.remove(worker_id) {
            let mut stats = self.stats.write().await;
            stats.total_workers = stats.total_workers.saturating_sub(1);
            stats.idle_workers = stats.idle_workers.saturating_sub(1);
        }
        Ok(())
    }
    
    async fn cleanup_old_results(&self) {
        let mut results = self.task_results.lock().await;
        let cutoff = SystemTime::now() - self.config.result_ttl;
        
        results.retain(|_, _| {
            true
        });
    }
}

#[async_trait]
impl WorkerPool for DefaultWorkerPool {
    async fn submit_task(&self, task: ExecutionTask) -> Result<TaskHandle> {
        let mut queue = self.task_queue.lock().await;
        
        if queue.len() >= self.config.max_queue_size {
            anyhow::bail!("Task queue is full");
        }
        
        tracing::info!(
            "Submitting task: task_id={}, operation={}, platform={:?}",
            task.task_id,
            task.operation_name,
            task.platform
        );
        
        let queued_task = QueuedTask {
            task_id: task.task_id.clone(),
            operation_name: task.operation_name.clone(),
            action: task.action,
            command: task.command,
            input_root_digest: task.input_root_digest,
            platform: task.platform,
            timeout: task.timeout,
            enqueued_at: SystemTime::now(),
        };
        
        queue.push_back(queued_task);
        self.stats.write().await.queued_tasks += 1;
        
        tracing::debug!(
            "Task {} queued, queue size: {}",
            task.task_id,
            queue.len()
        );
        
        Ok(TaskHandle {
            task_id: task.task_id,
            operation_name: task.operation_name,
        })
    }
    
    async fn wait_for_task(&self, handle: TaskHandle) -> Result<WorkerExecutionResult> {
        let timeout = self.config.default_task_timeout + Duration::from_secs(60);
        let start = SystemTime::now();
        
        loop {
            if SystemTime::now().duration_since(start)? > timeout {
                anyhow::bail!("Timeout waiting for task {}", handle.task_id);
            }
            
            let mut results = self.task_results.lock().await;
            
            if let Some(result) = results.remove(&handle.task_id) {
                return match result {
                    TaskResult::Success(exec_result) => Ok(exec_result),
                    TaskResult::Failed(error) => {
                        anyhow::bail!("Task failed: {}", error)
                    }
                };
            }
            
            drop(results);
            
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }
    
    async fn cancel_task(&self, handle: &TaskHandle) -> Result<()> {
        let mut queue = self.task_queue.lock().await;
        
        if let Some(pos) = queue.iter().position(|t| t.task_id == handle.task_id) {
            queue.remove(pos);
            drop(queue);
            {
                let mut stats = self.stats.write().await;
                stats.queued_tasks = stats.queued_tasks.saturating_sub(1);
            }
            return Ok(());
        }
        
        drop(queue);
        
        let active = self.active_tasks.read().await;
        if active.contains_key(&handle.task_id) {
            tracing::warn!("Cannot cancel task {} - already executing", handle.task_id);
            return Ok(());
        }
        
        Ok(())
    }
    
    async fn get_stats(&self) -> WorkerPoolStats {
        self.stats.read().await.clone()
    }
    
    async fn shutdown(&self) -> Result<()> {
        if let Some(tx) = self.shutdown_signal.lock().await.take() {
            let _ = tx.send(());
        }
        
        if let Some(handle) = self.scheduler_handle.lock().await.take() {
            handle.await?;
        }
        
        let workers = self.workers.read().await;
        for worker in workers.values() {
            worker.shutdown().await?;
        }
        
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::execution::host_worker::{HostWorker, HostWorkerConfig};
    use crate::storage::FileSystemBlobStore;
    use tempfile::TempDir;
    
    #[tokio::test]
    async fn test_worker_pool_submit_and_execute() {
        let temp_dir = TempDir::new().unwrap();
        let blob_store = Arc::new(FileSystemBlobStore::new(temp_dir.path().to_path_buf()));
        let cas_manager = Arc::new(CasManager::new(blob_store));
        
        let config = WorkerPoolConfig::default();
        let pool = DefaultWorkerPool::new(cas_manager.clone(), config);
        
        let worker_config = HostWorkerConfig {
            work_dir: temp_dir.path().join("workers"),
            ..Default::default()
        };
        let worker = Arc::new(HostWorker::new(
            "test-worker-1".to_string(),
            worker_config,
            cas_manager.clone(),
        ));
        
        pool.register_worker(worker).await.unwrap();
        pool.start().await;
        
        let empty_dir = re_grpc_proto::build::bazel::remote::execution::v2::Directory {
            files: vec![],
            directories: vec![],
            symlinks: vec![],
            node_properties: None,
        };
        let input_digest = cas_manager.put_directory(&empty_dir).await.unwrap();
        
        let task = ExecutionTask {
            task_id: Uuid::new_v4().to_string(),
            operation_name: "test-op".to_string(),
            action: re_grpc_proto::build::bazel::remote::execution::v2::Action {
                command_digest: None,
                input_root_digest: Some(input_digest.clone()),
                timeout: None,
                do_not_cache: false,
                salt: vec![],
                platform: None,
                output_node_properties: None,
            },
            command: re_grpc_proto::build::bazel::remote::execution::v2::Command {
                arguments: vec!["echo".to_string(), "test".to_string()],
                environment_variables: vec![],
                output_paths: vec![],
                platform: None,
                working_directory: String::new(),
                output_files: vec![],
                output_directories: vec![],
                output_paths_v2: vec![],
                output_node_properties: vec![],
            },
            input_root_digest: input_digest,
            platform: None,
            timeout: Duration::from_secs(10),
        };
        
        let handle = pool.submit_task(task).await.unwrap();
        
        tokio::time::sleep(Duration::from_secs(2)).await;
        
        let result = pool.wait_for_task(handle).await.unwrap();
        assert_eq!(result.exit_code, 0);
        
        pool.shutdown().await.unwrap();
    }
}
