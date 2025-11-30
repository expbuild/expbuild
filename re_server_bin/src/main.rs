use anyhow::Result;
use clap::Parser;
use re_server::{
    cache::ActionCacheManager,
    cas::CasManager,
    config::ServerConfig,
    execution::ExecutionManager,
    grpc::{
        ActionCacheService, ByteStreamService, CapabilitiesService, CasService, ExecutionService,
    },
    storage::{create_action_cache_store, create_blob_store},
};
use std::path::PathBuf;
use std::sync::Arc;
use tonic::transport::Server;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

use re_grpc_proto::build::bazel::remote::execution::v2::{
    action_cache_server::ActionCacheServer, capabilities_server::CapabilitiesServer,
    content_addressable_storage_server::ContentAddressableStorageServer,
    execution_server::ExecutionServer,
};
use re_grpc_proto::google::bytestream::byte_stream_server::ByteStreamServer;

#[derive(Parser)]
#[command(name = "re-server")]
#[command(author = "ExpBuild Team")]
#[command(version)]
#[command(about = "Bazel Remote Execution API server", long_about = None)]
struct Cli {
    #[arg(short, long, value_name = "FILE")]
    config: PathBuf,

    #[arg(short, long)]
    verbose: bool,
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();

    init_tracing(cli.verbose);

    tracing::info!("Loading configuration from: {}", cli.config.display());
    let config = ServerConfig::from_file(&cli.config)?;

    tracing::info!("Initializing storage...");
    let blob_store = create_blob_store(&config.storage.cas).await?;
    let action_cache_store = create_action_cache_store(&config.storage.action_cache).await?;

    tracing::info!("Initializing managers...");
    let cas_manager = Arc::new(CasManager::new(blob_store));
    let cache_manager = Arc::new(ActionCacheManager::new(action_cache_store));
    let execution_manager = Arc::new(ExecutionManager::new(
        cas_manager.clone(),
        cache_manager.clone(),
    ));

    tracing::info!("Initializing gRPC services...");
    let capabilities_service = CapabilitiesService::new(config.capabilities.clone());
    let cas_service = CasService::new(cas_manager.clone());
    let action_cache_service = ActionCacheService::new(cache_manager.clone());
    let bytestream_service = ByteStreamService::new(cas_manager.clone());
    let execution_service = ExecutionService::new(execution_manager.clone());

    let addr = config.server.address.parse()?;
    tracing::info!("Starting server on {}", addr);

    Server::builder()
        .add_service(CapabilitiesServer::new(capabilities_service))
        .add_service(ContentAddressableStorageServer::new(cas_service))
        .add_service(ActionCacheServer::new(action_cache_service))
        .add_service(ByteStreamServer::new(bytestream_service))
        .add_service(ExecutionServer::new(execution_service))
        .serve(addr)
        .await?;

    Ok(())
}

fn init_tracing(verbose: bool) {
    let filter = if verbose {
        "re_server=debug,re_server_bin=debug"
    } else {
        "re_server=info,re_server_bin=info"
    };

    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| filter.into()),
        )
        .with(tracing_subscriber::fmt::layer())
        .init();
}
