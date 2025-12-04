use crate::cache::ActionCacheManager;
use crate::cas::CasManager;
use super::scheduler::{WorkerScheduler, QueuedTask};
use anyhow::Result;
use re_grpc_proto::build::bazel::remote::execution::v2::{
    execution_stage, ActionResult, Digest, ExecuteOperationMetadata,
    ExecuteResponse,
};
use re_grpc_proto::google::longrunning::Operation;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::RwLock;
use uuid::Uuid;

pub struct ExecutionManager {
    cas_manager: Arc<CasManager>,
    cache_manager: Arc<ActionCacheManager>,
    worker_scheduler: Option<Arc<WorkerScheduler>>,
    operations: Arc<RwLock<HashMap<String, OperationState>>>,
}

pub struct OperationState {
    pub operation_name: String,
    pub action_digest: Digest,
    pub stage: i32,
    pub metadata: ExecuteOperationMetadata,
    pub result: Option<ActionResult>,
    pub done: bool,
}

impl ExecutionManager {
    pub fn new(
        cas_manager: Arc<CasManager>,
        cache_manager: Arc<ActionCacheManager>,
    ) -> Self {
        Self {
            cas_manager,
            cache_manager,
            worker_scheduler: None,
            operations: Arc::new(RwLock::new(HashMap::new())),
        }
    }
    
    pub fn with_worker_scheduler(
        cas_manager: Arc<CasManager>,
        cache_manager: Arc<ActionCacheManager>,
        worker_scheduler: Arc<WorkerScheduler>,
    ) -> Self {
        Self {
            cas_manager,
            cache_manager,
            worker_scheduler: Some(worker_scheduler),
            operations: Arc::new(RwLock::new(HashMap::new())),
        }
    }
    
    pub fn generate_operation_name(&self) -> String {
        format!("operations/{}", Uuid::new_v4())
    }
    
    pub async fn get_operation(&self, operation_name: &str) -> Option<Operation> {
        let operations = self.operations.read().await;
        operations.get(operation_name).map(|state| self.build_operation(state))
    }
    
    fn build_operation(&self, state: &OperationState) -> Operation {
        use prost::Message;
        
        let metadata = {
            let mut buf = Vec::new();
            state.metadata.encode(&mut buf).ok();
            Some(prost_types::Any {
                type_url: "type.googleapis.com/build.bazel.remote.execution.v2.ExecuteOperationMetadata".to_string(),
                value: buf,
            })
        };
        
        let response = state.result.as_ref().map(|result| {
            let mut buf = Vec::new();
            let exec_response = ExecuteResponse {
                result: Some(result.clone()),
                cached_result: false,
                status: None,
                server_logs: HashMap::new(),
                message: String::new(),
            };
            exec_response.encode(&mut buf).ok();
            prost_types::Any {
                type_url: "type.googleapis.com/build.bazel.remote.execution.v2.ExecuteResponse".to_string(),
                value: buf,
            }
        });
        
        Operation {
            name: state.operation_name.clone(),
            metadata,
            done: state.done,
            result: response.map(|r| re_grpc_proto::google::longrunning::operation::Result::Response(r)),
        }
    }
    
    pub async fn create_operation(
        &self,
        action_digest: Digest,
        skip_cache: bool,
    ) -> Result<String> {
        let operation_name = self.generate_operation_name();
        
        if !skip_cache {
            if let Some(cached_result) = self.cache_manager.get_action_result(&action_digest).await? {
                tracing::info!("Action result found in cache");
                
                let state = OperationState {
                    operation_name: operation_name.clone(),
                    action_digest: action_digest.clone(),
                    stage: execution_stage::Value::Completed as i32,
                    metadata: ExecuteOperationMetadata {
                        stage: execution_stage::Value::Completed as i32,
                        action_digest: Some(action_digest),
                        stdout_stream_name: String::new(),
                        stderr_stream_name: String::new(),
                        partial_execution_metadata: None,
                        digest_function: 1,
                    },
                    result: Some(cached_result),
                    done: true,
                };
                
                self.operations.write().await.insert(operation_name.clone(), state);
                return Ok(operation_name);
            }
        }
        
        let state = OperationState {
            operation_name: operation_name.clone(),
            action_digest: action_digest.clone(),
            stage: execution_stage::Value::Queued as i32,
            metadata: ExecuteOperationMetadata {
                stage: execution_stage::Value::Queued as i32,
                action_digest: Some(action_digest),
                stdout_stream_name: String::new(),
                stderr_stream_name: String::new(),
                partial_execution_metadata: None,
                digest_function: 1,
            },
            result: None,
            done: false,
        };
        
        self.operations.write().await.insert(operation_name.clone(), state);
        
        Ok(operation_name)
    }
    
    pub async fn update_operation_stage(&self, operation_name: &str, stage: i32) {
        let mut operations = self.operations.write().await;
        if let Some(state) = operations.get_mut(operation_name) {
            state.stage = stage;
            state.metadata.stage = stage;
        }
    }
    
    pub async fn complete_operation(
        &self,
        operation_name: &str,
        result: ActionResult,
    ) -> Result<()> {
        let mut operations = self.operations.write().await;
        if let Some(state) = operations.get_mut(operation_name) {
            state.stage = execution_stage::Value::Completed as i32;
            state.metadata.stage = execution_stage::Value::Completed as i32;
            state.result = Some(result.clone());
            state.done = true;
            
            self.cache_manager
                .put_action_result(&state.action_digest, &result)
                .await?;
        }
        Ok(())
    }
    
    pub async fn execute_action(
        &self,
        action_digest: Digest,
        skip_cache: bool,
    ) -> Result<String> {
        let operation_name = self.create_operation(action_digest.clone(), skip_cache).await?;
        
        // If using worker scheduler (remote workers)
        if let Some(ref scheduler) = self.worker_scheduler {
            let task_id = Uuid::new_v4().to_string();
            let op_name = operation_name.clone();
            let task = QueuedTask {
                task_id: task_id.clone(),
                operation_name: operation_name.clone(),
                action_digest: action_digest.clone(),
                platform: None,
                timeout: Duration::from_secs(3600),
                priority: 0,
                enqueued_at: std::time::SystemTime::now(),
            };
            
            scheduler.submit_task(task).await?;
            
            // Start background task to monitor results
            let exec_mgr = Arc::new(self.clone());
            let scheduler_clone = scheduler.clone();
            
            tokio::spawn(async move {
                loop {
                    if let Some(result) = scheduler_clone.get_task_result(&task_id).await {
                        match result {
                            super::scheduler::TaskResult::Success(action_result) => {
                                exec_mgr.complete_operation(&op_name, action_result).await.ok();
                            }
                            super::scheduler::TaskResult::Failed(error) => {
                                tracing::error!("Task {} failed: {}", task_id, error);
                            }
                        }
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(500)).await;
                }
            });
            
            return Ok(operation_name);
        }
        
        tracing::warn!("No worker scheduler configured, execution will not proceed");
        Ok(operation_name)
    }
}

impl Clone for ExecutionManager {
    fn clone(&self) -> Self {
        Self {
            cas_manager: self.cas_manager.clone(),
            cache_manager: self.cache_manager.clone(),
            worker_scheduler: self.worker_scheduler.clone(),
            operations: self.operations.clone(),
        }
    }
}
