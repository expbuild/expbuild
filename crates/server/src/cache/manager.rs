use crate::storage::DynActionCacheStore;
use anyhow::Result;
use re_grpc_proto::build::bazel::remote::execution::v2::{ActionResult, Digest};

pub struct ActionCacheManager {
    cache_store: DynActionCacheStore,
}

impl ActionCacheManager {
    pub fn new(cache_store: DynActionCacheStore) -> Self {
        Self { cache_store }
    }
    
    pub async fn get_action_result(&self, action_digest: &Digest) -> Result<Option<ActionResult>> {
        self.cache_store.get_action_result(action_digest).await
    }
    
    pub async fn put_action_result(
        &self,
        action_digest: &Digest,
        result: &ActionResult,
    ) -> Result<()> {
        self.cache_store.put_action_result(action_digest, result).await
    }
    
    pub async fn touch_action_result(&self, action_digest: &Digest) -> Result<()> {
        self.cache_store.touch_action_result(action_digest).await
    }
}
