# Worker 环境隔离方案设计

> **文档状态**: 设计阶段 - 待审核  
> **创建日期**: 2025-12-04  
> **作者**: Claude Code  

---

## 目录

- [一、背景与目标](#一背景与目标)
- [二、技术调研](#二技术调研)
- [三、方案设计](#三方案设计)
- [四、详细实现](#四详细实现)
- [五、配置示例](#五配置示例)
- [六、安全加固](#六安全加固)
- [七、性能分析](#七性能分析)
- [八、实施计划](#八实施计划)
- [九、风险评估](#九风险评估)

---

## 一、背景与目标

### 1.1 当前问题

现有 Worker 实现（`HostExecutor`）直接在主机上执行构建任务，存在以下问题：

1. **安全风险**: 恶意代码可以访问主机文件系统、网络、进程
2. **资源争抢**: 无法限制单个任务的 CPU/内存/磁盘使用
3. **环境污染**: 任务间可能相互干扰（文件残留、端口占用等）
4. **不确定性**: 构建结果依赖主机环境，难以复现

### 1.2 设计目标

1. **安全隔离**: 任务无法访问主机敏感资源
2. **资源控制**: 可配置的 CPU/内存/磁盘配额
3. **环境一致**: 可重复的构建环境（通过容器镜像）
4. **高性能**: 隔离开销 < 10%
5. **可扩展**: 支持多种隔离后端（Docker、Podman、VM 等）
6. **跨平台**: Linux/macOS/Windows 都有可用方案

---

## 二、技术调研

### 2.1 Linux 平台

| 技术 | 隔离能力 | 性能开销 | 成熟度 | 易用性 | 适用场景 |
|------|---------|---------|--------|--------|---------|
| **Docker/Containerd** | ⭐⭐⭐⭐⭐ | 中 (5-10%) | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | **推荐生产环境** |
| **Podman** | ⭐⭐⭐⭐⭐ | 低 (3-8%) | ⭐⭐⭐⭐☆ | ⭐⭐⭐⭐☆ | Rootless 安全场景 |
| **systemd-nspawn** | ⭐⭐⭐⭐☆ | 低 (2-5%) | ⭐⭐⭐⭐☆ | ⭐⭐⭐☆☆ | 轻量级容器 |
| **Linux Namespaces + cgroups** | ⭐⭐⭐⭐☆ | 极低 (1-3%) | ⭐⭐⭐☆☆ | ⭐⭐☆☆☆ | 自定义高性能方案 |
| **Firecracker** | ⭐⭐⭐⭐⭐ | 中 (5-10%) | ⭐⭐⭐⭐☆ | ⭐⭐☆☆☆ | microVM (AWS Lambda) |
| **gVisor (runsc)** | ⭐⭐⭐⭐⭐ | 高 (15-30%) | ⭐⭐⭐⭐☆ | ⭐⭐⭐☆☆ | 内核级隔离 (Google) |

**推荐**: Docker (生产) + Namespace (高性能可选)

### 2.2 macOS 平台

| 技术 | 隔离能力 | 性能开销 | 成熟度 | 易用性 | 适用场景 |
|------|---------|---------|--------|--------|---------|
| **Docker Desktop** | ⭐⭐⭐⭐☆ | 高 (VM 层) | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | **开发环境推荐** |
| **Podman Machine** | ⭐⭐⭐⭐☆ | 高 (VM 层) | ⭐⭐⭐☆☆ | ⭐⭐⭐☆☆ | Docker 替代 |
| **Lima** | ⭐⭐⭐⭐☆ | 高 (VM 层) | ⭐⭐⭐☆☆ | ⭐⭐⭐⭐☆ | 轻量级 Linux VM |
| **macOS Sandbox API** | ⭐⭐⭐☆☆ | 低 | ⭐⭐⭐☆☆ | ⭐⭐☆☆☆ | 原生沙箱 (受限) |

**限制**: macOS 缺乏原生容器支持，所有方案依赖 Linux VM

### 2.3 Windows 平台

| 技术 | 隔离能力 | 性能开销 | 成熟度 | 易用性 | 适用场景 |
|------|---------|---------|--------|--------|---------|
| **Docker Desktop** | ⭐⭐⭐⭐☆ | 高 (WSL2) | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | **开发环境推荐** |
| **Windows Containers** | ⭐⭐⭐⭐⭐ | 中 | ⭐⭐⭐⭐☆ | ⭐⭐⭐☆☆ | Windows 原生容器 |
| **WSL2** | ⭐⭐⭐⭐☆ | 中 | ⭐⭐⭐⭐☆ | ⭐⭐⭐⭐☆ | Linux 兼容层 |
| **Windows Sandbox** | ⭐⭐⭐⭐☆ | 高 | ⭐⭐⭐⭐☆ | ⭐⭐⭐⭐☆ | 一次性轻量 VM |
| **AppContainer** | ⭐⭐⭐☆☆ | 低 | ⭐⭐⭐☆☆ | ⭐⭐☆☆☆ | UWP 应用沙箱 |

**推荐**: Docker Desktop (WSL2) 或 Windows Containers

### 2.4 技术选型结论

| 优先级 | 方案 | 理由 |
|-------|------|------|
| **P0** | Docker | 跨平台、成熟、生态完善、易用性最佳 |
| **P1** | Podman | Linux 上的 rootless 替代方案 |
| **P2** | Linux Namespaces | 性能敏感场景的原生实现 |
| **P3** | Firecracker | Serverless/多租户场景 |

---

## 三、方案设计

### 3.1 架构概览

```
┌─────────────────────────────────────────────────────┐
│              Worker Agent                           │
│  ┌───────────────────────────────────────────────┐ │
│  │         TaskExecutor Trait (统一接口)          │ │
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

### 3.2 核心接口设计

```rust
// crates/worker/src/executor/mod.rs

use anyhow::Result;
use async_trait::async_trait;
use std::time::Duration;
use std::path::PathBuf;

/// 统一的任务执行器接口
#[async_trait]
pub trait TaskExecutor: Send + Sync {
    /// 执行任务
    async fn execute(&self, request: ExecutionRequest) -> Result<ExecutionResult>;
    
    /// 获取隔离级别
    fn isolation_level(&self) -> IsolationLevel;
    
    /// 健康检查（检查 Docker daemon 等）
    async fn health_check(&self) -> Result<()>;
    
    /// 预热（拉取镜像、创建容器池等）
    async fn warmup(&self) -> Result<()>;
    
    /// 获取能力信息
    fn capabilities(&self) -> ExecutorCapabilities;
}

/// 隔离级别
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum IsolationLevel {
    None,           // 直接在主机执行
    ProcessOnly,    // 仅进程级隔离
    Filesystem,     // 文件系统隔离 (chroot)
    Container,      // 完整容器隔离 (namespace + cgroup)
    VM,             // 虚拟机级隔离
}

/// 执行器能力
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

/// 执行请求
pub struct ExecutionRequest {
    pub command: Command,
    pub work_dir: PathBuf,
    pub resource_limits: ResourceLimits,
    pub timeout: Duration,
}

/// 资源限制
#[derive(Debug, Clone)]
pub struct ResourceLimits {
    pub cpu_cores: Option<f64>,        // 如 0.5 = 50% 单核
    pub memory_bytes: Option<u64>,     // 内存上限（字节）
    pub disk_bytes: Option<u64>,       // 磁盘配额（字节）
    pub network: NetworkPolicy,        // 网络策略
    pub max_processes: Option<u32>,    // 最大进程数（防 fork bomb）
}

/// 网络策略
#[derive(Debug, Clone)]
pub enum NetworkPolicy {
    None,                              // 无网络访问
    Localhost,                         // 仅本地回环
    Restricted(Vec<String>),           // IP/域名白名单
    Full,                              // 完全访问
}

/// 执行结果
pub struct ExecutionResult {
    pub exit_code: i32,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub output_files: Vec<OutputFile>,
    pub stats: ExecutionStats,
}

/// 执行统计
#[derive(Debug, Clone, Default)]
pub struct ExecutionStats {
    pub duration: Duration,
    pub cpu_time_us: u64,              // CPU 时间（微秒）
    pub peak_memory_bytes: u64,        // 内存峰值
    pub disk_read_bytes: u64,
    pub disk_write_bytes: u64,
}
```

### 3.3 配置驱动设计

```rust
// crates/worker/src/config.rs

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct WorkerConfig {
    // ... 现有字段 ...
    
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

## 四、详细实现

### 4.1 Docker Executor (优先级 P0)

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
    /// 容器镜像 (如 "rust:1.75-alpine")
    pub image: String,
    
    /// 每次执行前是否拉取最新镜像
    #[serde(default)]
    pub always_pull: bool,
    
    /// 网络模式: "none", "bridge", "host"
    #[serde(default = "default_network_mode")]
    pub network_mode: String,
    
    /// 只读根文件系统
    #[serde(default = "default_true")]
    pub readonly_rootfs: bool,
    
    /// 在 /tmp 挂载 tmpfs
    #[serde(default = "default_true")]
    pub mount_tmpfs: bool,
    
    /// 安全选项
    #[serde(default = "default_security_opts")]
    pub security_opts: Vec<String>,
    
    /// 默认资源限制
    #[serde(default)]
    pub default_limits: ResourceLimits,
    
    /// Docker socket 路径 (留空使用默认)
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
        // 连接 Docker daemon
        let docker = if let Some(socket) = &config.socket_path {
            Docker::connect_with_socket(socket, 120, bollard::API_DEFAULT_VERSION)?
        } else {
            Docker::connect_with_local_defaults()?
        };
        
        // 验证连接
        docker.ping().await.context("Failed to connect to Docker daemon")?;
        
        // 预拉取镜像
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
        
        // 合并默认限制和请求限制
        let limits = self.merge_limits(&request.resource_limits);
        
        Ok(Config {
            image: Some(self.config.image.clone()),
            cmd: Some(request.command.arguments.clone()),
            working_dir: Some("/workspace".to_string()),
            env: Some(self.build_env_vars(&request.command)),
            host_config: Some(HostConfig {
                // 挂载工作目录（只读输入 + 可写输出）
                binds: Some(vec![
                    format!("{}:/workspace", work_dir_str),
                ]),
                
                // CPU 限制 (nano CPUs: 1 core = 1e9)
                nano_cpus: limits.cpu_cores
                    .map(|c| (c * 1_000_000_000.0) as i64),
                
                // 内存限制
                memory: limits.memory_bytes.map(|m| m as i64),
                
                // 内存 + Swap 限制（避免使用 swap）
                memory_swap: limits.memory_bytes.map(|m| m as i64),
                
                // 网络模式
                network_mode: Some(self.config.network_mode.clone()),
                
                // 只读根文件系统
                read_only_rootfs: Some(self.config.readonly_rootfs),
                
                // tmpfs 挂载（可写临时目录）
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
                
                // 安全选项
                security_opt: Some(self.config.security_opts.clone()),
                
                // PID 限制（防 fork bomb）
                pids_limit: limits.max_processes.map(|p| p as i64),
                
                // 禁用特权模式
                privileged: Some(false),
                
                // 自动删除容器
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
        
        // 1. 创建容器
        let config = self.build_container_config(&request)?;
        let container = self.docker
            .create_container::<String, String>(None, config)
            .await?;
        
        let container_id = &container.id;
        tracing::info!("Created container: {}", container_id);
        
        // 2. 确保容器清理（即使发生 panic）
        let docker_clone = self.docker.clone();
        let container_id_clone = container_id.clone();
        let _cleanup_guard = scopeguard::guard((), move |_| {
            tokio::spawn(async move {
                let _ = docker_clone.remove_container(
                    &container_id_clone,
                    Some(RemoveContainerOptions {
                        force: true,
                        v: true,  // 删除 volumes
                        ..Default::default()
                    })
                ).await;
            });
        });
        
        // 3. 启动容器
        self.docker.start_container::<String>(container_id, None).await?;
        tracing::info!("Started container: {}", container_id);
        
        // 4. 等待完成（带超时）
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
        
        // 5. 处理超时
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
        
        // 6. 获取日志
        let logs = self.get_container_logs(container_id).await?;
        
        // 7. 收集输出文件
        let output_files = self.collect_outputs(
            container_id,
            &request.command.output_paths
        ).await?;
        
        // 8. 获取统计信息
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
        
        // 检查镜像是否存在
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
            supports_disk_limit: false,  // Docker 需要额外配置
            supports_network_isolation: true,
            supports_readonly_rootfs: true,
            platform: std::env::consts::OS.to_string(),
        }
    }
}
```

### 4.2 Podman Executor (优先级 P1)

```rust
// crates/worker/src/executor/podman.rs

/// Podman 执行器（Rootless 容器）
/// 
/// 优势：
/// - Daemonless: 不需要常驻守护进程
/// - Rootless: 不需要 root 权限
/// - 兼容 Docker API
/// - 更好的安全性（用户命名空间）
pub struct PodmanExecutor {
    client: PodmanClient,
    config: PodmanExecutorConfig,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct PodmanExecutorConfig {
    pub image: String,
    
    /// Rootless 模式
    #[serde(default = "default_true")]
    pub rootless: bool,
    
    /// 用户命名空间模式: "auto", "keep-id", "nomap"
    #[serde(default = "default_userns")]
    pub userns: String,
    
    /// Podman socket 路径（rootless 默认 /run/user/{uid}/podman/podman.sock）
    pub socket_path: Option<String>,
    
    // ... 其他配置同 Docker
}

fn default_userns() -> String {
    "auto".to_string()
}

impl PodmanExecutor {
    pub async fn new(config: PodmanExecutorConfig) -> Result<Self> {
        let socket_path = if let Some(path) = &config.socket_path {
            path.clone()
        } else if config.rootless {
            // Rootless socket 路径
            format!(
                "/run/user/{}/podman/podman.sock",
                nix::unistd::getuid()
            )
        } else {
            // Root socket 路径
            "/run/podman/podman.sock".to_string()
        };
        
        let client = PodmanClient::connect(&socket_path).await?;
        
        Ok(Self { client, config })
    }
}

// 实现 TaskExecutor trait（与 Docker 类似）
```

### 4.3 Linux Namespace Executor (优先级 P2)

```rust
// crates/worker/src/executor/namespace.rs

#[cfg(target_os = "linux")]
pub struct NamespaceExecutor {
    config: NamespaceExecutorConfig,
}

#[cfg(target_os = "linux")]
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct NamespaceExecutorConfig {
    /// 使用 PID namespace
    #[serde(default = "default_true")]
    pub use_pid_namespace: bool,
    
    /// 使用 Mount namespace
    #[serde(default = "default_true")]
    pub use_mount_namespace: bool,
    
    /// 使用 Network namespace
    #[serde(default = "default_true")]
    pub use_network_namespace: bool,
    
    /// 使用 UTS namespace (hostname)
    #[serde(default)]
    pub use_uts_namespace: bool,
    
    /// 使用 IPC namespace
    #[serde(default)]
    pub use_ipc_namespace: bool,
    
    /// 使用 User namespace (需要 unprivileged user namespaces)
    #[serde(default)]
    pub use_user_namespace: bool,
    
    /// Cgroup 父路径
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
        
        // 构建 clone flags
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
        
        // Fork 进程
        match unsafe { nix::unistd::fork()? } {
            ForkResult::Parent { child } => {
                // 父进程：设置 cgroup 并等待
                if let Some(cgroup_parent) = &self.config.cgroup_parent {
                    self.setup_cgroup(child, cgroup_parent, &request.resource_limits)?;
                }
                
                self.wait_child(child, request.timeout).await
            }
            ForkResult::Child => {
                // 子进程：设置 namespace 并执行
                
                // 1. Unshare namespaces
                unshare(flags)?;
                
                // 2. chroot 到工作目录
                if self.config.use_mount_namespace {
                    chroot(&request.work_dir)?;
                    chdir("/")?;
                }
                
                // 3. 执行命令
                use std::os::unix::process::CommandExt;
                let err = std::process::Command::new(&request.command.arguments[0])
                    .args(&request.command.arguments[1..])
                    .envs(self.build_env_vars(&request.command))
                    .exec();
                
                // exec 失败才会到这里
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
        
        // CPU 限制
        if let Some(cpu_cores) = limits.cpu_cores {
            let quota = (cpu_cores * 100_000.0) as i64;
            let mut file = fs::File::create(format!("{}/cpu.max", cgroup_path))?;
            writeln!(file, "{} 100000", quota)?;
        }
        
        // 内存限制
        if let Some(memory_bytes) = limits.memory_bytes {
            let mut file = fs::File::create(format!("{}/memory.max", cgroup_path))?;
            writeln!(file, "{}", memory_bytes)?;
        }
        
        // 将进程加入 cgroup
        let mut file = fs::File::create(format!("{}/cgroup.procs", cgroup_path))?;
        writeln!(file, "{}", pid)?;
        
        Ok(())
    }
}
```

---

## 五、配置示例

### 5.1 Docker 配置（推荐生产）

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

### 5.2 Podman Rootless 配置

```toml
# configs/worker/expbuild-worker-podman.toml

[executor]
type = "podman"

[executor.podman]
image = "docker.io/library/rust:1.75"
rootless = true
userns = "auto"  # 自动用户命名空间映射
network_mode = "none"

[executor.podman.default_limits]
cpu_cores = 2.0
memory_bytes = 2147483648
```

### 5.3 高性能 Namespace 配置（Linux）

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
use_user_namespace = false  # 可能需要内核支持
cgroup_parent = "/sys/fs/cgroup/expbuild"

[executor.namespace.default_limits]
cpu_cores = 2.0
memory_bytes = 2147483648
```

### 5.4 开发环境配置（Host）

```toml
# configs/worker/expbuild-worker-dev.toml

[executor]
type = "host"

[executor.host]
env_whitelist = ["PATH", "HOME", "USER", "CARGO_HOME", "RUSTUP_HOME"]
cleanup_workspace = true
```

---

## 六、安全加固

### 6.1 容器安全最佳实践

#### 1. 最小权限原则

```toml
[executor.docker]
# 只读根文件系统
readonly_rootfs = true

# 禁用特权模式
privileged = false

# 阻止权限提升
security_opts = [
    "no-new-privileges",
    "apparmor=docker-default",
]
```

#### 2. 资源隔离

```toml
[executor.docker.default_limits]
# CPU 限制（防止 CPU 占用攻击）
cpu_cores = 2.0

# 内存限制（防止 OOM killer 影响主机）
memory_bytes = 2147483648  # 2GB

# PID 限制（防止 fork bomb）
max_processes = 128
```

#### 3. 网络隔离

```toml
[executor.docker]
# 默认禁用网络
network_mode = "none"

# 或使用受限网络
# network_mode = "bridge"
# network_whitelist = ["api.crates.io", "github.com"]
```

#### 4. Seccomp 过滤（系统调用白名单）

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

#### 5. 用户命名空间（Podman）

```toml
[executor.podman]
rootless = true
userns = "auto"  # 容器内 root 映射为主机普通用户
```

### 6.2 审计日志

```rust
// 记录所有执行的命令
tracing::info!(
    target: "security_audit",
    worker_id = %self.worker_id,
    container_id = %container_id,
    command = ?request.command.arguments,
    user = %std::env::var("USER").unwrap_or_default(),
    "Task execution started"
);
```

### 6.3 镜像安全

1. **使用官方镜像**
   ```toml
   image = "rust:1.75-alpine"  # 官方 Rust 镜像
   ```

2. **镜像扫描**
   ```bash
   # 使用 Trivy 扫描漏洞
   trivy image rust:1.75-alpine
   ```

3. **镜像签名验证**
   ```toml
   [executor.docker]
   verify_signature = true
   trusted_publishers = ["docker.io/library"]
   ```

---

## 七、性能分析

### 7.1 预期性能对比

| 执行器 | 启动时间 | 运行开销 | 内存开销 | 隔离强度 | 适用场景 |
|--------|---------|---------|---------|---------|---------|
| **Host** | < 1ms | 0% | 0MB | ⭐☆☆☆☆ | 开发/测试 |
| **Docker** | 50-200ms | 5-10% | 10-50MB | ⭐⭐⭐⭐☆ | **生产推荐** |
| **Podman** | 50-150ms | 3-8% | 8-40MB | ⭐⭐⭐⭐☆ | 安全优先 |
| **Namespace** | 5-10ms | 1-3% | 1-5MB | ⭐⭐⭐☆☆ | 高性能 |
| **Firecracker** | 100-500ms | 2-5% | 30-100MB | ⭐⭐⭐⭐⭐ | Serverless |

### 7.2 性能优化策略

#### 1. 镜像缓存

```rust
// 预拉取常用镜像
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

#### 2. 容器池复用

```rust
// 维护预热的容器池
pub struct ContainerPool {
    idle_containers: Vec<String>,
    max_pool_size: usize,
}

impl ContainerPool {
    async fn get_or_create(&mut self) -> Result<String> {
        if let Some(container_id) = self.idle_containers.pop() {
            // 重用现有容器
            Ok(container_id)
        } else {
            // 创建新容器
            self.create_container().await
        }
    }
}
```

#### 3. 工作目录优化

```rust
// 使用 tmpfs 作为工作目录（内存文件系统）
[executor.docker]
mount_tmpfs_workspace = true  # /workspace 挂载为 tmpfs
tmpfs_size_mb = 1024          # 1GB
```

#### 4. 并行执行优化

```rust
// 限制并发容器数量
[worker]
max_concurrent_tasks = 4  # 根据 CPU 核心数调整
```

### 7.3 基准测试计划

```rust
// crates/worker/benches/executor_bench.rs

#[tokio::test]
async fn bench_docker_cold_start() {
    // 测试冷启动时间（需要拉取镜像）
}

#[tokio::test]
async fn bench_docker_warm_start() {
    // 测试热启动时间（镜像已缓存）
}

#[tokio::test]
async fn bench_execution_overhead() {
    // 测试执行相同任务的开销
    // Host vs Docker vs Namespace
}
```

---

## 八、实施计划

### Phase 0: 准备阶段（1 天）

- [x] 编写设计文档
- [ ] 技术评审
- [ ] 确定优先级

### Phase 1: 基础重构（3-5 天）

#### 任务清单

- [ ] **提取 TaskExecutor trait**
  - 定义统一接口
  - 添加 IsolationLevel、ResourceLimits 类型
  - 添加 ExecutorCapabilities

- [ ] **重构现有 HostExecutor**
  - 实现新的 trait 接口
  - 迁移现有功能
  - 保持向后兼容

- [ ] **更新配置系统**
  - 添加 ExecutorConfig enum
  - 支持多种后端配置
  - 配置验证

- [ ] **单元测试**
  - HostExecutor 测试
  - 配置加载测试

### Phase 2: Docker 实现（5-7 天）

#### 任务清单

- [ ] **添加依赖**
  ```toml
  bollard = "0.16"        # Docker SDK
  scopeguard = "1.2"      # 资源清理
  ```

- [ ] **实现 DockerExecutor**
  - 基础执行逻辑
  - 镜像管理（拉取、缓存）
  - 容器生命周期管理
  - 日志收集
  - 输出文件收集
  - 统计信息收集

- [ ] **安全加固**
  - 只读根文件系统
  - 网络隔离
  - 资源限制
  - Seccomp 配置

- [ ] **错误处理**
  - 超时处理
  - 容器清理
  - 异常恢复

- [ ] **测试**
  - 单元测试
  - 集成测试
  - 错误场景测试

### Phase 3: 集成与验证（3-5 天）

#### 任务清单

- [ ] **Worker Agent 集成**
  - 根据配置选择执行器
  - 平台检测
  - 自动回退机制

- [ ] **端到端测试**
  - 完整执行流程测试
  - 多任务并发测试
  - 资源限制验证

- [ ] **性能测试**
  - 基准测试
  - 冷启动 vs 热启动
  - 并发性能

- [ ] **文档**
  - 用户指南
  - 配置参考
  - 故障排查

### Phase 4: 高级特性（可选，7-10 天）

#### 任务清单

- [ ] **Podman 支持**
  - 实现 PodmanExecutor
  - Rootless 模式测试
  - 用户命名空间

- [ ] **Linux Namespace 支持**
  - 实现 NamespaceExecutor
  - Cgroup 集成
  - 性能优化

- [ ] **容器池复用**
  - 设计容器池
  - 生命周期管理
  - 性能测试

- [ ] **监控集成**
  - Prometheus 指标
  - 资源使用统计
  - 执行时间追踪

### 里程碑

| 里程碑 | 预计完成时间 | 交付物 |
|--------|------------|-------|
| **M1: 基础重构** | Week 1 | TaskExecutor trait + 重构 HostExecutor |
| **M2: Docker MVP** | Week 2-3 | 基本可用的 DockerExecutor + 测试 |
| **M3: 生产就绪** | Week 4 | 完整功能 + 文档 + 性能测试 |
| **M4: 高级特性** | Week 5-6 | Podman/Namespace + 容器池 |

---

## 九、风险评估

### 9.1 技术风险

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|---------|
| **Docker daemon 不可用** | 中 | 高 | 自动回退到 HostExecutor + 健康检查 |
| **容器启动失败** | 中 | 高 | 重试机制 + 详细日志 + 降级策略 |
| **镜像拉取超时** | 中 | 中 | 预拉取 + 本地缓存 + 超时配置 |
| **资源限制不生效** | 低 | 中 | 集成测试验证 + 运行时监控 |
| **容器泄漏** | 低 | 高 | scopeguard + auto_remove + 定期清理 |
| **跨平台兼容性** | 中 | 中 | 平台检测 + 条件编译 + 充分测试 |

### 9.2 运维风险

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|---------|
| **磁盘空间耗尽** | 高 | 高 | 镜像清理策略 + 磁盘监控 + 配额限制 |
| **Docker 版本不兼容** | 低 | 中 | 版本检测 + 兼容性测试 + 文档说明 |
| **权限问题** | 中 | 中 | Rootless Podman + 用户指南 + 错误提示 |
| **性能下降** | 中 | 中 | 基准测试 + 性能监控 + 优化措施 |

### 9.3 安全风险

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|---------|
| **容器逃逸** | 低 | 高 | 最新版本 Docker + Seccomp + 只读 rootfs |
| **资源 DoS 攻击** | 中 | 高 | 严格资源限制 + 超时控制 + 监控告警 |
| **恶意镜像** | 低 | 高 | 镜像签名验证 + 官方镜像 + 扫描工具 |
| **信息泄露** | 低 | 中 | 网络隔离 + 环境变量过滤 + 审计日志 |

---

## 十、未来扩展

### 10.1 短期（3-6 个月）

- **Windows Containers 支持**
  - 实现 WindowsContainerExecutor
  - 支持 Windows Server

- **镜像构建集成**
  - Dockerfile 支持
  - 自定义镜像管理

- **监控增强**
  - Prometheus 指标导出
  - Grafana 仪表板
  - 实时资源追踪

### 10.2 中期（6-12 个月）

- **Firecracker 支持**
  - microVM 隔离
  - 更快的启动时间
  - 更强的隔离

- **Kubernetes 集成**
  - 作为 K8s Job 运行
  - Pod 自动伸缩
  - 资源调度

- **分布式缓存**
  - 镜像分布式缓存
  - 构建缓存共享

### 10.3 长期（12+ 个月）

- **gVisor 支持**
  - 内核级隔离
  - 更高的安全性

- **GPU 支持**
  - NVIDIA/AMD GPU 隔离
  - 机器学习工作负载

- **多租户增强**
  - 租户级配额
  - 成本计费
  - 审计追踪

---

## 附录

### A. 参考资源

#### 官方文档
- [Docker Engine API](https://docs.docker.com/engine/api/)
- [Podman API](https://docs.podman.io/en/latest/)
- [Linux Namespaces](https://man7.org/linux/man-pages/man7/namespaces.7.html)
- [Cgroups](https://man7.org/linux/man-pages/man7/cgroups.7.html)

#### Rust Crates
- [bollard](https://docs.rs/bollard/) - Docker API 客户端
- [nix](https://docs.rs/nix/) - Unix 系统调用封装
- [scopeguard](https://docs.rs/scopeguard/) - RAII 守卫

#### 安全参考
- [Docker Security Best Practices](https://cheatsheetseries.owasp.org/cheatsheets/Docker_Security_Cheat_Sheet.html)
- [CIS Docker Benchmark](https://www.cisecurity.org/benchmark/docker)
- [Seccomp Profiles](https://github.com/moby/moby/blob/master/profiles/seccomp/default.json)

### B. 术语表

| 术语 | 定义 |
|------|------|
| **Namespace** | Linux 内核隔离机制，隔离进程、网络、文件系统等 |
| **Cgroup** | Linux 控制组，用于资源限制和统计 |
| **Rootless** | 无需 root 权限运行容器 |
| **Seccomp** | 安全计算模式，限制系统调用 |
| **OCI** | Open Container Initiative，容器标准 |
| **CAS** | Content Addressable Storage，内容寻址存储 |

### C. 变更历史

| 版本 | 日期 | 作者 | 变更说明 |
|------|------|------|---------|
| 0.1 | 2025-12-04 | Claude Code | 初始版本 |

---

**文档状态**: 📝 待审核

请审核后反馈：
1. 技术方案是否合理？
2. 优先级是否合适？
3. 是否需要调整实施计划？
4. 是否有遗漏的风险点？
