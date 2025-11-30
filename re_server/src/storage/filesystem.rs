use super::traits::{BlobStore, BoxedAsyncRead};
use anyhow::{Context, Result};
use async_trait::async_trait;
use re_grpc_proto::build::bazel::remote::execution::v2::Digest;
use std::path::{Path, PathBuf};
use tokio::fs;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

pub struct FileSystemBlobStore {
    root_dir: PathBuf,
}

impl FileSystemBlobStore {
    pub fn new(root_dir: PathBuf) -> Self {
        Self { root_dir }
    }
    
    pub async fn init(&self) -> Result<()> {
        fs::create_dir_all(&self.root_dir).await?;
        Ok(())
    }
    
    fn blob_path(&self, digest: &Digest) -> PathBuf {
        let hash = &digest.hash;
        if hash.len() < 4 {
            return self.root_dir.join(hash);
        }
        
        self.root_dir
            .join(&hash[0..2])
            .join(&hash[2..4])
            .join(hash)
    }
    
    async fn ensure_parent_dir(&self, path: &Path) -> Result<()> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).await?;
        }
        Ok(())
    }
}

#[async_trait]
impl BlobStore for FileSystemBlobStore {
    async fn has_blob(&self, digest: &Digest) -> Result<bool> {
        let path = self.blob_path(digest);
        Ok(path.exists())
    }
    
    async fn get_blob(&self, digest: &Digest) -> Result<Vec<u8>> {
        let path = self.blob_path(digest);
        let data = fs::read(&path)
            .await
            .with_context(|| format!("Failed to read blob {} from {:?}", digest.hash, path))?;
        
        if data.len() != digest.size_bytes as usize {
            anyhow::bail!(
                "Blob size mismatch: expected {}, got {}",
                digest.size_bytes,
                data.len()
            );
        }
        
        Ok(data)
    }
    
    async fn put_blob(&self, digest: &Digest, data: Vec<u8>) -> Result<()> {
        if data.len() != digest.size_bytes as usize {
            anyhow::bail!(
                "Data size mismatch: expected {}, got {}",
                digest.size_bytes,
                data.len()
            );
        }
        
        let path = self.blob_path(digest);
        
        if path.exists() {
            return Ok(());
        }
        
        self.ensure_parent_dir(&path).await?;
        
        let temp_path = path.with_extension("tmp");
        fs::write(&temp_path, &data).await?;
        fs::rename(&temp_path, &path).await?;
        
        Ok(())
    }
    
    async fn read_blob_stream(
        &self,
        digest: &Digest,
        offset: u64,
        limit: Option<u64>,
    ) -> Result<BoxedAsyncRead> {
        let path = self.blob_path(digest);
        let mut file = fs::File::open(&path).await?;
        
        if offset > 0 {
            use tokio::io::AsyncSeekExt;
            file.seek(std::io::SeekFrom::Start(offset)).await?;
        }
        
        let reader: BoxedAsyncRead = if let Some(limit) = limit {
            Box::pin(file.take(limit))
        } else {
            Box::pin(file)
        };
        
        Ok(reader)
    }
    
    async fn write_blob_stream(
        &self,
        digest: &Digest,
        size_bytes: i64,
        mut reader: BoxedAsyncRead,
    ) -> Result<()> {
        let path = self.blob_path(digest);
        
        if path.exists() {
            return Ok(());
        }
        
        self.ensure_parent_dir(&path).await?;
        
        let temp_path = path.with_extension("tmp");
        let mut file = fs::File::create(&temp_path).await?;
        
        let mut total_written = 0i64;
        let mut buffer = vec![0u8; 64 * 1024];
        
        loop {
            let n = reader.read(&mut buffer).await?;
            if n == 0 {
                break;
            }
            
            file.write_all(&buffer[..n]).await?;
            total_written += n as i64;
            
            if total_written > size_bytes {
                anyhow::bail!("Written data exceeds expected size");
            }
        }
        
        if total_written != size_bytes {
            anyhow::bail!(
                "Size mismatch: expected {}, got {}",
                size_bytes,
                total_written
            );
        }
        
        file.sync_all().await?;
        drop(file);
        
        fs::rename(&temp_path, &path).await?;
        
        Ok(())
    }
    
    async fn find_missing_blobs(&self, digests: &[Digest]) -> Result<Vec<Digest>> {
        let mut missing = Vec::new();
        
        for digest in digests {
            if !self.has_blob(digest).await? {
                missing.push(digest.clone());
            }
        }
        
        Ok(missing)
    }
    
    async fn delete_blob(&self, digest: &Digest) -> Result<()> {
        let path = self.blob_path(digest);
        
        if path.exists() {
            fs::remove_file(&path).await?;
        }
        
        Ok(())
    }
    
    async fn touch_blob(&self, digest: &Digest) -> Result<()> {
        let path = self.blob_path(digest);
        
        if path.exists() {
            let now = filetime::FileTime::now();
            filetime::set_file_times(&path, now, now)?;
        }
        
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;
    
    fn create_test_digest(data: &[u8]) -> Digest {
        use sha2::{Digest as _, Sha256};
        let mut hasher = Sha256::new();
        hasher.update(data);
        let hash = hex::encode(hasher.finalize());
        
        Digest {
            hash,
            size_bytes: data.len() as i64,
        }
    }
    
    #[tokio::test]
    async fn test_put_and_get_blob() {
        let temp_dir = TempDir::new().unwrap();
        let store = FileSystemBlobStore::new(temp_dir.path().to_path_buf());
        store.init().await.unwrap();
        
        let data = b"hello world";
        let digest = create_test_digest(data);
        
        store.put_blob(&digest, data.to_vec()).await.unwrap();
        
        assert!(store.has_blob(&digest).await.unwrap());
        
        let retrieved = store.get_blob(&digest).await.unwrap();
        assert_eq!(retrieved, data);
    }
    
    #[tokio::test]
    async fn test_find_missing_blobs() {
        let temp_dir = TempDir::new().unwrap();
        let store = FileSystemBlobStore::new(temp_dir.path().to_path_buf());
        store.init().await.unwrap();
        
        let data1 = b"data1";
        let digest1 = create_test_digest(data1);
        
        let data2 = b"data2";
        let digest2 = create_test_digest(data2);
        
        store.put_blob(&digest1, data1.to_vec()).await.unwrap();
        
        let missing = store.find_missing_blobs(&[digest1.clone(), digest2.clone()])
            .await
            .unwrap();
        
        assert_eq!(missing.len(), 1);
        assert_eq!(missing[0].hash, digest2.hash);
    }
}
