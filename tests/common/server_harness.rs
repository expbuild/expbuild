use anyhow::{Context, Result};
use re_server::config::*;
use re_server::storage::{create_action_cache_store, create_blob_store};
use re_server::cas::CasManager;
use re_server::cache::ActionCacheManager;
use re_server::execution::{ExecutionManager, WorkerScheduler};
use re_server::execution::scheduler::SchedulerConfig;
use re_server::grpc::{
    CapabilitiesService, CasService, ActionCacheService,
    ByteStreamService, ExecutionService, WorkerSchedulerService,
};
use std::net::SocketAddr;
use std::sync::Arc;
use tempfile::TempDir;
use tokio::task::JoinHandle;
use tonic::transport::Server;

pub struct ServerHarness {
    server_handle: JoinHandle<Result<()>>,
    server_addr: SocketAddr,
    _temp_dir: TempDir,
}

impl ServerHarness {
    pub async fn start() -> Result<Self> {
        let temp_dir = TempDir::new().context("Failed to create temp directory")?;
        
        let config = ServerConfig {
            server: ServerSettings {
                address: "127.0.0.1:0".to_string(),
                instance_name: "test".to_string(),
                max_concurrent_executions: 100,
            },
            storage: StorageConfig {
                cas: CasStorageConfig::FileSystem {
                    root_dir: temp_dir.path().join("cas"),
                },
                action_cache: ActionCacheConfig::FileSystem {
                    root_dir: temp_dir.path().join("ac"),
                },
            },
            execution: ExecutionConfig::default(),
            capabilities: CapabilitiesConfig::default(),
            gc: None,
        };

        tokio::fs::create_dir_all(temp_dir.path().join("cas")).await?;
        tokio::fs::create_dir_all(temp_dir.path().join("ac")).await?;

        let blob_store = create_blob_store(&config.storage.cas).await?;
        let action_cache_store = create_action_cache_store(&config.storage.action_cache).await?;

        let cas_manager = Arc::new(CasManager::new(blob_store));
        let action_cache_manager = Arc::new(ActionCacheManager::new(action_cache_store));
        
        let worker_scheduler = WorkerScheduler::new(SchedulerConfig::default());
        let execution_manager = Arc::new(
            ExecutionManager::with_worker_scheduler(
                cas_manager.clone(),
                action_cache_manager.clone(),
                worker_scheduler.clone(),
            )
        );

        let capabilities_service = CapabilitiesService::new(
            config.capabilities.clone(),
        );
        let cas_service = CasService::new(
            cas_manager.clone(),
        );
        let action_cache_service = ActionCacheService::new(
            action_cache_manager.clone(),
        );
        let bytestream_service = ByteStreamService::new(
            cas_manager.clone(),
        );
        let execution_service = ExecutionService::new(
            execution_manager.clone(),
        );
        let worker_scheduler_service = WorkerSchedulerService::new(
            worker_scheduler.clone(),
        );

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let server_addr = listener.local_addr()?;
        
        tracing::info!("Test server starting on {}", server_addr);

        let server_handle = tokio::spawn(async move {
            Server::builder()
                .add_service(re_grpc_proto::build::bazel::remote::execution::v2::capabilities_server::CapabilitiesServer::new(capabilities_service))
                .add_service(re_grpc_proto::build::bazel::remote::execution::v2::content_addressable_storage_server::ContentAddressableStorageServer::new(cas_service))
                .add_service(re_grpc_proto::build::bazel::remote::execution::v2::action_cache_server::ActionCacheServer::new(action_cache_service))
                .add_service(re_grpc_proto::google::bytestream::byte_stream_server::ByteStreamServer::new(bytestream_service))
                .add_service(re_grpc_proto::build::bazel::remote::execution::v2::execution_server::ExecutionServer::new(execution_service))
                .add_service(re_grpc_proto::expbuild::worker::v1::worker_scheduler_server::WorkerSchedulerServer::new(worker_scheduler_service))
                .serve_with_incoming(tokio_stream::wrappers::TcpListenerStream::new(listener))
                .await
                .context("Server failed")
        });

        tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;

        Ok(Self {
            server_handle,
            server_addr,
            _temp_dir: temp_dir,
        })
    }

    pub fn addr(&self) -> SocketAddr {
        self.server_addr
    }

    pub fn url(&self) -> String {
        format!("{}", self.server_addr)
    }

    pub async fn shutdown(self) -> Result<()> {
        self.server_handle.abort();
        Ok(())
    }
}

impl Drop for ServerHarness {
    fn drop(&mut self) {
        self.server_handle.abort();
    }
}
