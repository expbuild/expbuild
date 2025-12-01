use crate::cache::ActionCacheManager;
use crate::cas::CasManager;
use super::worker::{DynWorkerPool, ExecutionTask, OutputContent};
use anyhow::Result;
use re_grpc_proto::build::bazel::remote::execution::v2::{
    execution_stage, Action, ActionResult, Command, Digest, ExecuteOperationMetadata,
    ExecuteResponse, ExecutedActionMetadata,
};
use re_grpc_proto::google::longrunning::Operation;
use prost::Message;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::RwLock;
use uuid::Uuid;

pub struct ExecutionManager {
    cas_manager: Arc<CasManager>,
    cache_manager: Arc<ActionCacheManager>,
    worker_pool: Option<DynWorkerPool>,
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
            worker_pool: None,
            operations: Arc::new(RwLock::new(HashMap::new())),
        }
    }
    
    pub fn with_worker_pool(
        cas_manager: Arc<CasManager>,
        cache_manager: Arc<ActionCacheManager>,
        worker_pool: DynWorkerPool,
    ) -> Self {
        Self {
            cas_manager,
            cache_manager,
            worker_pool: Some(worker_pool),
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
        
        let Some(ref worker_pool) = self.worker_pool else {
            tracing::warn!("No worker pool configured, execution will not proceed");
            return Ok(operation_name);
        };
        
        let action = self.get_action(&action_digest).await?;
        let command = self.get_command(&action).await?;
        
        tracing::info!(
            "[ExecutionManager] Action digest: {}/{}",
            action_digest.hash,
            action_digest.size_bytes
        );
        tracing::info!(
            "[ExecutionManager] Command arguments: {:?}",
            command.arguments
        );
        tracing::info!(
            "[ExecutionManager] Output paths from client: {:?}",
            command.output_paths
        );
        tracing::info!(
            "[ExecutionManager] Output files: {:?}",
            command.output_files
        );
        tracing::info!(
            "[ExecutionManager] Output directories: {:?}",
            command.output_directories
        );
        tracing::info!(
            "[ExecutionManager] Working directory: {:?}",
            command.working_directory
        );
        
        let task = ExecutionTask {
            task_id: Uuid::new_v4().to_string(),
            operation_name: operation_name.clone(),
            action: action.clone(),
            command,
            input_root_digest: action.input_root_digest.clone().unwrap_or_default(),
            platform: action.platform.clone(),
            timeout: action
                .timeout
                .as_ref()
                .map(|t| Duration::from_secs(t.seconds as u64))
                .unwrap_or(Duration::from_secs(3600)),
        };
        
        self.update_operation_stage(&operation_name, execution_stage::Value::Queued as i32).await;
        
        let handle = worker_pool.submit_task(task).await?;
        
        let exec_manager = Arc::new(self.clone());
        let worker_pool_clone = worker_pool.clone();
        let op_name_clone = operation_name.clone();
        
        tokio::spawn(async move {
            exec_manager
                .update_operation_stage(&op_name_clone, execution_stage::Value::Executing as i32)
                .await;
            
            match worker_pool_clone.wait_for_task(handle).await {
                Ok(worker_result) => {
                    match exec_manager.build_action_result(worker_result).await {
                        Ok(action_result) => {
                            if let Err(e) = exec_manager
                                .complete_operation(&op_name_clone, action_result)
                                .await
                            {
                                tracing::error!("Failed to complete operation: {}", e);
                            }
                        }
                        Err(e) => {
                            tracing::error!("Failed to build action result: {}", e);
                        }
                    }
                }
                Err(e) => {
                    tracing::error!("Task execution failed: {}", e);
                }
            }
        });
        
        Ok(operation_name)
    }
    
    async fn get_action(&self, digest: &Digest) -> Result<Action> {
        let data = self.cas_manager.get_blob(digest).await?;
        let action = Action::decode(&data[..])?;
        Ok(action)
    }
    
    async fn get_command(&self, action: &Action) -> Result<Command> {
        let command_digest = action
            .command_digest
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("Action missing command digest"))?;
        let data = self.cas_manager.get_blob(command_digest).await?;
        let command = Command::decode(&data[..])?;
        Ok(command)
    }
    
    async fn build_action_result(
        &self,
        worker_result: super::worker::WorkerExecutionResult,
    ) -> Result<ActionResult> {
        let stdout_digest = match worker_result.stdout {
            OutputContent::Digest(d) => Some(d),
            OutputContent::Inline(data) => {
                if data.is_empty() {
                    None
                } else {
                    Some(self.cas_manager.put_blob(data).await?)
                }
            }
        };
        
        let stderr_digest = match worker_result.stderr {
            OutputContent::Digest(d) => Some(d),
            OutputContent::Inline(data) => {
                if data.is_empty() {
                    None
                } else {
                    Some(self.cas_manager.put_blob(data).await?)
                }
            }
        };
        
        Ok(ActionResult {
            output_files: worker_result.output_files,
            output_file_symlinks: vec![],
            output_symlinks: vec![],
            output_directories: worker_result.output_directories,
            output_directory_symlinks: vec![],
            exit_code: worker_result.exit_code,
            stdout_raw: vec![],
            stdout_digest,
            stderr_raw: vec![],
            stderr_digest,
            execution_metadata: Some(ExecutedActionMetadata {
                worker: worker_result.execution_metadata.worker_id,
                queued_timestamp: None,
                worker_start_timestamp: None,
                worker_completed_timestamp: None,
                input_fetch_start_timestamp: None,
                input_fetch_completed_timestamp: None,
                execution_start_timestamp: None,
                execution_completed_timestamp: None,
                output_upload_start_timestamp: None,
                output_upload_completed_timestamp: None,
                virtual_execution_duration: None,
                auxiliary_metadata: vec![],
            }),
        })
    }
}

impl Clone for ExecutionManager {
    fn clone(&self) -> Self {
        Self {
            cas_manager: self.cas_manager.clone(),
            cache_manager: self.cache_manager.clone(),
            worker_pool: self.worker_pool.clone(),
            operations: self.operations.clone(),
        }
    }
}
