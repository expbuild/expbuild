use clap::{Parser, Subcommand};
use expbuild_worker::{WorkerAgent, WorkerConfig};
use std::path::PathBuf;
use tracing_subscriber::{fmt, prelude::*, EnvFilter};

#[derive(Parser)]
#[command(name = "expbuild-worker")]
#[command(about = "ExpBuild Remote Execution Worker", long_about = None)]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    Daemon {
        #[arg(long, help = "Path to worker configuration file")]
        config: PathBuf,

        #[arg(long, short = 'v', help = "Enable verbose logging")]
        verbose: bool,
    },

    Execute {
        #[arg(long, help = "CAS server URL")]
        cas_url: String,

        #[arg(long, help = "Action digest (hash/size)")]
        action_digest: String,

        #[arg(long, help = "Working directory")]
        work_dir: PathBuf,

        #[arg(long, short = 'v', help = "Enable verbose logging")]
        verbose: bool,
    },
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();

    match cli.command {
        Commands::Daemon { config, verbose } => {
            init_logging(verbose);
            run_daemon(config).await
        }
        Commands::Execute {
            cas_url,
            action_digest,
            work_dir,
            verbose,
        } => {
            init_logging(verbose);
            run_execute(cas_url, action_digest, work_dir).await
        }
    }
}

fn init_logging(verbose: bool) {
    let filter = if verbose {
        EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("debug"))
    } else {
        EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"))
    };

    tracing_subscriber::registry()
        .with(filter)
        .with(fmt::layer())
        .init();
}

async fn run_daemon(config_path: PathBuf) -> anyhow::Result<()> {
    tracing::info!("Loading worker configuration from: {:?}", config_path);

    let config = WorkerConfig::from_file(&config_path)?;

    tracing::info!("Starting worker in daemon mode...");
    tracing::info!("  Server URL: {}", config.server_url);
    tracing::info!("  CAS URL: {}", config.cas_url);
    tracing::info!(
        "  Max concurrent tasks: {}",
        config.max_concurrent_tasks
    );
    tracing::info!("  Platform: {:?}", config.platform.properties);

    let mut agent = WorkerAgent::new(config).await?;

    agent.run().await?;

    Ok(())
}

async fn run_execute(
    cas_url: String,
    action_digest: String,
    work_dir: PathBuf,
) -> anyhow::Result<()> {
    tracing::info!("Single execution mode");
    tracing::info!("  CAS URL: {}", cas_url);
    tracing::info!("  Action Digest: {}", action_digest);
    tracing::info!("  Work Dir: {:?}", work_dir);

    anyhow::bail!("Single execution mode not yet implemented. Use daemon mode instead.");
}
