# Worker Framework 使用指南

## 概述

Worker Framework 为 ExpBuild Remote Execution 服务器提供灵活的任务执行能力，支持多种执行后端。

## 支持的 Worker 类型

### 1. Host Worker
在本地主机上以进程方式执行任务。

**特性：**
- 直接在主机上执行
- 可配置环境变量白名单
- 支持用户/组切换
- 最快的启动时间

**配置示例：**
```toml
[[execution.pool.workers]]
type = "host"
count = 4
work_dir = "/tmp/expbuild-workers/host"
use_chroot = false
env_whitelist = ["PATH", "HOME", "USER", "TMPDIR"]
run_as_user = "nobody"
run_as_group = "nogroup"
```

**参数说明：**
- `count` - Worker 数量
- `work_dir` - 工作目录
- `use_chroot` - 是否使用 chroot 隔离（未实现）
- `env_whitelist` - 允许传递的环境变量
- `run_as_user` - 执行用户（可选）
- `run_as_group` - 执行组（可选）

### 2. Docker Worker
在 Docker 容器中执行任务。

**特性：**
- 完整的容器隔离
- CPU/内存资源限制
- 网络隔离
- 卷挂载支持

**配置示例：**
```toml
[[execution.pool.workers]]
type = "docker"
count = 2
image = "ubuntu:22.04"
always_pull = false
cpu_limit = 2.0
memory_limit = 4294967296  # 4GB
network_mode = "none"
user = "1000:1000"

[[execution.pool.workers.volumes]]
host_path = "/var/cache/build"
container_path = "/cache"
read_only = true
```

**参数说明：**
- `count` - Worker 数量
- `image` - Docker 镜像
- `always_pull` - 每次执行前是否拉取镜像
- `cpu_limit` - CPU 核数限制
- `memory_limit` - 内存限制（字节）
- `network_mode` - 网络模式（none/bridge/host）
- `user` - 容器内运行用户
- `volumes` - 卷挂载配置

## Worker Pool 配置

```toml
[execution]
backend = "pool"

[execution.pool]
max_queue_size = 1000
scheduler_interval_ms = 100
default_task_timeout_seconds = 3600
result_ttl_seconds = 300
```

**参数说明：**
- `max_queue_size` - 最大队列长度
- `scheduler_interval_ms` - 调度器轮询间隔（毫秒）
- `default_task_timeout_seconds` - 默认任务超时
- `result_ttl_seconds` - 结果保留时间

## 完整配置示例

### 混合 Worker 配置

```toml
[server]
address = "0.0.0.0:8980"
instance_name = "production"

[storage.cas]
backend = "filesystem"
root_dir = "/var/lib/expbuild/cas"

[storage.action_cache]
backend = "filesystem"
root_dir = "/var/lib/expbuild/cache"

[execution]
backend = "pool"

[execution.pool]
max_queue_size = 1000
scheduler_interval_ms = 100
default_task_timeout_seconds = 3600
result_ttl_seconds = 300

# 快速 Host Workers 用于小任务
[[execution.pool.workers]]
type = "host"
count = 4
work_dir = "/tmp/expbuild-host-workers"
use_chroot = false
env_whitelist = ["PATH", "HOME", "USER"]

# Docker Workers 用于需要特定环境的任务
[[execution.pool.workers]]
type = "docker"
count = 2
image = "myorg/build-env:latest"
always_pull = false
cpu_limit = 4.0
memory_limit = 8589934592  # 8GB
network_mode = "none"

[[execution.pool.workers.volumes]]
host_path = "/var/cache/build"
container_path = "/cache"
read_only = false

[capabilities]
digest_functions = ["SHA256"]
max_batch_total_size_bytes = 4194304
supported_compressors = ["ZSTD", "DEFLATE"]
exec_enabled = true
action_cache_update_enabled = true
```

## 平台匹配

Worker Pool 会根据 Action 的 Platform 属性自动选择合适的 Worker。

### Platform 属性

Action 可以指定平台要求：

```protobuf
Platform {
  properties: [
    { name: "OSFamily", value: "Linux" },
    { name: "container", value: "docker" }
  ]
}
```

Worker 会声明自己的能力：
- **Host Worker**: OSFamily=当前操作系统, Arch=当前架构
- **Docker Worker**: OSFamily=Linux, container=docker

调度器会自动匹配：
- 如果 Action 没有指定 Platform，可以调度到任何 Worker
- 如果指定了 Platform，只会调度到匹配的 Worker

## 运行服务器

```bash
# 使用 worker pool 配置启动
./target/release/re-server --config expbuild-server-pool.toml --verbose

# 输出示例：
# 2025-11-30T12:00:00Z INFO re_server_bin: Loading configuration from: expbuild-server-pool.toml
# 2025-11-30T12:00:00Z INFO re_server_bin: Initializing storage...
# 2025-11-30T12:00:00Z INFO re_server_bin: Initializing worker pool...
# 2025-11-30T12:00:00Z INFO re_server::execution::pool_factory: Creating 2 host workers
# 2025-11-30T12:00:00Z INFO re_server::execution::pool_factory: Registered host worker: host-worker-1
# 2025-11-30T12:00:00Z INFO re_server::execution::pool_factory: Registered host worker: host-worker-2
# 2025-11-30T12:00:00Z INFO re_server::execution::pool_factory: Worker pool started with 2 workers
# 2025-11-30T12:00:00Z INFO re_server_bin: Starting server on 127.0.0.1:8980
```

## 监控

### Worker Pool 统计

通过日志可以观察 Worker Pool 状态：
- 队列中的任务数量
- 空闲/忙碌的 Worker 数量
- 已完成/失败的任务数

### 健康检查

每个 Worker 都实现了健康检查：
- **Host Worker**: 始终健康
- **Docker Worker**: 检查 Docker daemon 连接

## 故障排除

### 任务一直排队

**可能原因：**
1. 所有 Worker 都忙碌
2. Platform 不匹配
3. Worker 已离线

**解决方法：**
- 增加 Worker 数量
- 检查 Platform 配置
- 查看 Worker 日志

### Docker Worker 失败

**可能原因：**
1. Docker daemon 未运行
2. 镜像不存在
3. 资源限制过低

**解决方法：**
```bash
# 检查 Docker
docker version

# 拉取镜像
docker pull alpine:latest

# 测试容器
docker run --rm alpine:latest echo "test"
```

### 内存不足

**症状：** 任务被 OOM Killer 杀死

**解决方法：**
- 增加 `memory_limit`
- 减少并发 Worker 数量
- 使用更大的主机

## 最佳实践

### 1. Worker 数量选择

```
Host Workers = CPU 核数
Docker Workers = (总内存 / 单个容器内存) * 0.8
```

### 2. 混合使用

- 小任务使用 Host Worker（快速启动）
- 大任务或需要隔离的使用 Docker Worker

### 3. 资源限制

- 设置合理的 CPU/内存限制避免资源竞争
- Docker Worker 建议设置 `network_mode = "none"` 提高安全性

### 4. 超时配置

- `default_task_timeout_seconds` 应该大于最长任务的预期时间
- `result_ttl_seconds` 应该足够客户端获取结果

### 5. 日志级别

开发环境：
```bash
--verbose
```

生产环境：
```bash
RUST_LOG=info ./re-server --config config.toml
```

## 下一步

- 实现 Kubernetes Worker 支持
- 添加 Worker 健康监控
- 实现优先级队列
- 添加 Prometheus metrics
