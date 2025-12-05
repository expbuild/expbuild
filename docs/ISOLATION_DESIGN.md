# Worker Environment Isolation Solution Design

> **Document Status**: Design Phase - Pending Review
> **Creation Date**: 2025-12-04
> **Author**: Claude Code

---

## Table of Contents

- [I. Background and Objectives](#i-background-and-objectives)
- [II. Technical Research](#ii-technical-research)
- [III. Solution Design](#iii-solution-design)
- [IV. Detailed Implementation](#iv-detailed-implementation)
- [V. Configuration Examples](#v-configuration-examples)
- [VI. Security Hardening](#vi-security-hardening)
- [VII. Performance Analysis](#vii-performance-analysis)
- [VIII. Implementation Plan](#viii-implementation-plan)
- [IX. Risk Assessment](#ix-risk-assessment)

---

## I. Background and Objectives

### 1.1 Current Issues

The existing Worker implementation (`HostExecutor`) executes build tasks directly on the host, which has the following issues:

1. **Security Risks**: Malicious code can access host filesystem, network, and processes
2. **Resource Contention**: Unable to limit CPU/memory/disk usage per task
3. **Environment Pollution**: Tasks may interfere with each other (file residue, port occupation, etc.)
4. **Non-determinism**: Build results depend on host environment, making them difficult to reproduce

### 1.2 Design Objectives

1. **Security Isolation**: Tasks cannot access sensitive host resources
2. **Resource Control**: Configurable CPU/memory/disk quotas
3. **Environment Consistency**: Reproducible build environments (via container images)
4. **High Performance**: Isolation overhead < 10%
5. **Extensibility**: Support multiple isolation backends (Docker, Podman, VM, etc.)
6. **Cross-platform**: Available solutions for Linux/macOS/Windows

---

## II. Technical Research

### 2.1 Linux Platform

| Technology | Isolation Capability | Performance Overhead | Maturity | Ease of Use | Use Case |
|------|---------|---------|--------|--------|---------|
| **Docker/Containerd** | ⭐⭐⭐⭐⭐ | Medium (5-10%) | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | **Recommended for Production** |
| **Podman** | ⭐⭐⭐⭐⭐ | Low (3-8%) | ⭐⭐⭐⭐☆ | ⭐⭐⭐⭐☆ | Rootless security scenarios |
| **systemd-nspawn** | ⭐⭐⭐⭐☆ | Low (2-5%) | ⭐⭐⭐⭐☆ | ⭐⭐⭐☆☆ | Lightweight containers |
| **Linux Namespaces + cgroups** | ⭐⭐⭐⭐☆ | Very Low (1-3%) | ⭐⭐⭐☆☆ | ⭐⭐☆☆☆ | Custom high-performance solutions |
| **Firecracker** | ⭐⭐⭐⭐⭐ | Medium (5-10%) | ⭐⭐⭐⭐☆ | ⭐⭐☆☆☆ | microVM (AWS Lambda) |
| **gVisor (runsc)** | ⭐⭐⭐⭐⭐ | High (15-30%) | ⭐⭐⭐⭐☆ | ⭐⭐⭐☆☆ | Kernel-level isolation (Google) |

**Recommended**: Docker (production) + Namespace (optional for high performance)

### 2.2 macOS Platform

| Technology | Isolation Capability | Performance Overhead | Maturity | Ease of Use | Use Case |
|------|---------|---------|--------|--------|---------|
| **Docker Desktop** | ⭐⭐⭐⭐☆ | High (VM layer) | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | **Recommended for Development** |
| **Podman Machine** | ⭐⭐⭐⭐☆ | High (VM layer) | ⭐⭐⭐☆☆ | ⭐⭐⭐☆☆ | Docker alternative |
| **Lima** | ⭐⭐⭐⭐☆ | High (VM layer) | ⭐⭐⭐☆☆ | ⭐⭐⭐⭐☆ | Lightweight Linux VM |
| **macOS Sandbox API** | ⭐⭐⭐☆☆ | Low | ⭐⭐⭐☆☆ | ⭐⭐☆☆☆ | Native sandbox (limited) |

**Limitation**: macOS lacks native container support, all solutions depend on Linux VMs

### 2.3 Windows Platform

| Technology | Isolation Capability | Performance Overhead | Maturity | Ease of Use | Use Case |
|------|---------|---------|--------|--------|---------|
| **Docker Desktop** | ⭐⭐⭐⭐☆ | High (WSL2) | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | **Recommended for Development** |
| **Windows Containers** | ⭐⭐⭐⭐⭐ | Medium | ⭐⭐⭐⭐☆ | ⭐⭐⭐☆☆ | Native Windows containers |
| **WSL2** | ⭐⭐⭐⭐☆ | Medium | ⭐⭐⭐⭐☆ | ⭐⭐⭐⭐☆ | Linux compatibility layer |
| **Windows Sandbox** | ⭐⭐⭐⭐☆ | High | ⭐⭐⭐⭐☆ | ⭐⭐⭐⭐☆ | Disposable lightweight VM |
| **AppContainer** | ⭐⭐⭐☆☆ | Low | ⭐⭐⭐☆☆ | ⭐⭐☆☆☆ | UWP app sandbox |

**Recommended**: Docker Desktop (WSL2) or Windows Containers

### 2.4 Technology Selection Conclusion

| Priority | Solution | Rationale |
|-------|------|------|
| **P0** | Docker | Cross-platform, mature, complete ecosystem, best ease of use |
| **P1** | Podman | Rootless alternative on Linux |
| **P2** | Linux Namespaces | Native implementation for performance-sensitive scenarios |
| **P3** | Firecracker | Serverless/multi-tenant scenarios |

---

## III. Solution Design

### 3.1 Architecture Overview

```
┌─────────────────────────────────────────────────────┐
│              Worker Agent                           │
│  ┌───────────────────────────────────────────────┐ │
│  │         TaskExecutor Trait (unified interface)│ │
│  └───────────────────────────────────────────────┘ │
│                       ↓                             │
│    ┌──────────┬──────────┬──────────┬──────────┐  │
│    │   Host   │  Docker  │  Podman  │Namespace │  │
│    │ Executor │ Executor │ Executor │ Executor │  │
│    └──────────┴──────────┴──────────┴──────────┘  │
│         ↓          ↓          ↓          ↓         │
└─────────┼──────────┼──────────┼──────────┼─────────┘
          │          │          │          │
          ↓          ↓          ↓          ↓
    ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌──────────┐
    │  Host   │ │ Docker  │ │ Podman  │ │ Linux    │
    │ Process │ │Container│ │Container│ │Namespace │
    └─────────┘ └─────────┘ └─────────┘ └──────────┘
```

### 3.2 Core Interface Design

```rust
// crates/worker/src/executor/mod.rs

use anyhow::Result;
use async_trait::async_trait;
use std::time::Duration;
use std::path::PathBuf;

/// Unified task executor interface
#[async_trait]
pub trait TaskExecutor: Send + Sync {
    /// Execute task
    async fn execute(&self, request: ExecutionRequest) -> Result<ExecutionResult>;

    /// Get isolation level
    fn isolation_level(&self) -> IsolationLevel;

    /// Health check (check Docker daemon, etc.)
    async fn health_check(&self) -> Result<()>;

    /// Warmup (pull images, create container pool, etc.)
    async fn warmup(&self) -> Result<()>;

    /// Get capability information
    fn capabilities(&self) -> ExecutorCapabilities;
}

/// Isolation level
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum IsolationLevel {
    None,           // Execute directly on host
    ProcessOnly,    // Process-level isolation only
    Filesystem,     // Filesystem isolation (chroot)
    Container,      // Full container isolation (namespace + cgroup)
    VM,             // Virtual machine-level isolation
}

/// Executor capabilities
#[derive(Debug, Clone)]
pub struct ExecutorCapabilities {
    pub isolation_level: IsolationLevel,
    pub supports_cpu_limit: bool,
    pub supports_memory_limit: bool,
    pub supports_disk_limit: bool,
    pub supports_network_isolation: bool,
    pub supports_readonly_rootfs: bool,
    pub platform: String,  // "linux", "darwin", "windows"
}

/// Execution request
pub struct ExecutionRequest {
    pub command: Command,
    pub work_dir: PathBuf,
    pub resource_limits: ResourceLimits,
    pub timeout: Duration,
}

/// Resource limits
#[derive(Debug, Clone)]
pub struct ResourceLimits {
    pub cpu_cores: Option<f64>,        // e.g. 0.5 = 50% of single core
    pub memory_bytes: Option<u64>,     // Memory limit (bytes)
    pub disk_bytes: Option<u64>,       // Disk quota (bytes)
    pub network: NetworkPolicy,        // Network policy
    pub max_processes: Option<u32>,    // Max processes (prevent fork bomb)
}

/// Network policy
#[derive(Debug, Clone)]
pub enum NetworkPolicy {
    None,                              // No network access
    Localhost,                         // Local loopback only
    Restricted(Vec<String>),           // IP/domain whitelist
    Full,                              // Full access
}

/// Execution result
pub struct ExecutionResult {
    pub exit_code: i32,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub output_files: Vec<OutputFile>,
    pub stats: ExecutionStats,
}

/// Execution statistics
#[derive(Debug, Clone, Default)]
pub struct ExecutionStats {
    pub duration: Duration,
    pub cpu_time_us: u64,              // CPU time (microseconds)
    pub peak_memory_bytes: u64,        // Peak memory
    pub disk_read_bytes: u64,
    pub disk_write_bytes: u64,
}
```

### 3.3 Configuration-Driven Design

```rust
// crates/worker/src/config.rs

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct WorkerConfig {
    // ... existing fields ...

    #[serde(default)]
    pub executor: ExecutorConfig,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum ExecutorConfig {
    Host(HostExecutorConfig),
    Docker(DockerExecutorConfig),
    Podman(PodmanExecutorConfig),
    Namespace(NamespaceExecutorConfig),
}

impl Default for ExecutorConfig {
    fn default() -> Self {
        ExecutorConfig::Host(HostExecutorConfig::default())
    }
}
```

---

## IV. Detailed Implementation

### 4.1 Docker Executor (Priority P0)

```rust
// crates/worker/src/executor/docker.rs

use bollard::{Docker, container::*, image::*};
use anyhow::{Context, Result};

pub struct DockerExecutor {
    docker: Docker,
    config: DockerExecutorConfig,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct DockerExecutorConfig {
    /// Container image (e.g. "rust:1.75-alpine")
    pub image: String,

    /// Whether to always pull the latest image before execution
    #[serde(default)]
    pub always_pull: bool,

    /// Network mode: "none", "bridge", "host"
    #[serde(default = "default_network_mode")]
    pub network_mode: String,

    /// Read-only root filesystem
    #[serde(default = "default_true")]
    pub readonly_rootfs: bool,

    /// Mount tmpfs at /tmp
    #[serde(default = "default_true")]
    pub mount_tmpfs: bool,

    /// Security options
    #[serde(default = "default_security_opts")]
    pub security_opts: Vec<String>,

    /// Default resource limits
    #[serde(default)]
    pub default_limits: ResourceLimits,

    /// Docker socket path (leave empty to use default)
    pub socket_path: Option<String>,
}

fn default_network_mode() -> String {
    "none".to_string()
}

fn default_true() -> bool {
    true
}

fn default_security_opts() -> Vec<String> {
    vec!["no-new-privileges".to_string()]
}

impl DockerExecutor {
    pub async fn new(config: DockerExecutorConfig) -> Result<Self> {
        // Connect to Docker daemon
        let docker = if let Some(socket) = &config.socket_path {
            Docker::connect_with_socket(socket, 120, bollard::API_DEFAULT_VERSION)?
        } else {
            Docker::connect_with_local_defaults()?
        };

        // Verify connection
        docker.ping().await.context("Failed to connect to Docker daemon")?;

        // Pre-pull image
        if config.always_pull {
            Self::pull_image(&docker, &config.image).await?;
        }

        Ok(Self { docker, config })
    }

    async fn pull_image(docker: &Docker, image: &str) -> Result<()> {
        use futures::StreamExt;

        tracing::info!("Pulling Docker image: {}", image);

        let mut stream = docker.create_image(
            Some(CreateImageOptions {
                from_image: image,
                ..Default::default()
            }),
            None,
            None,
        );

        while let Some(result) = stream.next().await {
            let info = result?;
            if let Some(progress) = info.progress {
                tracing::debug!("Pull progress: {}", progress);
            }
        }

        tracing::info!("Image pulled successfully: {}", image);
        Ok(())
    }

    fn build_container_config(
        &self,
        request: &ExecutionRequest,
    ) -> Result<Config<String>> {
        let work_dir_str = request.work_dir.to_string_lossy().to_string();

        // Merge default limits and request limits
        let limits = self.merge_limits(&request.resource_limits);

        Ok(Config {
            image: Some(self.config.image.clone()),
            cmd: Some(request.command.arguments.clone()),
            working_dir: Some("/workspace".to_string()),
            env: Some(self.build_env_vars(&request.command)),
            host_config: Some(HostConfig {
                // Mount work directory (read-only input + writable output)
                binds: Some(vec![
                    format!("{}:/workspace", work_dir_str),
                ]),

                // CPU limit (nano CPUs: 1 core = 1e9)
                nano_cpus: limits.cpu_cores
                    .map(|c| (c * 1_000_000_000.0) as i64),

                // Memory limit
                memory: limits.memory_bytes.map(|m| m as i64),

                // Memory + Swap limit (avoid swap usage)
                memory_swap: limits.memory_bytes.map(|m| m as i64),

                // Network mode
                network_mode: Some(self.config.network_mode.clone()),

                // Read-only root filesystem
                read_only_rootfs: Some(self.config.readonly_rootfs),

                // tmpfs mount (writable temporary directory)
                tmpfs: if self.config.mount_tmpfs {
                    Some(std::collections::HashMap::from([
                        (
                            "/tmp".to_string(),
                            "rw,noexec,nosuid,size=100m".to_string()
                        )
                    ]))
                } else {
                    None
                },

                // Security options
                security_opt: Some(self.config.security_opts.clone()),

                // PID limit (prevent fork bomb)
                pids_limit: limits.max_processes.map(|p| p as i64),

                // Disable privileged mode
                privileged: Some(false),

                // Auto-remove container
                auto_remove: Some(true),

                ..Default::default()
            }),
            ..Default::default()
        })
    }

    fn build_env_vars(&self, command: &Command) -> Vec<String> {
        command.environment_variables
            .iter()
            .map(|ev| format!("{}={}", ev.name, ev.value))
            .collect()
    }

    fn merge_limits(&self, request_limits: &ResourceLimits) -> ResourceLimits {
        ResourceLimits {
            cpu_cores: request_limits.cpu_cores
                .or(self.config.default_limits.cpu_cores),
            memory_bytes: request_limits.memory_bytes
                .or(self.config.default_limits.memory_bytes),
            disk_bytes: request_limits.disk_bytes
                .or(self.config.default_limits.disk_bytes),
            network: request_limits.network.clone(),
            max_processes: request_limits.max_processes
                .or(self.config.default_limits.max_processes),
        }
    }
}

#[async_trait]
impl TaskExecutor for DockerExecutor {
    async fn execute(&self, request: ExecutionRequest) -> Result<ExecutionResult> {
        let start_time = std::time::Instant::now();

        // 1. Create container
        let config = self.build_container_config(&request)?;
        let container = self.docker
            .create_container::<String, String>(None, config)
            .await?;

        let container_id = &container.id;
        tracing::info!("Created container: {}", container_id);

        // 2. Ensure container cleanup (even on panic)
        let docker_clone = self.docker.clone();
        let container_id_clone = container_id.clone();
        let _cleanup_guard = scopeguard::guard((), move |_| {
            tokio::spawn(async move {
                let _ = docker_clone.remove_container(
                    &container_id_clone,
                    Some(RemoveContainerOptions {
                        force: true,
                        v: true,  // Remove volumes
                        ..Default::default()
                    })
                ).await;
            });
        });

        // 3. Start container
        self.docker.start_container::<String>(container_id, None).await?;
        tracing::info!("Started container: {}", container_id);

        // 4. Wait for completion (with timeout)
        let wait_result = tokio::time::timeout(
            request.timeout,
            async {
                use futures::StreamExt;
                let mut stream = self.docker.wait_container::<String>(
                    container_id,
                    None::<WaitContainerOptions<String>>
                );
                stream.next().await
            }
        ).await;

        // 5. Handle timeout
        let exit_code = match wait_result {
            Ok(Some(Ok(result))) => result.status_code,
            Ok(Some(Err(e))) => {
                tracing::error!("Container wait error: {}", e);
                -1
            }
            Ok(None) => {
                tracing::warn!("Container wait stream ended unexpectedly");
                -1
            }
            Err(_) => {
                tracing::warn!("Container timeout, killing...");
                let _ = self.docker.kill_container::<String>(container_id, None).await;
                -124  // timeout exit code
            }
        };

        // 6. Get logs
        let logs = self.get_container_logs(container_id).await?;

        // 7. Collect output files
        let output_files = self.collect_outputs(
            container_id,
            &request.command.output_paths
        ).await?;

        // 8. Get statistics
        let stats = self.get_container_stats(container_id).await
            .unwrap_or_default();

        let duration = start_time.elapsed();
        tracing::info!(
            "Container {} finished: exit_code={}, duration={:.2}s",
            container_id,
            exit_code,
            duration.as_secs_f64()
        );

        Ok(ExecutionResult {
            exit_code: exit_code as i32,
            stdout: logs.stdout,
            stderr: logs.stderr,
            output_files,
            stats: ExecutionStats {
                duration,
                ..stats
            },
        })
    }

    fn isolation_level(&self) -> IsolationLevel {
        IsolationLevel::Container
    }

    async fn health_check(&self) -> Result<()> {
        self.docker.ping().await
            .context("Docker daemon not responding")?;

        // Check if image exists
        self.docker.inspect_image(&self.config.image).await
            .context("Container image not found")?;

        Ok(())
    }

    async fn warmup(&self) -> Result<()> {
        Self::pull_image(&self.docker, &self.config.image).await
    }

    fn capabilities(&self) -> ExecutorCapabilities {
        ExecutorCapabilities {
            isolation_level: IsolationLevel::Container,
            supports_cpu_limit: true,
            supports_memory_limit: true,
            supports_disk_limit: false,  // Docker requires additional configuration
            supports_network_isolation: true,
            supports_readonly_rootfs: true,
            platform: std::env::consts::OS.to_string(),
        }
    }
}
```

### 4.2 Podman Executor (Priority P1)

```rust
// crates/worker/src/executor/podman.rs

/// Podman executor (Rootless containers)
///
/// Advantages:
/// - Daemonless: No persistent daemon required
/// - Rootless: No root permissions needed
/// - Docker API compatible
/// - Better security (user namespaces)
pub struct PodmanExecutor {
    client: PodmanClient,
    config: PodmanExecutorConfig,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct PodmanExecutorConfig {
    pub image: String,

    /// Rootless mode
    #[serde(default = "default_true")]
    pub rootless: bool,

    /// User namespace mode: "auto", "keep-id", "nomap"
    #[serde(default = "default_userns")]
    pub userns: String,

    /// Podman socket path (rootless default: /run/user/{uid}/podman/podman.sock)
    pub socket_path: Option<String>,

    // ... other configurations same as Docker
}

fn default_userns() -> String {
    "auto".to_string()
}

impl PodmanExecutor {
    pub async fn new(config: PodmanExecutorConfig) -> Result<Self> {
        let socket_path = if let Some(path) = &config.socket_path {
            path.clone()
        } else if config.rootless {
            // Rootless socket path
            format!(
                "/run/user/{}/podman/podman.sock",
                nix::unistd::getuid()
            )
        } else {
            // Root socket path
            "/run/podman/podman.sock".to_string()
        };

        let client = PodmanClient::connect(&socket_path).await?;

        Ok(Self { client, config })
    }
}

// Implement TaskExecutor trait (similar to Docker)
```

### 4.3 Linux Namespace Executor (Priority P2)

```rust
// crates/worker/src/executor/namespace.rs

#[cfg(target_os = "linux")]
pub struct NamespaceExecutor {
    config: NamespaceExecutorConfig,
}

#[cfg(target_os = "linux")]
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct NamespaceExecutorConfig {
    /// Use PID namespace
    #[serde(default = "default_true")]
    pub use_pid_namespace: bool,

    /// Use Mount namespace
    #[serde(default = "default_true")]
    pub use_mount_namespace: bool,

    /// Use Network namespace
    #[serde(default = "default_true")]
    pub use_network_namespace: bool,

    /// Use UTS namespace (hostname)
    #[serde(default)]
    pub use_uts_namespace: bool,

    /// Use IPC namespace
    #[serde(default)]
    pub use_ipc_namespace: bool,

    /// Use User namespace (requires unprivileged user namespaces)
    #[serde(default)]
    pub use_user_namespace: bool,

    /// Cgroup parent path
    pub cgroup_parent: Option<String>,
}

#[cfg(target_os = "linux")]
impl NamespaceExecutor {
    async fn execute_in_namespace(
        &self,
        request: ExecutionRequest
    ) -> Result<ExecutionResult> {
        use nix::sched::{unshare, CloneFlags};
        use nix::unistd::{chroot, chdir, ForkResult};

        // Build clone flags
        let mut flags = CloneFlags::empty();
        if self.config.use_pid_namespace {
            flags |= CloneFlags::CLONE_NEWPID;
        }
        if self.config.use_mount_namespace {
            flags |= CloneFlags::CLONE_NEWNS;
        }
        if self.config.use_network_namespace {
            flags |= CloneFlags::CLONE_NEWNET;
        }
        if self.config.use_uts_namespace {
            flags |= CloneFlags::CLONE_NEWUTS;
        }
        if self.config.use_ipc_namespace {
            flags |= CloneFlags::CLONE_NEWIPC;
        }
        if self.config.use_user_namespace {
            flags |= CloneFlags::CLONE_NEWUSER;
        }

        // Fork process
        match unsafe { nix::unistd::fork()? } {
            ForkResult::Parent { child } => {
                // Parent process: set up cgroup and wait
                if let Some(cgroup_parent) = &self.config.cgroup_parent {
                    self.setup_cgroup(child, cgroup_parent, &request.resource_limits)?;
                }

                self.wait_child(child, request.timeout).await
            }
            ForkResult::Child => {
                // Child process: set up namespace and execute

                // 1. Unshare namespaces
                unshare(flags)?;

                // 2. chroot to work directory
                if self.config.use_mount_namespace {
                    chroot(&request.work_dir)?;
                    chdir("/")?;
                }

                // 3. Execute command
                use std::os::unix::process::CommandExt;
                let err = std::process::Command::new(&request.command.arguments[0])
                    .args(&request.command.arguments[1..])
                    .envs(self.build_env_vars(&request.command))
                    .exec();

                // Only reached if exec fails
                eprintln!("exec failed: {}", err);
                std::process::exit(127);
            }
        }
    }

    #[cfg(target_os = "linux")]
    fn setup_cgroup(
        &self,
        pid: nix::unistd::Pid,
        cgroup_parent: &str,
        limits: &ResourceLimits
    ) -> Result<()> {
        use std::fs;
        use std::io::Write;

        let cgroup_path = format!("{}/expbuild-{}", cgroup_parent, pid);
        fs::create_dir_all(&cgroup_path)?;

        // CPU limit
        if let Some(cpu_cores) = limits.cpu_cores {
            let quota = (cpu_cores * 100_000.0) as i64;
            let mut file = fs::File::create(format!("{}/cpu.max", cgroup_path))?;
            writeln!(file, "{} 100000", quota)?;
        }

        // Memory limit
        if let Some(memory_bytes) = limits.memory_bytes {
            let mut file = fs::File::create(format!("{}/memory.max", cgroup_path))?;
            writeln!(file, "{}", memory_bytes)?;
        }

        // Add process to cgroup
        let mut file = fs::File::create(format!("{}/cgroup.procs", cgroup_path))?;
        writeln!(file, "{}", pid)?;

        Ok(())
    }
}
```

---

## V. Configuration Examples

### 5.1 Docker Configuration (Recommended for Production)

```toml
# configs/worker/expbuild-worker-docker.toml

worker_id = "worker-docker-01"
server_url = "http://localhost:50051"
cas_url = "http://localhost:50051"
work_dir = "/tmp/expbuild-worker"
max_concurrent_tasks = 4

[platform]
os = "linux"
arch = "x86_64"
container = "docker"

[executor]
type = "docker"

[executor.docker]
image = "rust:1.75-alpine"
always_pull = false
network_mode = "none"
readonly_rootfs = true
mount_tmpfs = true
security_opts = ["no-new-privileges", "seccomp=default.json"]

[executor.docker.default_limits]
cpu_cores = 2.0
memory_bytes = 2147483648  # 2GB
max_processes = 128
network = "none"
```

### 5.2 Podman Rootless Configuration

```toml
# configs/worker/expbuild-worker-podman.toml

[executor]
type = "podman"

[executor.podman]
image = "docker.io/library/rust:1.75"
rootless = true
userns = "auto"  # Automatic user namespace mapping
network_mode = "none"

[executor.podman.default_limits]
cpu_cores = 2.0
memory_bytes = 2147483648
```

### 5.3 High-Performance Namespace Configuration (Linux)

```toml
# configs/worker/expbuild-worker-namespace.toml

[executor]
type = "namespace"

[executor.namespace]
use_pid_namespace = true
use_mount_namespace = true
use_network_namespace = true
use_uts_namespace = true
use_ipc_namespace = true
use_user_namespace = false  # May require kernel support
cgroup_parent = "/sys/fs/cgroup/expbuild"

[executor.namespace.default_limits]
cpu_cores = 2.0
memory_bytes = 2147483648
```

### 5.4 Development Environment Configuration (Host)

```toml
# configs/worker/expbuild-worker-dev.toml

[executor]
type = "host"

[executor.host]
env_whitelist = ["PATH", "HOME", "USER", "CARGO_HOME", "RUSTUP_HOME"]
cleanup_workspace = true
```

---

## VI. Security Hardening

### 6.1 Container Security Best Practices

#### 1. Principle of Least Privilege

```toml
[executor.docker]
# Read-only root filesystem
readonly_rootfs = true

# Disable privileged mode
privileged = false

# Prevent privilege escalation
security_opts = [
    "no-new-privileges",
    "apparmor=docker-default",
]
```

#### 2. Resource Isolation

```toml
[executor.docker.default_limits]
# CPU limit (prevent CPU occupation attacks)
cpu_cores = 2.0

# Memory limit (prevent OOM killer from affecting host)
memory_bytes = 2147483648  # 2GB

# PID limit (prevent fork bomb)
max_processes = 128
```

#### 3. Network Isolation

```toml
[executor.docker]
# Disable network by default
network_mode = "none"

# Or use restricted network
# network_mode = "bridge"
# network_whitelist = ["api.crates.io", "github.com"]
```

#### 4. Seccomp Filtering (System Call Whitelist)

```json
// configs/seccomp/default.json
{
  "defaultAction": "SCMP_ACT_ERRNO",
  "syscalls": [
    {
      "names": [
        "read", "write", "open", "close", "stat", "fstat",
        "mmap", "mprotect", "munmap", "brk",
        "rt_sigaction", "rt_sigprocmask", "ioctl",
        "execve", "exit", "exit_group"
      ],
      "action": "SCMP_ACT_ALLOW"
    }
  ]
}
```

```toml
[executor.docker]
security_opts = ["seccomp=/path/to/default.json"]
```

#### 5. User Namespaces (Podman)

```toml
[executor.podman]
rootless = true
userns = "auto"  # Container root mapped to host regular user
```

### 6.2 Audit Logging

```rust
// Log all executed commands
tracing::info!(
    target: "security_audit",
    worker_id = %self.worker_id,
    container_id = %container_id,
    command = ?request.command.arguments,
    user = %std::env::var("USER").unwrap_or_default(),
    "Task execution started"
);
```

### 6.3 Image Security

1. **Use Official Images**
   ```toml
   image = "rust:1.75-alpine"  # Official Rust image
   ```

2. **Image Scanning**
   ```bash
   # Use Trivy to scan for vulnerabilities
   trivy image rust:1.75-alpine
   ```

3. **Image Signature Verification**
   ```toml
   [executor.docker]
   verify_signature = true
   trusted_publishers = ["docker.io/library"]
   ```

---

## VII. Performance Analysis

### 7.1 Expected Performance Comparison

| Executor | Startup Time | Runtime Overhead | Memory Overhead | Isolation Strength | Use Case |
|--------|---------|---------|---------|---------|---------|
| **Host** | < 1ms | 0% | 0MB | ⭐☆☆☆☆ | Development/Testing |
| **Docker** | 50-200ms | 5-10% | 10-50MB | ⭐⭐⭐⭐☆ | **Production Recommended** |
| **Podman** | 50-150ms | 3-8% | 8-40MB | ⭐⭐⭐⭐☆ | Security-first |
| **Namespace** | 5-10ms | 1-3% | 1-5MB | ⭐⭐⭐☆☆ | High performance |
| **Firecracker** | 100-500ms | 2-5% | 30-100MB | ⭐⭐⭐⭐⭐ | Serverless |

### 7.2 Performance Optimization Strategies

#### 1. Image Caching

```rust
// Pre-pull common images
async fn warmup_images(&self) -> Result<()> {
    let images = vec![
        "rust:1.75-alpine",
        "rust:1.75-slim",
        "ubuntu:22.04",
    ];

    for image in images {
        Self::pull_image(&self.docker, image).await?;
    }
    Ok(())
}
```

#### 2. Container Pool Reuse

```rust
// Maintain a pool of warmed-up containers
pub struct ContainerPool {
    idle_containers: Vec<String>,
    max_pool_size: usize,
}

impl ContainerPool {
    async fn get_or_create(&mut self) -> Result<String> {
        if let Some(container_id) = self.idle_containers.pop() {
            // Reuse existing container
            Ok(container_id)
        } else {
            // Create new container
            self.create_container().await
        }
    }
}
```

#### 3. Work Directory Optimization

```rust
// Use tmpfs as work directory (in-memory filesystem)
[executor.docker]
mount_tmpfs_workspace = true  # Mount /workspace as tmpfs
tmpfs_size_mb = 1024          # 1GB
```

#### 4. Parallel Execution Optimization

```rust
// Limit concurrent container count
[worker]
max_concurrent_tasks = 4  # Adjust based on CPU cores
```

### 7.3 Benchmark Testing Plan

```rust
// crates/worker/benches/executor_bench.rs

#[tokio::test]
async fn bench_docker_cold_start() {
    // Test cold start time (requires pulling image)
}

#[tokio::test]
async fn bench_docker_warm_start() {
    // Test warm start time (image already cached)
}

#[tokio::test]
async fn bench_execution_overhead() {
    // Test overhead of executing the same task
    // Host vs Docker vs Namespace
}
```

---

## VIII. Implementation Plan

### Phase 0: Preparation (1 day)

- [x] Write design document
- [ ] Technical review
- [ ] Determine priorities

### Phase 1: Foundation Refactoring (3-5 days)

#### Task Checklist

- [ ] **Extract TaskExecutor trait**
  - Define unified interface
  - Add IsolationLevel, ResourceLimits types
  - Add ExecutorCapabilities

- [ ] **Refactor existing HostExecutor**
  - Implement new trait interface
  - Migrate existing functionality
  - Maintain backward compatibility

- [ ] **Update configuration system**
  - Add ExecutorConfig enum
  - Support multiple backend configurations
  - Configuration validation

- [ ] **Unit tests**
  - HostExecutor tests
  - Configuration loading tests

### Phase 2: Docker Implementation (5-7 days)

#### Task Checklist

- [ ] **Add dependencies**
  ```toml
  bollard = "0.16"        # Docker SDK
  scopeguard = "1.2"      # Resource cleanup
  ```

- [ ] **Implement DockerExecutor**
  - Basic execution logic
  - Image management (pull, cache)
  - Container lifecycle management
  - Log collection
  - Output file collection
  - Statistics collection

- [ ] **Security hardening**
  - Read-only root filesystem
  - Network isolation
  - Resource limits
  - Seccomp configuration

- [ ] **Error handling**
  - Timeout handling
  - Container cleanup
  - Exception recovery

- [ ] **Testing**
  - Unit tests
  - Integration tests
  - Error scenario tests

### Phase 3: Integration and Verification (3-5 days)

#### Task Checklist

- [ ] **Worker Agent integration**
  - Select executor based on configuration
  - Platform detection
  - Automatic fallback mechanism

- [ ] **End-to-end testing**
  - Complete execution flow tests
  - Multi-task concurrency tests
  - Resource limit verification

- [ ] **Performance testing**
  - Benchmarks
  - Cold start vs warm start
  - Concurrent performance

- [ ] **Documentation**
  - User guide
  - Configuration reference
  - Troubleshooting

### Phase 4: Advanced Features (Optional, 7-10 days)

#### Task Checklist

- [ ] **Podman support**
  - Implement PodmanExecutor
  - Rootless mode testing
  - User namespaces

- [ ] **Linux Namespace support**
  - Implement NamespaceExecutor
  - Cgroup integration
  - Performance optimization

- [ ] **Container pool reuse**
  - Design container pool
  - Lifecycle management
  - Performance testing

- [ ] **Monitoring integration**
  - Prometheus metrics
  - Resource usage statistics
  - Execution time tracking

### Milestones

| Milestone | Estimated Completion | Deliverables |
|--------|------------|-------|
| **M1: Foundation Refactoring** | Week 1 | TaskExecutor trait + Refactored HostExecutor |
| **M2: Docker MVP** | Week 2-3 | Basic working DockerExecutor + Tests |
| **M3: Production Ready** | Week 4 | Complete functionality + Documentation + Performance tests |
| **M4: Advanced Features** | Week 5-6 | Podman/Namespace + Container pool |

---

## IX. Risk Assessment

### 9.1 Technical Risks

| Risk | Probability | Impact | Mitigation |
|------|------|------|---------|
| **Docker daemon unavailable** | Medium | High | Auto-fallback to HostExecutor + Health checks |
| **Container startup failure** | Medium | High | Retry mechanism + Detailed logging + Degradation strategy |
| **Image pull timeout** | Medium | Medium | Pre-pull + Local cache + Timeout configuration |
| **Resource limits not effective** | Low | Medium | Integration test verification + Runtime monitoring |
| **Container leakage** | Low | High | scopeguard + auto_remove + Periodic cleanup |
| **Cross-platform compatibility** | Medium | Medium | Platform detection + Conditional compilation + Thorough testing |

### 9.2 Operational Risks

| Risk | Probability | Impact | Mitigation |
|------|------|------|---------|
| **Disk space exhaustion** | High | High | Image cleanup strategy + Disk monitoring + Quota limits |
| **Docker version incompatibility** | Low | Medium | Version detection + Compatibility testing + Documentation |
| **Permission issues** | Medium | Medium | Rootless Podman + User guide + Error messages |
| **Performance degradation** | Medium | Medium | Benchmarks + Performance monitoring + Optimization measures |

### 9.3 Security Risks

| Risk | Probability | Impact | Mitigation |
|------|------|------|---------|
| **Container escape** | Low | High | Latest Docker version + Seccomp + Read-only rootfs |
| **Resource DoS attack** | Medium | High | Strict resource limits + Timeout control + Monitoring alerts |
| **Malicious images** | Low | High | Image signature verification + Official images + Scanning tools |
| **Information disclosure** | Low | Medium | Network isolation + Environment variable filtering + Audit logs |

---

## X. Future Extensions

### 10.1 Short-term (3-6 months)

- **Windows Containers support**
  - Implement WindowsContainerExecutor
  - Support Windows Server

- **Image build integration**
  - Dockerfile support
  - Custom image management

- **Monitoring enhancements**
  - Prometheus metrics export
  - Grafana dashboards
  - Real-time resource tracking

### 10.2 Mid-term (6-12 months)

- **Firecracker support**
  - microVM isolation
  - Faster startup time
  - Stronger isolation

- **Kubernetes integration**
  - Run as K8s Job
  - Pod auto-scaling
  - Resource scheduling

- **Distributed caching**
  - Distributed image caching
  - Build cache sharing

### 10.3 Long-term (12+ months)

- **gVisor support**
  - Kernel-level isolation
  - Higher security

- **GPU support**
  - NVIDIA/AMD GPU isolation
  - Machine learning workloads

- **Multi-tenancy enhancements**
  - Tenant-level quotas
  - Cost billing
  - Audit trails

---

## Appendix

### A. Reference Resources

#### Official Documentation
- [Docker Engine API](https://docs.docker.com/engine/api/)
- [Podman API](https://docs.podman.io/en/latest/)
- [Linux Namespaces](https://man7.org/linux/man-pages/man7/namespaces.7.html)
- [Cgroups](https://man7.org/linux/man-pages/man7/cgroups.7.html)

#### Rust Crates
- [bollard](https://docs.rs/bollard/) - Docker API client
- [nix](https://docs.rs/nix/) - Unix system call wrappers
- [scopeguard](https://docs.rs/scopeguard/) - RAII guard

#### Security References
- [Docker Security Best Practices](https://cheatsheetseries.owasp.org/cheatsheets/Docker_Security_Cheat_Sheet.html)
- [CIS Docker Benchmark](https://www.cisecurity.org/benchmark/docker)
- [Seccomp Profiles](https://github.com/moby/moby/blob/master/profiles/seccomp/default.json)

### B. Glossary

| Term | Definition |
|------|------|
| **Namespace** | Linux kernel isolation mechanism that isolates processes, network, filesystem, etc. |
| **Cgroup** | Linux control group for resource limiting and statistics |
| **Rootless** | Running containers without root permissions |
| **Seccomp** | Secure computing mode that restricts system calls |
| **OCI** | Open Container Initiative, container standard |
| **CAS** | Content Addressable Storage |

### C. Change History

| Version | Date | Author | Changes |
|------|------|------|---------|
| 0.1 | 2025-12-04 | Claude Code | Initial version |

---

**Document Status**: 📝 Pending Review

Please provide feedback after review:
1. Is the technical solution reasonable?
2. Are the priorities appropriate?
3. Does the implementation plan need adjustment?
4. Are there any missing risk points?
