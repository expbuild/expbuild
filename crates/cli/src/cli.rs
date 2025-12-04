use clap::{Parser, Subcommand};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Parser)]
#[command(name = "expbuild")]
#[command(author = "ExpBuild Team")]
#[command(version)]
#[command(about = "Command-line tool for Bazel Remote Execution API", long_about = None)]
#[command(propagate_version = true)]
pub struct Cli {
    #[command(subcommand)]
    pub command: Commands,

    #[arg(short, long, value_name = "FILE", global = true)]
    pub config: Option<PathBuf>,

    #[arg(short, long, global = true)]
    pub verbose: bool,
}

#[derive(Subcommand)]
pub enum Commands {
    #[command(about = "Execute an action remotely")]
    Execute {
        #[arg(short, long, help = "Action digest in format hash:size")]
        action_digest: String,

        #[arg(short = 'k', long, help = "Skip cache lookup")]
        skip_cache: bool,

        #[arg(long, help = "Instance name")]
        instance_name: Option<String>,

        #[arg(short, long, help = "Output directory for results")]
        output: Option<PathBuf>,
    },

    #[command(about = "Run a command with remote execution")]
    Run {
        #[arg(value_name = "COMMAND", help = "Command to execute")]
        command: String,

        #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
        args: Vec<String>,

        #[arg(short, long, help = "Input directory to upload")]
        input: Option<PathBuf>,

        #[arg(short, long, help = "Output directory for results")]
        output: PathBuf,

        #[arg(long, value_name = "PATH", help = "Expected output files/directories")]
        output_paths: Vec<String>,

        #[arg(short, long, value_name = "KEY=VALUE", help = "Environment variables")]
        env: Vec<String>,

        #[arg(short, long, help = "Working directory")]
        working_dir: Option<String>,

        #[arg(short = 'k', long, help = "Skip cache lookup")]
        skip_cache: bool,

        #[arg(long, help = "Timeout in seconds")]
        timeout: Option<u64>,

        #[arg(long, help = "Instance name")]
        instance_name: Option<String>,
    },

    #[command(about = "Prepare action and print digest")]
    PrepareAction {
        #[arg(value_name = "COMMAND", help = "Command to execute")]
        command: String,

        #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
        args: Vec<String>,

        #[arg(short, long, help = "Input directory to upload")]
        input: Option<PathBuf>,

        #[arg(long, value_name = "PATH", help = "Expected output files/directories")]
        output_paths: Vec<String>,

        #[arg(short, long, value_name = "KEY=VALUE", help = "Environment variables")]
        env: Vec<String>,

        #[arg(short, long, help = "Working directory")]
        working_dir: Option<String>,

        #[arg(long, help = "Only compute digest, don't upload")]
        dry_run: bool,

        #[arg(long, help = "Timeout in seconds")]
        timeout: Option<u64>,
    },

    #[command(about = "Upload files to CAS")]
    Upload {
        #[arg(value_name = "FILE", help = "Files to upload")]
        files: Vec<PathBuf>,

        #[arg(long, help = "Instance name")]
        instance_name: Option<String>,

        #[arg(long, help = "Show upload progress")]
        progress: bool,
    },

    #[command(about = "Download files from CAS")]
    Download {
        #[arg(short, long, value_name = "DIGEST", help = "Digest in format hash:size")]
        digest: String,

        #[arg(short, long, value_name = "FILE", help = "Output file path")]
        output: PathBuf,

        #[arg(long, help = "Instance name")]
        instance_name: Option<String>,
    },

    #[command(about = "Check if blobs exist in CAS")]
    FindMissing {
        #[arg(value_name = "DIGEST", help = "Digests to check (hash:size)")]
        digests: Vec<String>,

        #[arg(long, help = "Instance name")]
        instance_name: Option<String>,
    },

    #[command(about = "Get action result from cache")]
    GetActionResult {
        #[arg(short, long, help = "Action digest in format hash:size")]
        action_digest: String,

        #[arg(long, help = "Instance name")]
        instance_name: Option<String>,
    },

    #[command(about = "Get server capabilities")]
    Capabilities {
        #[arg(long, help = "Instance name")]
        instance_name: Option<String>,

        #[arg(long, help = "Output format (json or text)")]
        #[arg(default_value = "text")]
        format: OutputFormat,
    },

    #[command(about = "Test connection to remote execution service")]
    Ping {
        #[arg(long, help = "Timeout in seconds")]
        #[arg(default_value = "10")]
        timeout: u64,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OutputFormat {
    Json,
    Text,
}

impl std::str::FromStr for OutputFormat {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.to_lowercase().as_str() {
            "json" => Ok(OutputFormat::Json),
            "text" => Ok(OutputFormat::Text),
            _ => Err(format!("Invalid format: {}", s)),
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct Config {
    #[serde(default)]
    pub remote: RemoteConfig,

    #[serde(default)]
    pub tls: TlsConfig,

    #[serde(default)]
    pub grpc: GrpcConfig,
}

#[derive(Debug, Deserialize)]
pub struct RemoteConfig {
    pub engine_address: Option<String>,
    pub cas_address: Option<String>,
    pub action_cache_address: Option<String>,
    pub instance_name: Option<String>,
}

impl Default for RemoteConfig {
    fn default() -> Self {
        Self {
            engine_address: None,
            cas_address: None,
            action_cache_address: None,
            instance_name: None,
        }
    }
}

#[derive(Debug, Deserialize, Default)]
pub struct TlsConfig {
    #[serde(default)]
    pub enabled: bool,
    pub ca_certs: Option<String>,
    pub client_cert: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct GrpcConfig {
    pub keepalive_time_secs: Option<u64>,
    pub keepalive_timeout_secs: Option<u64>,
    pub keepalive_while_idle: Option<bool>,
    pub max_decoding_message_size: Option<usize>,
}

impl Default for GrpcConfig {
    fn default() -> Self {
        Self {
            keepalive_time_secs: Some(30),
            keepalive_timeout_secs: Some(10),
            keepalive_while_idle: Some(true),
            max_decoding_message_size: None,
        }
    }
}
