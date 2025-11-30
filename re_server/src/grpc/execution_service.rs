use crate::execution::ExecutionManager;
use anyhow::Result;
use re_grpc_proto::build::bazel::remote::execution::v2::{
    execution_server::Execution, ExecuteRequest, WaitExecutionRequest,
};
use re_grpc_proto::google::longrunning::Operation;
use std::sync::Arc;
use std::time::Duration;
use tonic::{Request, Response, Status};

pub struct ExecutionService {
    execution_manager: Arc<ExecutionManager>,
}

impl ExecutionService {
    pub fn new(execution_manager: Arc<ExecutionManager>) -> Self {
        Self { execution_manager }
    }
}

#[tonic::async_trait]
impl Execution for ExecutionService {
    type ExecuteStream = tokio_stream::wrappers::ReceiverStream<Result<Operation, Status>>;
    
    async fn execute(
        &self,
        request: Request<ExecuteRequest>,
    ) -> Result<Response<Self::ExecuteStream>, Status> {
        let req = request.into_inner();
        
        let action_digest = req.action_digest.ok_or_else(|| {
            Status::invalid_argument("Action digest is required")
        })?;
        
        tracing::info!("Execute request: {}", action_digest.hash);
        
        let operation_name = self
            .execution_manager
            .create_operation(action_digest.clone(), req.skip_cache_lookup)
            .await
            .map_err(|e| Status::internal(format!("Failed to create operation: {}", e)))?;
        
        let (tx, rx) = tokio::sync::mpsc::channel(100);
        
        let execution_manager = self.execution_manager.clone();
        let op_name = operation_name.clone();
        
        tokio::spawn(async move {
            if let Some(operation) = execution_manager.get_operation(&op_name).await {
                let _ = tx.send(Ok(operation.clone())).await;
                
                if !operation.done {
                    loop {
                        tokio::time::sleep(Duration::from_secs(1)).await;
                        
                        if let Some(updated_op) = execution_manager.get_operation(&op_name).await {
                            let _ = tx.send(Ok(updated_op.clone())).await;
                            
                            if updated_op.done {
                                break;
                            }
                        } else {
                            break;
                        }
                    }
                }
            } else {
                let _ = tx.send(Err(Status::not_found("Operation not found"))).await;
            }
        });
        
        Ok(Response::new(tokio_stream::wrappers::ReceiverStream::new(rx)))
    }
    
    type WaitExecutionStream = tokio_stream::wrappers::ReceiverStream<Result<Operation, Status>>;
    
    async fn wait_execution(
        &self,
        request: Request<WaitExecutionRequest>,
    ) -> Result<Response<Self::WaitExecutionStream>, Status> {
        let req = request.into_inner();
        
        tracing::debug!("WaitExecution request: {}", req.name);
        
        let (tx, rx) = tokio::sync::mpsc::channel(100);
        
        let execution_manager = self.execution_manager.clone();
        let operation_name = req.name;
        
        tokio::spawn(async move {
            if let Some(operation) = execution_manager.get_operation(&operation_name).await {
                let _ = tx.send(Ok(operation.clone())).await;
                
                if !operation.done {
                    loop {
                        tokio::time::sleep(Duration::from_secs(1)).await;
                        
                        if let Some(updated_op) = execution_manager.get_operation(&operation_name).await {
                            let _ = tx.send(Ok(updated_op.clone())).await;
                            
                            if updated_op.done {
                                break;
                            }
                        } else {
                            break;
                        }
                    }
                }
            } else {
                let _ = tx.send(Err(Status::not_found("Operation not found"))).await;
            }
        });
        
        Ok(Response::new(tokio_stream::wrappers::ReceiverStream::new(rx)))
    }
}
