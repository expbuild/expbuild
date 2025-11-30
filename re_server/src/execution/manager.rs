use crate::cache::ActionCacheManager;
use crate::cas::CasManager;
use anyhow::Result;
use re_grpc_proto::build::bazel::remote::execution::v2::{
    execution_stage, ActionResult, Digest, ExecuteOperationMetadata, ExecuteResponse,
};
use re_grpc_proto::google::longrunning::Operation;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;
use uuid::Uuid;

pub struct ExecutionManager {
    cas_manager: Arc<CasManager>,
    cache_manager: Arc<ActionCacheManager>,
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
    pub fn new(cas_manager: Arc<CasManager>, cache_manager: Arc<ActionCacheManager>) -> Self {
        Self {
            cas_manager,
            cache_manager,
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
}
