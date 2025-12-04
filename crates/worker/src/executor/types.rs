use serde::{Deserialize, Serialize};
use std::time::Duration;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum IsolationLevel {
    None,
    ProcessOnly,
    Filesystem,
    Container,
    VM,
}

#[derive(Debug, Clone)]
pub struct ExecutorCapabilities {
    pub isolation_level: IsolationLevel,
    pub supports_cpu_limit: bool,
    pub supports_memory_limit: bool,
    pub supports_disk_limit: bool,
    pub supports_network_isolation: bool,
    pub supports_readonly_rootfs: bool,
    pub platform: String,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct ResourceLimits {
    pub cpu_cores: Option<f64>,
    pub memory_bytes: Option<u64>,
    pub disk_bytes: Option<u64>,
    pub network: NetworkPolicy,
    pub max_processes: Option<u32>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub enum NetworkPolicy {
    None,
    Localhost,
    Restricted(Vec<String>),
    Full,
}

impl Default for NetworkPolicy {
    fn default() -> Self {
        NetworkPolicy::None
    }
}

#[derive(Debug, Clone, Default)]
pub struct ExecutionStats {
    pub duration: Duration,
    pub cpu_time_us: u64,
    pub peak_memory_bytes: u64,
    pub disk_read_bytes: u64,
    pub disk_write_bytes: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum ExecutorBackendConfig {
    Host(super::host::HostExecutorConfig),
    Docker(super::docker::DockerExecutorConfig),
}

impl Default for ExecutorBackendConfig {
    fn default() -> Self {
        ExecutorBackendConfig::Host(super::host::HostExecutorConfig::default())
    }
}

pub struct OutputFileInfo {
    pub path: String,
    pub data: Vec<u8>,
    pub is_executable: bool,
}

#[derive(Debug, Clone)]
pub struct ContainerLogs {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}
