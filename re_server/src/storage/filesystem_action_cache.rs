use super::traits::ActionCacheStore;
use anyhow::{Context, Result};
use async_trait::async_trait;
use re_grpc_proto::build::bazel::remote::execution::v2::{ActionResult, Digest};
use std::path::{Path, PathBuf};
use tokio::fs;
use prost::Message;

pub struct FileSystemActionCacheStore {
    root_dir: PathBuf,
}

impl FileSystemActionCacheStore {
    pub fn new(root_dir: PathBuf) -> Self {
        Self { root_dir }
    }
    
    pub async fn init(&self) -> Result<()> {
        fs::create_dir_all(&self.root_dir).await?;
        Ok(())
    }
    
    fn cache_path(&self, action_digest: &Digest) -> PathBuf {
        let hash = &action_digest.hash;
        if hash.len() < 4 {
            return self.root_dir.join(hash);
        }
        
        self.root_dir
            .join(&hash[0..2])
            .join(&hash[2..4])
            .join(format!("{}.actionresult", hash))
    }
    
    async fn ensure_parent_dir(&self, path: &Path) -> Result<()> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).await?;
        }
        Ok(())
    }
}

#[async_trait]
impl ActionCacheStore for FileSystemActionCacheStore {
    async fn get_action_result(&self, action_digest: &Digest) -> Result<Option<ActionResult>> {
        let path = self.cache_path(action_digest);
        
        if !path.exists() {
            return Ok(None);
        }
        
        let data = fs::read(&path).await?;
        let result = ActionResult::decode(&data[..])?;
        
        Ok(Some(result))
    }
    
    async fn put_action_result(
        &self,
        action_digest: &Digest,
        result: &ActionResult,
    ) -> Result<()> {
        let path = self.cache_path(action_digest);
        self.ensure_parent_dir(&path).await?;
        
        let mut buf = Vec::new();
        result.encode(&mut buf)?;
        
        let temp_path = path.with_extension("tmp");
        fs::write(&temp_path, &buf).await?;
        fs::rename(&temp_path, &path).await?;
        
        Ok(())
    }
    
    async fn delete_action_result(&self, action_digest: &Digest) -> Result<()> {
        let path = self.cache_path(action_digest);
        
        if path.exists() {
            fs::remove_file(&path).await?;
        }
        
        Ok(())
    }
    
    async fn touch_action_result(&self, action_digest: &Digest) -> Result<()> {
        let path = self.cache_path(action_digest);
        
        if path.exists() {
            let now = filetime::FileTime::now();
            filetime::set_file_times(&path, now, now)?;
        }
        
        Ok(())
    }
}
