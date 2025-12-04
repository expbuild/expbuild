# Remote Worker 使用指南

## 概述

ExpBuild 现在支持独立的 Worker 模式，可以将任务执行分离到远程 Worker 节点。

## 架构

```
Client → Server (Scheduler) → Worker (拉取任务并执行)
```

## 快速开始

### 1. 启动 Server（Scheduler 模式）

```bash
# 使用 remote workers 配置启动服务器
cargo run --bin re-server -- --config expbuild-server-remote-workers.toml --verbose
```

Server 将启动以下服务：
- Remote Execution API (端口 8980)
- Worker Scheduler API (gRPC, 端口 8980)
- CAS (Content Addressable Storage)
- Action Cache

### 2. 启动 Worker

```bash
# 在同一台或不同机器上启动 Worker
cargo run --bin expbuild-worker -- daemon --config expbuild-worker.toml --verbose
```

Worker 将：
- 连接到 Server 并注册
- 定期发送心跳 (每 30 秒)
- 拉取任务并执行
- 上传执行结果

### 3. 提交任务

使用现有的 CLI 客户端提交任务（无需修改）：

```bash
# 运行命令
cargo run --bin expbuild-cli -- run echo "Hello from remote worker"

# 或执行已上传的 Action
cargo run --bin expbuild-cli -- execute <action_digest>
```

## 配置说明

### Server 配置 (expbuild-server-remote-workers.toml)

```toml
[execution]
backend = "scheduler"  # 启用远程 Worker 调度器
```

### Worker 配置 (expbuild-worker.toml)

```toml
[worker]
server_url = "http://localhost:8980"  # Scheduler 地址
cas_url = "http://localhost:8980"     # CAS 地址
max_concurrent_tasks = 4              # 并发任务数

[worker.platform]
OSFamily = "Linux"                    # 平台属性用于任务匹配
Arch = "x86_64"

[worker.backend]
type = "host"                         # 执行后端: host 或 docker
work_dir = "/tmp/expbuild-worker"
```

## 架构特性

### Worker Scheduler (Server 端)

- ✅ 任务队列管理
- ✅ Worker 注册和心跳监控
- ✅ 任务租约机制 (5分钟)
- ✅ Platform 属性匹配
- ✅ 自动重试（租约超时）
- ✅ Worker 健康检查

### Worker Agent

- ✅ 自动注册到 Scheduler
- ✅ 长轮询拉取任务（30秒超时）
- ✅ 定期心跳（30秒间隔）
- ✅ 优雅停机（Ctrl+C）
- ✅ 从 CAS 下载输入
- ✅ 本地执行命令
- ✅ 上传输出到 CAS

## 监控

### Server 日志

```
INFO  Initializing remote worker scheduler...
INFO  Worker worker-abc123 registered with platform: {"OSFamily": "Linux", "Arch": "x86_64"}
INFO  Task task-xyz789 submitted to queue, queue size: 1
INFO  Leased task task-xyz789 to worker worker-abc123
INFO  Task task-xyz789 completed on worker worker-abc123
```

### Worker 日志

```
INFO  Worker worker-abc123 registered successfully
INFO  Starting execution of task task-xyz789
INFO  Downloading action a1b2c3.../1024
INFO  Downloading command d4e5f6.../512
INFO  Executing command: ["echo", "Hello"]
INFO  Command exited with code: 0
INFO  Task task-xyz789 completed successfully
```

## 扩展

### 添加更多 Worker

```bash
# Worker 2
cargo run --bin expbuild-worker -- daemon --config worker2.toml

# Worker 3
cargo run --bin expbuild-worker -- daemon --config worker3.toml
```

### 跨机器部署

Server 机器:
```bash
# 监听所有网卡
[server]
address = "0.0.0.0:8980"
```

Worker 机器:
```bash
# 连接到远程 Server
[worker]
server_url = "http://192.168.1.100:8980"
cas_url = "http://192.168.1.100:8980"
```

## 故障排查

### Worker 无法连接

```bash
# 检查网络连通性
curl http://localhost:8980

# 检查 Server 日志
# 应该看到 Worker 注册信息
```

### 任务一直排队

```bash
# 检查 Worker 状态
# Server 日志应显示 Worker 心跳

# 检查 Platform 匹配
# Worker 和 Action 的 Platform 属性必须匹配
```

### 任务执行失败

```bash
# 查看 Worker 日志
# 应该显示具体错误信息

# 检查工作目录权限
ls -la /tmp/expbuild-worker
```

## 限制和未来改进

### 当前限制

- ⚠️ `download_directory` 和 `upload_directory` 未完全实现
- ⚠️ Docker Executor 未实现
- ⚠️ 没有任务优先级
- ⚠️ 没有 Prometheus metrics

### 计划改进

- [ ] 完整的输入/输出目录支持
- [ ] Docker 容器执行
- [ ] 任务优先级队列
- [ ] Metrics 暴露
- [ ] Worker 资源限制
- [ ] 动态 Worker 发现 (Kubernetes)

## 与现有功能对比

| 特性 | Local Worker Pool | Remote Workers |
|------|-------------------|----------------|
| 水平扩展 | ❌ | ✅ |
| 跨机器部署 | ❌ | ✅ |
| 动态增减节点 | ❌ | ✅ |
| 故障隔离 | ⚠️ | ✅ |
| 延迟 | 低 | 中等 |
| 复杂度 | 低 | 高 |

## 贡献

欢迎贡献！主要文件：
- `re_grpc_proto/proto/expbuild/worker/v1/worker_api.proto` - Worker API 定义
- `re_server/src/execution/scheduler.rs` - 任务调度器
- `re_server/src/grpc/worker_scheduler_service.rs` - gRPC 服务
- `worker/src/agent.rs` - Worker Agent
- `worker/src/executor.rs` - 任务执行器
