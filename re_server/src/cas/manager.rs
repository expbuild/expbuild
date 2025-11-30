use crate::storage::{BlobStore, DynBlobStore};
use crate::util::{compute_digest, verify_digest};
use anyhow::{Context, Result};
use re_grpc_proto::build::bazel::remote::execution::v2::{Digest, Directory};
use prost::Message;
use std::sync::Arc;

pub struct CasManager {
    blob_store: DynBlobStore,
}

impl CasManager {
    pub fn new(blob_store: DynBlobStore) -> Self {
        Self { blob_store }
    }
    
    pub async fn has_blob(&self, digest: &Digest) -> Result<bool> {
        self.blob_store.has_blob(digest).await
    }
    
    pub async fn get_blob(&self, digest: &Digest) -> Result<Vec<u8>> {
        let data = self.blob_store.get_blob(digest).await?;
        verify_digest(&data, digest)?;
        Ok(data)
    }
    
    pub async fn put_blob(&self, data: Vec<u8>) -> Result<Digest> {
        let digest = compute_digest(&data);
        self.blob_store.put_blob(&digest, data).await?;
        Ok(digest)
    }
    
    pub async fn put_blob_with_digest(&self, digest: &Digest, data: Vec<u8>) -> Result<()> {
        verify_digest(&data, digest)?;
        self.blob_store.put_blob(digest, data).await
    }
    
    pub async fn find_missing_blobs(&self, digests: &[Digest]) -> Result<Vec<Digest>> {
        self.blob_store.find_missing_blobs(digests).await
    }
    
    pub async fn get_directory(&self, digest: &Digest) -> Result<Directory> {
        let data = self.get_blob(digest).await?;
        let directory = Directory::decode(&data[..])
            .context("Failed to decode Directory proto")?;
        Ok(directory)
    }
    
    pub async fn put_directory(&self, directory: &Directory) -> Result<Digest> {
        let mut buf = Vec::new();
        directory.encode(&mut buf)?;
        self.put_blob(buf).await
    }
    
    pub async fn get_directory_tree(&self, root_digest: &Digest) -> Result<Vec<Directory>> {
        let mut directories = Vec::new();
        let mut to_fetch = vec![root_digest.clone()];
        let mut seen = std::collections::HashSet::new();
        
        while let Some(digest) = to_fetch.pop() {
            if !seen.insert(format_digest_key(&digest)) {
                continue;
            }
            
            let directory = self.get_directory(&digest).await?;
            
            for dir_node in &directory.directories {
                to_fetch.push(dir_node.digest.clone().unwrap_or_default());
            }
            
            directories.push(directory);
        }
        
        Ok(directories)
    }
    
    pub fn blob_store(&self) -> &DynBlobStore {
        &self.blob_store
    }
}

fn format_digest_key(digest: &Digest) -> String {
    format!("{}:{}", digest.hash, digest.size_bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::FileSystemBlobStore;
    use tempfile::TempDir;
    
    #[tokio::test]
    async fn test_put_and_get_blob() {
        let temp_dir = TempDir::new().unwrap();
        let store = Arc::new(FileSystemBlobStore::new(temp_dir.path().to_path_buf()));
        let manager = CasManager::new(store);
        
        let data = b"test data".to_vec();
        let digest = manager.put_blob(data.clone()).await.unwrap();
        
        let retrieved = manager.get_blob(&digest).await.unwrap();
        assert_eq!(retrieved, data);
    }
    
    #[tokio::test]
    async fn test_put_and_get_directory() {
        let temp_dir = TempDir::new().unwrap();
        let store = Arc::new(FileSystemBlobStore::new(temp_dir.path().to_path_buf()));
        let manager = CasManager::new(store);
        
        let directory = Directory {
            files: vec![],
            directories: vec![],
            symlinks: vec![],
            node_properties: None,
        };
        
        let digest = manager.put_directory(&directory).await.unwrap();
        let retrieved = manager.get_directory(&digest).await.unwrap();
        
        assert_eq!(retrieved.files.len(), 0);
        assert_eq!(retrieved.directories.len(), 0);
    }
}
