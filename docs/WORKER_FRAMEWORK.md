# Worker Framework Usage Guide

## Overview

The Worker Framework provides flexible task execution capabilities for the ExpBuild Remote Execution server, supporting multiple execution backends.

## Supported Worker Types

### 1. Host Worker
Executes tasks as processes on the local host.

**Features:**
- Direct execution on the host
- Configurable environment variable whitelist
- User/group switching support
- Fastest startup time

**Configuration Example:**
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

**Parameter Description:**
- `count` - Number of workers
- `work_dir` - Working directory
- `use_chroot` - Whether to use chroot isolation (not implemented)
- `env_whitelist` - Allowed environment variables to pass through
- `run_as_user` - Execution user (optional)
- `run_as_group` - Execution group (optional)

### 2. Docker Worker
Executes tasks in Docker containers.

**Features:**
- Complete container isolation
- CPU/memory resource limits
- Network isolation
- Volume mount support

**Configuration Example:**
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

**Parameter Description:**
- `count` - Number of workers
- `image` - Docker image
- `always_pull` - Whether to pull the image before each execution
- `cpu_limit` - CPU core limit
- `memory_limit` - Memory limit (bytes)
- `network_mode` - Network mode (none/bridge/host)
- `user` - User to run as inside the container
- `volumes` - Volume mount configuration

## Worker Pool Configuration

```toml
[execution]
backend = "pool"

[execution.pool]
max_queue_size = 1000
scheduler_interval_ms = 100
default_task_timeout_seconds = 3600
result_ttl_seconds = 300
```

**Parameter Description:**
- `max_queue_size` - Maximum queue length
- `scheduler_interval_ms` - Scheduler polling interval (milliseconds)
- `default_task_timeout_seconds` - Default task timeout
- `result_ttl_seconds` - Result retention time

## Complete Configuration Example

### Mixed Worker Configuration

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

# Fast Host Workers for small tasks
[[execution.pool.workers]]
type = "host"
count = 4
work_dir = "/tmp/expbuild-host-workers"
use_chroot = false
env_whitelist = ["PATH", "HOME", "USER"]

# Docker Workers for tasks requiring specific environments
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

## Platform Matching

The Worker Pool automatically selects appropriate workers based on the Action's Platform attributes.

### Platform Attributes

Actions can specify platform requirements:

```protobuf
Platform {
  properties: [
    { name: "OSFamily", value: "Linux" },
    { name: "container", value: "docker" }
  ]
}
```

Workers declare their capabilities:
- **Host Worker**: OSFamily=current operating system, Arch=current architecture
- **Docker Worker**: OSFamily=Linux, container=docker

The scheduler automatically matches:
- If the Action doesn't specify a Platform, it can be scheduled to any worker
- If a Platform is specified, it will only be scheduled to matching workers

## Running the Server

```bash
# Start with worker pool configuration
./target/release/re-server --config expbuild-server-pool.toml --verbose

# Sample output:
# 2025-11-30T12:00:00Z INFO re_server_bin: Loading configuration from: expbuild-server-pool.toml
# 2025-11-30T12:00:00Z INFO re_server_bin: Initializing storage...
# 2025-11-30T12:00:00Z INFO re_server_bin: Initializing worker pool...
# 2025-11-30T12:00:00Z INFO re_server::execution::pool_factory: Creating 2 host workers
# 2025-11-30T12:00:00Z INFO re_server::execution::pool_factory: Registered host worker: host-worker-1
# 2025-11-30T12:00:00Z INFO re_server::execution::pool_factory: Registered host worker: host-worker-2
# 2025-11-30T12:00:00Z INFO re_server::execution::pool_factory: Worker pool started with 2 workers
# 2025-11-30T12:00:00Z INFO re_server_bin: Starting server on 127.0.0.1:8980
```

## Monitoring

### Worker Pool Statistics

Worker Pool status can be observed through logs:
- Number of tasks in queue
- Number of idle/busy workers
- Number of completed/failed tasks

### Health Checks

Each worker implements health checks:
- **Host Worker**: Always healthy
- **Docker Worker**: Checks Docker daemon connection

## Troubleshooting

### Tasks Always Queuing

**Possible Causes:**
1. All workers are busy
2. Platform mismatch
3. Workers are offline

**Solutions:**
- Increase the number of workers
- Check Platform configuration
- Review worker logs

### Docker Worker Failures

**Possible Causes:**
1. Docker daemon not running
2. Image does not exist
3. Resource limits too low

**Solutions:**
```bash
# Check Docker
docker version

# Pull the image
docker pull alpine:latest

# Test container
docker run --rm alpine:latest echo "test"
```

### Out of Memory

**Symptoms:** Tasks killed by OOM Killer

**Solutions:**
- Increase `memory_limit`
- Reduce the number of concurrent workers
- Use a larger host

## Best Practices

### 1. Worker Count Selection

```
Host Workers = CPU cores
Docker Workers = (Total memory / Single container memory) * 0.8
```

### 2. Mixed Usage

- Use Host Workers for small tasks (fast startup)
- Use Docker Workers for large tasks or those requiring isolation

### 3. Resource Limits

- Set reasonable CPU/memory limits to avoid resource contention
- For Docker Workers, recommend setting `network_mode = "none"` to improve security

### 4. Timeout Configuration

- `default_task_timeout_seconds` should be greater than the expected time of the longest task
- `result_ttl_seconds` should be sufficient for clients to retrieve results

### 5. Log Levels

Development environment:
```bash
--verbose
```

Production environment:
```bash
RUST_LOG=info ./re-server --config config.toml
```

## Next Steps

- Implement Kubernetes Worker support
- Add Worker health monitoring
- Implement priority queue
- Add Prometheus metrics
