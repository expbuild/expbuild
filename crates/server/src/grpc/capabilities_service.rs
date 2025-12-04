use crate::config::CapabilitiesConfig;
use anyhow::Result;
use re_grpc_proto::build::bazel::remote::execution::v2::{
    capabilities_server::Capabilities, compressor, digest_function,
    symlink_absolute_path_strategy, ActionCacheUpdateCapabilities, CacheCapabilities,
    ExecutionCapabilities, GetCapabilitiesRequest, ServerCapabilities,
};
use re_grpc_proto::build::bazel::semver::SemVer;
use tonic::{Request, Response, Status};

pub struct CapabilitiesService {
    config: CapabilitiesConfig,
}

impl CapabilitiesService {
    pub fn new(config: CapabilitiesConfig) -> Self {
        Self { config }
    }
    
    fn build_capabilities(&self) -> ServerCapabilities {
        let digest_functions: Vec<i32> = self
            .config
            .digest_functions
            .iter()
            .filter_map(|name| match name.to_uppercase().as_str() {
                "SHA256" => Some(digest_function::Value::Sha256 as i32),
                "SHA1" => Some(digest_function::Value::Sha1 as i32),
                "MD5" => Some(digest_function::Value::Md5 as i32),
                "SHA384" => Some(digest_function::Value::Sha384 as i32),
                "SHA512" => Some(digest_function::Value::Sha512 as i32),
                _ => None,
            })
            .collect();
        
        let supported_compressors: Vec<i32> = self
            .config
            .supported_compressors
            .iter()
            .filter_map(|name| match name.to_uppercase().as_str() {
                "ZSTD" => Some(compressor::Value::Zstd as i32),
                "DEFLATE" => Some(compressor::Value::Deflate as i32),
                "BROTLI" => Some(compressor::Value::Brotli as i32),
                _ => None,
            })
            .collect();
        
        let symlink_strategy = match self.config.symlink_absolute_path_strategy.to_uppercase().as_str() {
            "ALLOWED" => symlink_absolute_path_strategy::Value::Allowed as i32,
            _ => symlink_absolute_path_strategy::Value::Disallowed as i32,
        };
        
        ServerCapabilities {
            cache_capabilities: Some(CacheCapabilities {
                digest_functions: digest_functions.clone(),
                action_cache_update_capabilities: Some(ActionCacheUpdateCapabilities {
                    update_enabled: self.config.action_cache_update_enabled,
                }),
                cache_priority_capabilities: None,
                max_batch_total_size_bytes: self.config.max_batch_total_size_bytes,
                symlink_absolute_path_strategy: symlink_strategy,
                supported_compressors: supported_compressors.clone(),
                supported_batch_update_compressors: supported_compressors.clone(),
                max_cas_blob_size_bytes: 0,
                blob_split_support: false,
                blob_splice_support: false,
            }),
            execution_capabilities: if self.config.exec_enabled {
                Some(ExecutionCapabilities {
                    digest_function: digest_functions.first().copied().unwrap_or(digest_function::Value::Sha256 as i32),
                    exec_enabled: self.config.exec_enabled,
                    execution_priority_capabilities: None,
                    supported_node_properties: vec![],
                    digest_functions,
                })
            } else {
                None
            },
            deprecated_api_version: Some(SemVer {
                major: 2,
                minor: 0,
                patch: 0,
                prerelease: String::new(),
            }),
            low_api_version: Some(SemVer {
                major: 2,
                minor: 0,
                patch: 0,
                prerelease: String::new(),
            }),
            high_api_version: Some(SemVer {
                major: 2,
                minor: 3,
                patch: 0,
                prerelease: String::new(),
            }),
        }
    }
}

#[tonic::async_trait]
impl Capabilities for CapabilitiesService {
    async fn get_capabilities(
        &self,
        _request: Request<GetCapabilitiesRequest>,
    ) -> Result<Response<ServerCapabilities>, Status> {
        tracing::debug!("GetCapabilities request received");
        let capabilities = self.build_capabilities();
        Ok(Response::new(capabilities))
    }
}
