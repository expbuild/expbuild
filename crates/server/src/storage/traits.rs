use async_trait::async_trait;
use re_grpc_proto::build::bazel::remote::execution::v2::{ActionResult, Digest};
use std::pin::Pin;
use std::sync::Arc;
use tokio::io::AsyncRead;
use anyhow::Result;

pub type BoxedAsyncRead = Pin<Box<dyn AsyncRead + Send + Sync>>;

#[async_trait]
pub trait BlobStore: Send + Sync {
    async fn has_blob(&self, digest: &Digest) -> Result<bool>;
    
    async fn get_blob(&self, digest: &Digest) -> Result<Vec<u8>>;
    
    async fn put_blob(&self, digest: &Digest, data: Vec<u8>) -> Result<()>;
    
    async fn read_blob_stream(
        &self,
        digest: &Digest,
        offset: u64,
        limit: Option<u64>,
    ) -> Result<BoxedAsyncRead>;
    
    async fn write_blob_stream(
        &self,
        digest: &Digest,
        size_bytes: i64,
        reader: BoxedAsyncRead,
    ) -> Result<()>;
    
    async fn find_missing_blobs(&self, digests: &[Digest]) -> Result<Vec<Digest>>;
    
    async fn delete_blob(&self, digest: &Digest) -> Result<()>;
    
    async fn touch_blob(&self, digest: &Digest) -> Result<()>;
}

pub type DynBlobStore = Arc<dyn BlobStore>;

#[async_trait]
pub trait ActionCacheStore: Send + Sync {
    async fn get_action_result(&self, action_digest: &Digest) -> Result<Option<ActionResult>>;
    
    async fn put_action_result(
        &self,
        action_digest: &Digest,
        result: &ActionResult,
    ) -> Result<()>;
    
    async fn delete_action_result(&self, action_digest: &Digest) -> Result<()>;
    
    async fn touch_action_result(&self, action_digest: &Digest) -> Result<()>;
}

pub type DynActionCacheStore = Arc<dyn ActionCacheStore>;
