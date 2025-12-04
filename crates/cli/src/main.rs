mod cli;
mod commands;
mod config;

use anyhow::Result;
use clap::Parser;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

use cli::Cli;

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();

    init_tracing(cli.verbose);

    let config_path = cli.config.or_else(|| config::find_default_config());

    let config = if let Some(path) = config_path {
        tracing::info!("Loading config from: {}", path.display());
        config::load_config(&path)?
    } else {
        tracing::info!("No config file found, using defaults");
        cli::Config {
            remote: cli::RemoteConfig::default(),
            tls: cli::TlsConfig::default(),
            grpc: cli::GrpcConfig::default(),
        }
    };

    if let Err(e) = commands::execute_command(cli.command, config).await {
        eprintln!("Error: {:#}", e);
        std::process::exit(1);
    }

    Ok(())
}

fn init_tracing(verbose: bool) {
    let filter = if verbose {
        "expbuild_cli=debug,remote_execution=debug"
    } else {
        "expbuild_cli=info,remote_execution=warn"
    };

    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| filter.into()),
        )
        .with(tracing_subscriber::fmt::layer())
        .init();
}
