use crate::cas::CasManager;
use crate::util::verify_digest;
use anyhow::Result;
use re_grpc_proto::build::bazel::remote::execution::v2::{
    content_addressable_storage_server::ContentAddressableStorage, BatchReadBlobsRequest,
    BatchReadBlobsResponse, BatchUpdateBlobsRequest, BatchUpdateBlobsResponse,
    FindMissingBlobsRequest, FindMissingBlobsResponse, GetTreeRequest, GetTreeResponse,
    SplitBlobRequest, SplitBlobResponse, SpliceBlobRequest, SpliceBlobResponse,
};
use std::sync::Arc;
use tonic::{Request, Response, Status};

pub struct CasService {
    cas_manager: Arc<CasManager>,
}

impl CasService {
    pub fn new(cas_manager: Arc<CasManager>) -> Self {
        Self { cas_manager }
    }
}

#[tonic::async_trait]
impl ContentAddressableStorage for CasService {
    async fn find_missing_blobs(
        &self,
        request: Request<FindMissingBlobsRequest>,
    ) -> Result<Response<FindMissingBlobsResponse>, Status> {
        let req = request.into_inner();
        
        tracing::debug!(
            "FindMissingBlobs request: {} blobs",
            req.blob_digests.len()
        );
        
        let missing = self
            .cas_manager
            .find_missing_blobs(&req.blob_digests)
            .await
            .map_err(|e| Status::internal(format!("Failed to find missing blobs: {}", e)))?;
        
        tracing::debug!("Found {} missing blobs", missing.len());
        
        Ok(Response::new(FindMissingBlobsResponse {
            missing_blob_digests: missing,
        }))
    }
    
    async fn batch_update_blobs(
        &self,
        request: Request<BatchUpdateBlobsRequest>,
    ) -> Result<Response<BatchUpdateBlobsResponse>, Status> {
        let req = request.into_inner();
        
        tracing::debug!("BatchUpdateBlobs request: {} blobs", req.requests.len());
        
        let mut responses = Vec::new();
        
        for blob_request in req.requests {
            let digest = blob_request.digest.ok_or_else(|| {
                Status::invalid_argument("Digest is required")
            })?;
            
            let result = match verify_digest(&blob_request.data, &digest) {
                Ok(_) => {
                    self.cas_manager
                        .put_blob_with_digest(&digest, blob_request.data)
                        .await
                }
                Err(e) => Err(e),
            };
            
            let status = match result {
                Ok(_) => Some(re_grpc_proto::google::rpc::Status {
                    code: 0,
                    message: String::new(),
                    details: vec![],
                }),
                Err(e) => Some(re_grpc_proto::google::rpc::Status {
                    code: 3,
                    message: e.to_string(),
                    details: vec![],
                }),
            };
            
            responses.push(re_grpc_proto::build::bazel::remote::execution::v2::batch_update_blobs_response::Response {
                digest: Some(digest),
                status,
            });
        }
        
        Ok(Response::new(BatchUpdateBlobsResponse { responses }))
    }
    
    async fn batch_read_blobs(
        &self,
        request: Request<BatchReadBlobsRequest>,
    ) -> Result<Response<BatchReadBlobsResponse>, Status> {
        let req = request.into_inner();
        
        tracing::debug!("BatchReadBlobs request: {} blobs", req.digests.len());
        
        let mut responses = Vec::new();
        
        for digest in req.digests {
            let result = self.cas_manager.get_blob(&digest).await;
            
            let (data, status) = match result {
                Ok(data) => (
                    data,
                    Some(re_grpc_proto::google::rpc::Status {
                        code: 0,
                        message: String::new(),
                        details: vec![],
                    }),
                ),
                Err(e) => (
                    vec![],
                    Some(re_grpc_proto::google::rpc::Status {
                        code: if e.to_string().contains("not found") { 5 } else { 13 },
                        message: e.to_string(),
                        details: vec![],
                    }),
                ),
            };
            
            responses.push(re_grpc_proto::build::bazel::remote::execution::v2::batch_read_blobs_response::Response {
                digest: Some(digest),
                data,
                compressor: 0,
                status,
            });
        }
        
        Ok(Response::new(BatchReadBlobsResponse { responses }))
    }
    
    type GetTreeStream = tokio_stream::wrappers::ReceiverStream<Result<GetTreeResponse, Status>>;
    
    async fn get_tree(
        &self,
        request: Request<GetTreeRequest>,
    ) -> Result<Response<Self::GetTreeStream>, Status> {
        let req = request.into_inner();
        
        let root_digest = req.root_digest.ok_or_else(|| {
            Status::invalid_argument("Root digest is required")
        })?;
        
        tracing::debug!("GetTree request: {}", root_digest.hash);
        
        let cas_manager = self.cas_manager.clone();
        
        let (tx, rx) = tokio::sync::mpsc::channel(100);
        
        tokio::spawn(async move {
            match cas_manager.get_directory_tree(&root_digest).await {
                Ok(directories) => {
                    if let Err(e) = tx.send(Ok(GetTreeResponse {
                        directories,
                        next_page_token: String::new(),
                    })).await {
                        tracing::error!("Failed to send GetTree response: {}", e);
                    }
                }
                Err(e) => {
                    let _ = tx.send(Err(Status::internal(format!("Failed to get tree: {}", e)))).await;
                }
            }
        });
        
        Ok(Response::new(tokio_stream::wrappers::ReceiverStream::new(rx)))
    }
    
    async fn split_blob(
        &self,
        _request: Request<SplitBlobRequest>,
    ) -> Result<Response<SplitBlobResponse>, Status> {
        Err(Status::unimplemented("SplitBlob is not yet implemented"))
    }
    
    async fn splice_blob(
        &self,
        _request: Request<SpliceBlobRequest>,
    ) -> Result<Response<SpliceBlobResponse>, Status> {
        Err(Status::unimplemented("SpliceBlob is not yet implemented"))
    }
}
