# Remote Worker Usage Guide

## Overview

ExpBuild now supports standalone Worker mode, which allows task execution to be offloaded to remote Worker nodes.

## Architecture

```
Client → Server (Scheduler) → Worker (Pulls and executes tasks)
```

## Quick Start

### 1. Start Server (Scheduler Mode)

```bash
# Start the server with remote workers configuration
cargo run --bin re-server -- --config expbuild-server-remote-workers.toml --verbose
```

The server will start the following services:
- Remote Execution API (port 8980)
- Worker Scheduler API (gRPC, port 8980)
- CAS (Content Addressable Storage)
- Action Cache

### 2. Start Worker

```bash
# Start Worker on the same or different machine
cargo run --bin expbuild-worker -- daemon --config expbuild-worker.toml --verbose
```

The Worker will:
- Connect to the Server and register
- Send periodic heartbeats (every 30 seconds)
- Poll for tasks and execute them
- Upload execution results

### 3. Submit Tasks

Use the existing CLI client to submit tasks (no modifications needed):

```bash
# Run a command
cargo run --bin expbuild-cli -- run echo "Hello from remote worker"

# Or execute an uploaded Action
cargo run --bin expbuild-cli -- execute <action_digest>
```

## Configuration

### Server Configuration (expbuild-server-remote-workers.toml)

```toml
[execution]
backend = "scheduler"  # Enable remote Worker scheduler
```

### Worker Configuration (expbuild-worker.toml)

```toml
[worker]
server_url = "http://localhost:8980"  # Scheduler address
cas_url = "http://localhost:8980"     # CAS address
max_concurrent_tasks = 4              # Number of concurrent tasks

[worker.platform]
OSFamily = "Linux"                    # Platform properties for task matching
Arch = "x86_64"

[worker.backend]
type = "host"                         # Execution backend: host or docker
work_dir = "/tmp/expbuild-worker"
```

## Architecture Features

### Worker Scheduler (Server Side)

- ✅ Task queue management
- ✅ Worker registration and heartbeat monitoring
- ✅ Task lease mechanism (5 minutes)
- ✅ Platform property matching
- ✅ Automatic retry (lease timeout)
- ✅ Worker health checks

### Worker Agent

- ✅ Automatic registration with Scheduler
- ✅ Long polling for tasks (30 second timeout)
- ✅ Periodic heartbeat (30 second interval)
- ✅ Graceful shutdown (Ctrl+C)
- ✅ Download inputs from CAS
- ✅ Execute commands locally
- ✅ Upload outputs to CAS

## Monitoring

### Server Logs

```
INFO  Initializing remote worker scheduler...
INFO  Worker worker-abc123 registered with platform: {"OSFamily": "Linux", "Arch": "x86_64"}
INFO  Task task-xyz789 submitted to queue, queue size: 1
INFO  Leased task task-xyz789 to worker worker-abc123
INFO  Task task-xyz789 completed on worker worker-abc123
```

### Worker Logs

```
INFO  Worker worker-abc123 registered successfully
INFO  Starting execution of task task-xyz789
INFO  Downloading action a1b2c3.../1024
INFO  Downloading command d4e5f6.../512
INFO  Executing command: ["echo", "Hello"]
INFO  Command exited with code: 0
INFO  Task task-xyz789 completed successfully
```

## Scaling

### Adding More Workers

```bash
# Worker 2
cargo run --bin expbuild-worker -- daemon --config worker2.toml

# Worker 3
cargo run --bin expbuild-worker -- daemon --config worker3.toml
```

### Cross-Machine Deployment

Server machine:
```bash
# Listen on all network interfaces
[server]
address = "0.0.0.0:8980"
```

Worker machine:
```bash
# Connect to remote Server
[worker]
server_url = "http://192.168.1.100:8980"
cas_url = "http://192.168.1.100:8980"
```

## Troubleshooting

### Worker Cannot Connect

```bash
# Check network connectivity
curl http://localhost:8980

# Check Server logs
# Should see Worker registration information
```

### Tasks Keep Queuing

```bash
# Check Worker status
# Server logs should show Worker heartbeats

# Check Platform matching
# Worker and Action Platform properties must match
```

### Task Execution Failures

```bash
# Check Worker logs
# Should display specific error information

# Check working directory permissions
ls -la /tmp/expbuild-worker
```

## Limitations and Future Improvements

### Current Limitations

- ⚠️ `download_directory` and `upload_directory` not fully implemented
- ⚠️ Docker Executor not implemented
- ⚠️ No task priority
- ⚠️ No Prometheus metrics

### Planned Improvements

- [ ] Full input/output directory support
- [ ] Docker container execution
- [ ] Task priority queue
- [ ] Metrics exposure
- [ ] Worker resource limits
- [ ] Dynamic Worker discovery (Kubernetes)

## Comparison with Existing Features

| Feature | Local Worker Pool | Remote Workers |
|---------|-------------------|----------------|
| Horizontal Scaling | ❌ | ✅ |
| Cross-Machine Deployment | ❌ | ✅ |
| Dynamic Add/Remove Nodes | ❌ | ✅ |
| Fault Isolation | ⚠️ | ✅ |
| Latency | Low | Medium |
| Complexity | Low | High |

## Contributing

Contributions welcome! Key files:
- `re_grpc_proto/proto/expbuild/worker/v1/worker_api.proto` - Worker API definition
- `re_server/src/execution/scheduler.rs` - Task scheduler
- `re_server/src/grpc/worker_scheduler_service.rs` - gRPC service
- `worker/src/agent.rs` - Worker Agent
- `worker/src/executor.rs` - Task executor
