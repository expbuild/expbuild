use std::collections::HashMap;
use std::path::{Path, PathBuf};

use prost::Message;
use re_grpc_proto::build::bazel::remote::execution::v2::{Directory, DirectoryNode, FileNode};
use tokio::fs;

use crate::action::error::ActionError;
use crate::digest::TDigest;

#[derive(Debug, Clone)]
pub struct FileToUpload {
    pub path: String,
    pub digest: TDigest,
    pub is_executable: bool,
    pub content: Vec<u8>,
}

pub struct DirectoryBuilder {
    files_to_upload: Vec<FileToUpload>,
    directories: HashMap<String, Directory>,
    root_digest: Option<TDigest>,
}

impl DirectoryBuilder {
    pub fn new() -> Self {
        Self {
            files_to_upload: Vec::new(),
            directories: HashMap::new(),
            root_digest: None,
        }
    }

    pub async fn from_directory(path: &Path) -> Result<Self, ActionError> {
        let mut builder = Self::new();
        builder.scan_directory(path, "").await?;
        builder.build()?;
        Ok(builder)
    }

    async fn scan_directory(&mut self, base_path: &Path, relative_path: &str) -> Result<(), ActionError> {
        let current_path = if relative_path.is_empty() {
            base_path.to_path_buf()
        } else {
            base_path.join(relative_path)
        };

        let mut entries = fs::read_dir(&current_path).await?;
        let mut files = Vec::new();
        let mut dirs = Vec::new();

        while let Some(entry) = entries.next_entry().await? {
            let file_type = entry.file_type().await?;
            let file_name = entry.file_name().to_string_lossy().to_string();
            
            let child_relative_path = if relative_path.is_empty() {
                file_name.clone()
            } else {
                format!("{}/{}", relative_path, file_name)
            };

            if file_type.is_file() {
                let content = fs::read(entry.path()).await?;
                let digest = crate::digest::compute_digest(&content);
                
                #[cfg(unix)]
                let is_executable = {
                    use std::os::unix::fs::PermissionsExt;
                    let metadata = fs::metadata(entry.path()).await?;
                    metadata.permissions().mode() & 0o111 != 0
                };
                
                #[cfg(not(unix))]
                let is_executable = false;

                self.files_to_upload.push(FileToUpload {
                    path: child_relative_path.clone(),
                    digest: digest.clone(),
                    is_executable,
                    content,
                });

                files.push((file_name, digest, is_executable));
            } else if file_type.is_dir() {
                Box::pin(self.scan_directory(base_path, &child_relative_path)).await?;
                dirs.push(file_name);
            }
        }

        files.sort_by(|a, b| a.0.cmp(&b.0));
        dirs.sort();

        let mut directory = Directory {
            files: files
                .into_iter()
                .map(|(name, digest, is_executable)| FileNode {
                    name,
                    digest: Some(re_grpc_proto::build::bazel::remote::execution::v2::Digest {
                        hash: digest.hash,
                        size_bytes: digest.size_in_bytes,
                    }),
                    is_executable,
                    node_properties: None,
                })
                .collect(),
            directories: Vec::new(),
            symlinks: Vec::new(),
            node_properties: None,
        };

        self.directories.insert(relative_path.to_string(), directory);

        Ok(())
    }

    pub fn add_file(
        &mut self,
        path: &str,
        content: Vec<u8>,
        is_executable: bool,
    ) -> Result<TDigest, ActionError> {
        let digest = crate::digest::compute_digest(&content);
        
        self.files_to_upload.push(FileToUpload {
            path: path.to_string(),
            digest: digest.clone(),
            is_executable,
            content,
        });

        Ok(digest)
    }

    pub fn build(&mut self) -> Result<TDigest, ActionError> {
        let mut dir_digests: HashMap<String, TDigest> = HashMap::new();

        let mut paths: Vec<String> = self.directories.keys().cloned().collect();
        paths.sort_by(|a, b| {
            let depth_a = a.matches('/').count();
            let depth_b = b.matches('/').count();
            depth_b.cmp(&depth_a).then_with(|| a.cmp(b))
        });

        for path in paths {
            let mut directory = self.directories.get(&path).unwrap().clone();

            let path_prefix = if path.is_empty() {
                String::new()
            } else {
                format!("{}/", path)
            };

            let mut dir_nodes = Vec::new();
            for (child_path, child_digest) in &dir_digests {
                if let Some(name) = child_path.strip_prefix(&path_prefix) {
                    if !name.contains('/') {
                        dir_nodes.push((name.to_string(), child_digest.clone()));
                    }
                }
            }

            dir_nodes.sort_by(|a, b| a.0.cmp(&b.0));
            directory.directories = dir_nodes
                .into_iter()
                .map(|(name, digest)| DirectoryNode {
                    name,
                    digest: Some(re_grpc_proto::build::bazel::remote::execution::v2::Digest {
                        hash: digest.hash,
                        size_bytes: digest.size_in_bytes,
                    }),
                })
                .collect();

            let mut buf = Vec::new();
            directory.encode(&mut buf).map_err(|e| {
                ActionError::PreparationFailed(format!("Failed to encode Directory: {}", e))
            })?;
            let digest = crate::digest::compute_digest(&buf);

            dir_digests.insert(path.clone(), digest.clone());
            self.directories.insert(path, directory);
        }

        let root_digest = dir_digests
            .get("")
            .cloned()
            .unwrap_or_else(|| {
                let empty_dir = Directory {
                    files: Vec::new(),
                    directories: Vec::new(),
                    symlinks: Vec::new(),
                    node_properties: None,
                };
                let mut buf = Vec::new();
                empty_dir.encode(&mut buf).unwrap();
                crate::digest::compute_digest(&buf)
            });

        self.root_digest = Some(root_digest.clone());
        Ok(root_digest)
    }

    pub fn files_to_upload(&self) -> &[FileToUpload] {
        &self.files_to_upload
    }

    pub fn directories_to_upload(&self) -> Vec<(Directory, TDigest)> {
        let mut result = Vec::new();
        
        for (path, directory) in &self.directories {
            let mut buf = Vec::new();
            directory.encode(&mut buf).unwrap();
            let digest = crate::digest::compute_digest(&buf);
            result.push((directory.clone(), digest));
        }
        
        result
    }

    pub fn root_digest(&self) -> Option<TDigest> {
        self.root_digest.clone()
    }
}

impl Default for DirectoryBuilder {
    fn default() -> Self {
        Self::new()
    }
}
