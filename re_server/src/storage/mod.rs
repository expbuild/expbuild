pub mod traits;
pub mod filesystem;
pub mod filesystem_action_cache;

pub use traits::{BlobStore, ActionCacheStore, DynBlobStore, DynActionCacheStore, BoxedAsyncRead};
pub use filesystem::FileSystemBlobStore;
pub use filesystem_action_cache::FileSystemActionCacheStore;

use crate::config::{CasStorageConfig, ActionCacheConfig};
use anyhow::Result;
use std::sync::Arc;

pub async fn create_blob_store(config: &CasStorageConfig) -> Result<DynBlobStore> {
    match config {
        CasStorageConfig::FileSystem { root_dir } => {
            let store = FileSystemBlobStore::new(root_dir.clone());
            store.init().await?;
            Ok(Arc::new(store))
        }
        CasStorageConfig::Redis { .. } => {
            anyhow::bail!("Redis blob store not yet implemented")
        }
        CasStorageConfig::Tiered { .. } => {
            anyhow::bail!("Tiered blob store not yet implemented")
        }
    }
}

pub async fn create_action_cache_store(config: &ActionCacheConfig) -> Result<DynActionCacheStore> {
    match config {
        ActionCacheConfig::FileSystem { root_dir } => {
            let store = FileSystemActionCacheStore::new(root_dir.clone());
            store.init().await?;
            Ok(Arc::new(store))
        }
        ActionCacheConfig::Redis { .. } => {
            anyhow::bail!("Redis action cache store not yet implemented")
        }
        ActionCacheConfig::Memory { .. } => {
            anyhow::bail!("Memory action cache store not yet implemented")
        }
    }
}
