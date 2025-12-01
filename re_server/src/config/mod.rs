use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ServerConfig {
    #[serde(default)]
    pub server: ServerSettings,
    pub storage: StorageConfig,
    #[serde(default)]
    pub execution: ExecutionConfig,
    #[serde(default)]
    pub capabilities: CapabilitiesConfig,
    pub gc: Option<GcConfig>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ServerSettings {
    #[serde(default = "default_address")]
    pub address: String,
    #[serde(default)]
    pub instance_name: String,
    #[serde(default = "default_max_concurrent_executions")]
    pub max_concurrent_executions: usize,
}

impl Default for ServerSettings {
    fn default() -> Self {
        Self {
            address: default_address(),
            instance_name: String::new(),
            max_concurrent_executions: default_max_concurrent_executions(),
        }
    }
}

fn default_address() -> String {
    "0.0.0.0:8980".to_string()
}

fn default_max_concurrent_executions() -> usize {
    100
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct StorageConfig {
    pub cas: CasStorageConfig,
    pub action_cache: ActionCacheConfig,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "backend")]
pub enum CasStorageConfig {
    #[serde(rename = "filesystem")]
    FileSystem { root_dir: PathBuf },
    
    #[serde(rename = "redis")]
    Redis {
        redis_url: String,
        #[serde(default)]
        max_inline_size: Option<usize>,
        #[serde(default)]
        key_prefix: Option<String>,
    },
    
    #[serde(rename = "tiered")]
    Tiered {
        l1: Box<CasStorageConfig>,
        l2: Box<CasStorageConfig>,
    },
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "backend")]
pub enum ActionCacheConfig {
    #[serde(rename = "filesystem")]
    FileSystem { root_dir: PathBuf },
    
    #[serde(rename = "redis")]
    Redis {
        redis_url: String,
        #[serde(default = "default_cache_ttl")]
        ttl_seconds: u64,
        #[serde(default)]
        key_prefix: Option<String>,
    },
    
    #[serde(rename = "memory")]
    Memory {
        #[serde(default = "default_max_cache_entries")]
        max_entries: usize,
    },
}

fn default_cache_ttl() -> u64 {
    86400
}

fn default_max_cache_entries() -> usize {
    10000
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ExecutionConfig {
    #[serde(default = "default_execution_backend")]
    pub backend: String,
    #[serde(default = "default_max_workers")]
    pub max_workers: usize,
    #[serde(default = "default_worker_timeout")]
    pub worker_timeout_seconds: u64,
    pub local: Option<LocalExecutionConfig>,
    pub docker: Option<DockerExecutionConfig>,
    pub pool: Option<WorkerPoolConfig>,
}

impl Default for ExecutionConfig {
    fn default() -> Self {
        Self {
            backend: default_execution_backend(),
            max_workers: default_max_workers(),
            worker_timeout_seconds: default_worker_timeout(),
            local: Some(LocalExecutionConfig::default()),
            docker: None,
            pool: None,
        }
    }
}

fn default_execution_backend() -> String {
    "local".to_string()
}

fn default_max_workers() -> usize {
    10
}

fn default_worker_timeout() -> u64 {
    3600
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct LocalExecutionConfig {
    pub work_dir: PathBuf,
    #[serde(default)]
    pub cache_dir: Option<PathBuf>,
}

impl Default for LocalExecutionConfig {
    fn default() -> Self {
        Self {
            work_dir: PathBuf::from("/tmp/expbuild-work"),
            cache_dir: Some(PathBuf::from("/tmp/expbuild-cache")),
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct DockerExecutionConfig {
    pub image: String,
    #[serde(default)]
    pub always_pull: bool,
    pub cpu_limit: Option<f64>,
    pub memory_limit: Option<u64>,
    #[serde(default = "default_network_mode")]
    pub network_mode: String,
    #[serde(default)]
    pub volumes: Vec<VolumeMount>,
    pub user: Option<String>,
}

fn default_network_mode() -> String {
    "none".to_string()
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct VolumeMount {
    pub host_path: PathBuf,
    pub container_path: PathBuf,
    #[serde(default)]
    pub read_only: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct WorkerPoolConfig {
    #[serde(default = "default_max_queue_size")]
    pub max_queue_size: usize,
    #[serde(default = "default_scheduler_interval_ms")]
    pub scheduler_interval_ms: u64,
    #[serde(default = "default_task_timeout")]
    pub default_task_timeout_seconds: u64,
    #[serde(default = "default_result_ttl")]
    pub result_ttl_seconds: u64,
    #[serde(default)]
    pub workers: Vec<WorkerConfig>,
}

fn default_max_queue_size() -> usize {
    1000
}

fn default_scheduler_interval_ms() -> u64 {
    100
}

fn default_task_timeout() -> u64 {
    3600
}

fn default_result_ttl() -> u64 {
    300
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "type")]
pub enum WorkerConfig {
    #[serde(rename = "host")]
    Host {
        #[serde(default = "default_worker_count")]
        count: usize,
        work_dir: PathBuf,
        #[serde(default)]
        use_chroot: bool,
        #[serde(default = "default_env_whitelist")]
        env_whitelist: Vec<String>,
        run_as_user: Option<String>,
        run_as_group: Option<String>,
    },
    #[serde(rename = "docker")]
    Docker {
        #[serde(default = "default_worker_count")]
        count: usize,
        image: String,
        #[serde(default)]
        always_pull: bool,
        cpu_limit: Option<f64>,
        memory_limit: Option<u64>,
        #[serde(default = "default_network_mode")]
        network_mode: String,
        #[serde(default)]
        volumes: Vec<VolumeMount>,
        user: Option<String>,
    },
}

fn default_worker_count() -> usize {
    1
}

fn default_env_whitelist() -> Vec<String> {
    vec![
        "PATH".to_string(),
        "HOME".to_string(),
        "USER".to_string(),
        "TMPDIR".to_string(),
    ]
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct CapabilitiesConfig {
    #[serde(default = "default_digest_functions")]
    pub digest_functions: Vec<String>,
    #[serde(default = "default_max_batch_size")]
    pub max_batch_total_size_bytes: i64,
    #[serde(default = "default_supported_compressors")]
    pub supported_compressors: Vec<String>,
    #[serde(default = "default_true")]
    pub exec_enabled: bool,
    #[serde(default = "default_true")]
    pub action_cache_update_enabled: bool,
    #[serde(default)]
    pub symlink_absolute_path_strategy: String,
}

impl Default for CapabilitiesConfig {
    fn default() -> Self {
        Self {
            digest_functions: default_digest_functions(),
            max_batch_total_size_bytes: default_max_batch_size(),
            supported_compressors: default_supported_compressors(),
            exec_enabled: true,
            action_cache_update_enabled: true,
            symlink_absolute_path_strategy: "DISALLOWED".to_string(),
        }
    }
}

fn default_digest_functions() -> Vec<String> {
    vec!["SHA256".to_string()]
}

fn default_max_batch_size() -> i64 {
    4194304
}

fn default_supported_compressors() -> Vec<String> {
    vec!["ZSTD".to_string(), "DEFLATE".to_string()]
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct GcConfig {
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default = "default_gc_interval")]
    pub interval_seconds: u64,
    #[serde(default = "default_cas_ttl")]
    pub cas_ttl_seconds: u64,
    #[serde(default = "default_cache_ttl")]
    pub action_cache_ttl_seconds: u64,
}

fn default_gc_interval() -> u64 {
    3600
}

fn default_cas_ttl() -> u64 {
    604800
}

impl ServerConfig {
    pub fn from_file(path: &std::path::Path) -> anyhow::Result<Self> {
        let content = std::fs::read_to_string(path)?;
        let config: ServerConfig = toml::from_str(&content)?;
        Ok(config)
    }
    
    pub fn to_file(&self, path: &std::path::Path) -> anyhow::Result<()> {
        let content = toml::to_string_pretty(self)?;
        std::fs::write(path, content)?;
        Ok(())
    }
}
