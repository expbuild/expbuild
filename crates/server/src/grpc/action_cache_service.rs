use crate::cache::ActionCacheManager;
use anyhow::Result;
use re_grpc_proto::build::bazel::remote::execution::v2::{
    action_cache_server::ActionCache, ActionResult, GetActionResultRequest,
    UpdateActionResultRequest,
};
use std::sync::Arc;
use tonic::{Request, Response, Status};

pub struct ActionCacheService {
    cache_manager: Arc<ActionCacheManager>,
}

impl ActionCacheService {
    pub fn new(cache_manager: Arc<ActionCacheManager>) -> Self {
        Self { cache_manager }
    }
}

#[tonic::async_trait]
impl ActionCache for ActionCacheService {
    async fn get_action_result(
        &self,
        request: Request<GetActionResultRequest>,
    ) -> Result<Response<ActionResult>, Status> {
        let req = request.into_inner();
        
        let action_digest = req.action_digest.ok_or_else(|| {
            Status::invalid_argument("Action digest is required")
        })?;
        
        tracing::debug!("GetActionResult request: {}", action_digest.hash);
        
        match self.cache_manager.get_action_result(&action_digest).await {
            Ok(Some(result)) => {
                tracing::debug!("Action result found in cache");
                self.cache_manager.touch_action_result(&action_digest).await.ok();
                Ok(Response::new(result))
            }
            Ok(None) => {
                tracing::debug!("Action result not found in cache");
                Err(Status::not_found("Action result not found"))
            }
            Err(e) => {
                tracing::error!("Failed to get action result: {}", e);
                Err(Status::internal(format!("Failed to get action result: {}", e)))
            }
        }
    }
    
    async fn update_action_result(
        &self,
        request: Request<UpdateActionResultRequest>,
    ) -> Result<Response<ActionResult>, Status> {
        let req = request.into_inner();
        
        let action_digest = req.action_digest.ok_or_else(|| {
            Status::invalid_argument("Action digest is required")
        })?;
        
        let action_result = req.action_result.ok_or_else(|| {
            Status::invalid_argument("Action result is required")
        })?;
        
        tracing::debug!("UpdateActionResult request: {}", action_digest.hash);
        
        self.cache_manager
            .put_action_result(&action_digest, &action_result)
            .await
            .map_err(|e| Status::internal(format!("Failed to update action result: {}", e)))?;
        
        Ok(Response::new(action_result))
    }
}
