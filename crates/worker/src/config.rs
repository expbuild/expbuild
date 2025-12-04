use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::time::Duration;

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct WorkerConfig {
    pub worker_id: Option<String>,
    pub server_url: String,
    pub cas_url: String,
    #[serde(default = "default_work_dir")]
    pub work_dir: PathBuf,
    #[serde(default = "default_max_concurrent_tasks")]
    pub max_concurrent_tasks: usize,
    #[serde(default = "default_heartbeat_interval_seconds")]
    pub heartbeat_interval_seconds: u64,
    #[serde(default = "default_lease_poll_interval_seconds")]
    pub lease_poll_interval_seconds: u64,
    pub platform: PlatformConfig,
    #[serde(default)]
    pub executor: ExecutorBackend,
}

fn default_max_concurrent_tasks() -> usize {
    4
}

fn default_heartbeat_interval_seconds() -> u64 {
    30
}

fn default_lease_poll_interval_seconds() -> u64 {
    5
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct PlatformConfig {
    #[serde(flatten)]
    pub properties: std::collections::HashMap<String, String>,
}

pub use crate::executor::types::ExecutorBackendConfig as ExecutorBackend;
pub use crate::executor::{HostExecutorConfig, DockerExecutorConfig};

fn default_work_dir() -> PathBuf {
    std::env::temp_dir().join("expbuild-worker")
}

impl WorkerConfig {
    pub fn from_file(path: &std::path::Path) -> anyhow::Result<Self> {
        let content = std::fs::read_to_string(path)?;
        let config: WorkerConfig = toml::from_str(&content)?;
        Ok(config)
    }

    pub fn heartbeat_interval(&self) -> Duration {
        Duration::from_secs(self.heartbeat_interval_seconds)
    }

    pub fn lease_poll_interval(&self) -> Duration {
        Duration::from_secs(self.lease_poll_interval_seconds)
    }
}
