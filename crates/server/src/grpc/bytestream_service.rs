use crate::cas::CasManager;
use crate::util::verify_digest;
use anyhow::Result;
use re_grpc_proto::google::bytestream::{
    byte_stream_server::ByteStream, QueryWriteStatusRequest, QueryWriteStatusResponse,
    ReadRequest, ReadResponse, WriteRequest, WriteResponse,
};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::io::AsyncReadExt;
use tokio::sync::Mutex;
use tonic::{Request, Response, Status, Streaming};

const MAX_CHUNK_SIZE: usize = 1024 * 1024;

struct WriteState {
    committed_size: i64,
    complete: bool,
}

pub struct ByteStreamService {
    cas_manager: Arc<CasManager>,
    write_states: Arc<Mutex<HashMap<String, WriteState>>>,
}

impl ByteStreamService {
    pub fn new(cas_manager: Arc<CasManager>) -> Self {
        Self {
            cas_manager,
            write_states: Arc::new(Mutex::new(HashMap::new())),
        }
    }
    
    fn parse_resource_name(&self, resource_name: &str) -> Result<ParsedResourceName> {
        let parts: Vec<&str> = resource_name.split('/').collect();
        
        let blobs_idx = parts.iter().position(|&p| p == "blobs")
            .ok_or_else(|| anyhow::anyhow!("Invalid resource name: missing 'blobs'"))?;
        
        if blobs_idx + 2 >= parts.len() {
            anyhow::bail!("Invalid resource name: not enough parts after 'blobs'");
        }
        
        let hash = parts[blobs_idx + 1].to_string();
        let size = parts[blobs_idx + 2].parse::<i64>()?;
        
        let digest = re_grpc_proto::build::bazel::remote::execution::v2::Digest {
            hash: hash.clone(),
            size_bytes: size,
        };
        
        Ok(ParsedResourceName {
            digest,
        })
    }
}

struct ParsedResourceName {
    digest: re_grpc_proto::build::bazel::remote::execution::v2::Digest,
}

#[tonic::async_trait]
impl ByteStream for ByteStreamService {
    type ReadStream = tokio_stream::wrappers::ReceiverStream<Result<ReadResponse, Status>>;
    
    async fn read(
        &self,
        request: Request<ReadRequest>,
    ) -> Result<Response<Self::ReadStream>, Status> {
        let req = request.into_inner();
        
        tracing::debug!("ByteStream Read request: {}", req.resource_name);
        
        let parsed = self.parse_resource_name(&req.resource_name)
            .map_err(|e| Status::invalid_argument(format!("Invalid resource name: {}", e)))?;
        
        let digest = parsed.digest;
        let offset = req.read_offset as u64;
        let limit = if req.read_limit > 0 {
            Some(req.read_limit as u64)
        } else {
            None
        };
        
        let cas_manager = self.cas_manager.clone();
        
        let (tx, rx) = tokio::sync::mpsc::channel(100);
        
        tokio::spawn(async move {
            let mut reader = match cas_manager.blob_store().read_blob_stream(&digest, offset, limit).await {
                Ok(r) => r,
                Err(e) => {
                    let _ = tx.send(Err(Status::not_found(format!("Blob not found: {}", e)))).await;
                    return;
                }
            };
            
            let mut buffer = vec![0u8; MAX_CHUNK_SIZE];
            
            loop {
                match reader.read(&mut buffer).await {
                    Ok(0) => break,
                    Ok(n) => {
                        let response = ReadResponse {
                            data: buffer[..n].to_vec(),
                        };
                        if tx.send(Ok(response)).await.is_err() {
                            break;
                        }
                    }
                    Err(e) => {
                        let _ = tx.send(Err(Status::internal(format!("Read error: {}", e)))).await;
                        break;
                    }
                }
            }
        });
        
        Ok(Response::new(tokio_stream::wrappers::ReceiverStream::new(rx)))
    }
    
    async fn write(
        &self,
        request: Request<Streaming<WriteRequest>>,
    ) -> Result<Response<WriteResponse>, Status> {
        let mut stream = request.into_inner();
        
        let mut resource_name: Option<String> = None;
        let mut buffer = Vec::new();
        let mut total_received = 0i64;
        let mut expected_digest: Option<re_grpc_proto::build::bazel::remote::execution::v2::Digest> = None;
        
        while let Some(req) = stream.message().await? {
            if resource_name.is_none() {
                resource_name = Some(req.resource_name.clone());
                
                let parsed = self.parse_resource_name(&req.resource_name)
                    .map_err(|e| Status::invalid_argument(format!("Invalid resource name: {}", e)))?;
                
                expected_digest = Some(parsed.digest);
            }
            
            buffer.extend_from_slice(&req.data);
            total_received += req.data.len() as i64;
            
            if req.finish_write {
                let digest = expected_digest.ok_or_else(|| {
                    Status::internal("Missing digest")
                })?;
                
                if buffer.len() != digest.size_bytes as usize {
                    return Err(Status::invalid_argument(format!(
                        "Size mismatch: expected {}, got {}",
                        digest.size_bytes,
                        buffer.len()
                    )));
                }
                
                if let Err(e) = verify_digest(&buffer, &digest) {
                    return Err(Status::invalid_argument(format!("Digest verification failed: {}", e)));
                }
                
                self.cas_manager
                    .put_blob_with_digest(&digest, buffer)
                    .await
                    .map_err(|e| Status::internal(format!("Failed to store blob: {}", e)))?;
                
                return Ok(Response::new(WriteResponse {
                    committed_size: total_received,
                }));
            }
        }
        
        Err(Status::invalid_argument("Write not finished"))
    }
    
    async fn query_write_status(
        &self,
        request: Request<QueryWriteStatusRequest>,
    ) -> Result<Response<QueryWriteStatusResponse>, Status> {
        let req = request.into_inner();
        
        tracing::debug!("QueryWriteStatus request: {}", req.resource_name);
        
        let states = self.write_states.lock().await;
        
        if let Some(state) = states.get(&req.resource_name) {
            Ok(Response::new(QueryWriteStatusResponse {
                committed_size: state.committed_size,
                complete: state.complete,
            }))
        } else {
            Err(Status::not_found("Write not found"))
        }
    }
}
