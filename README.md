# ExpBuild

A high-performance, distributed build execution system written in Rust, implementing the [Bazel Remote Execution API v2](https://github.com/bazelbuild/remote-apis). ExpBuild provides a complete solution for scalable, remote build execution with content-addressable storage and caching.

## Features

- 🚀 **Full Remote Execution API v2** - Complete implementation of the Bazel Remote Execution protocol
- 📦 **Content-Addressable Storage (CAS)** - Efficient blob storage and deduplication
- 💾 **Action Cache** - Intelligent caching to avoid redundant builds
- 🔄 **ByteStream API** - Streaming support for large files
- 🌐 **Distributed Workers** - Scale execution across multiple worker nodes
- 🐳 **Container Isolation** - Docker-based task execution with security controls
- 🛡️ **Multiple Isolation Levels** - Host, container, and future VM support
- ⚡ **High Performance** - Async Rust implementation with tokio

## Architecture

ExpBuild consists of several components working together:

```
┌──────────────┐
│    Client    │ ← Command-line interface
│  (expbuild)  │
└──────┬───────┘
       │ gRPC
       ↓
┌──────────────┐     gRPC      ┌──────────────┐
│    Server    │───────────────→│   Worker(s)  │
│  (Scheduler) │←───────────────│  (Executor)  │
└──────┬───────┘   Task Lease  └──────────────┘
       │
       ↓
┌──────────────┐
│     CAS      │ ← Content-Addressable Storage
│ Action Cache │ ← Build result cache
└──────────────┘
```

### Components

- **`crates/cli/`** - Command-line client for interacting with the remote execution system
- **`crates/client/`** - Core client library with action building, upload/download, and execution
- **`crates/server/`** - Server implementation with scheduler, CAS, and action cache
- **`crates/server-bin/`** - Server binary entry point
- **`crates/worker/`** - Worker daemon that pulls and executes tasks
- **`crates/proto/`** - Generated protobuf code from Remote Execution API

## Quick Start

### Prerequisites

- Rust 1.75 or later
- (Optional) Docker for container-based execution

### Build from Source

```bash
# Clone the repository
git clone https://github.com/your-org/expbuild.git
cd expbuild

# Build all components
cargo build --release
```

### Start the Server

```bash
# Copy and edit server configuration
cp configs/server/expbuild-server.toml.example configs/server/expbuild-server.toml

# Start the server
cargo run --release --bin re-server -- --config configs/server/expbuild-server.toml --verbose
```

### Start a Worker

```bash
# For host-based execution
cargo run --release --bin expbuild-worker -- daemon --config configs/worker/expbuild-worker.toml --verbose

# For Docker-based execution (requires Docker)
cargo run --release --bin expbuild-worker -- daemon --config configs/worker/expbuild-worker-docker.toml --verbose
```

### Use the Client

```bash
# Check server capabilities
cargo run --bin expbuild-cli -- capabilities

# Ping server
cargo run --bin expbuild-cli -- ping

# Upload files to CAS
cargo run --bin expbuild-cli -- upload <files...>

# Execute a remote action
cargo run --bin expbuild-cli -- run <command> --input <dir> --output <dir>
```

## Configuration

### Client Configuration

Create `~/.config/expbuild/config.toml` or `expbuild.toml` in your project:

```toml
remote_endpoint = "http://localhost:50051"
instance_name = "main"
```

See `configs/client/expbuild.toml.example` for more options.

### Server Configuration

The server supports multiple storage backends and execution modes:

```toml
# Server binding address
address = "0.0.0.0:50051"

# Content-Addressable Storage
[cas_storage]
type = "filesystem"  # or "memory"
root_path = "/var/cache/expbuild/cas"

# Action Cache
[action_cache]
type = "filesystem"  # or "memory"
root_path = "/var/cache/expbuild/action_cache"

# Execution backend
[execution]
backend = "scheduler"  # Use remote workers
# backend = "direct"   # Direct local execution
```

See `configs/server/expbuild-server.toml.example` for full configuration options.

### Worker Configuration

Workers can be configured for different execution modes:

**Host-based execution** (runs tasks directly on the host):
```toml
worker_id = "worker-01"
server_url = "http://localhost:50051"
cas_url = "http://localhost:50051"

[platform]
os = "linux"
arch = "x86_64"

[executor]
type = "host"
env_whitelist = ["PATH", "HOME", "USER"]
```

**Docker-based execution** (runs tasks in containers):
```toml
worker_id = "worker-docker-01"
server_url = "http://localhost:50051"
cas_url = "http://localhost:50051"

[platform]
os = "linux"
arch = "x86_64"
container = "docker"

[executor]
type = "docker"
image = "rust:1.75-alpine"
network_mode = "none"
readonly_rootfs = true
```

See `configs/worker/` for complete examples.

## Documentation

Detailed documentation is available in the `docs/` directory:

- [Architecture Overview](docs/ARCHITECTURE.md) - System design and component interactions
- [Worker Design](docs/WORKER_DESIGN.md) - Worker implementation details
- [Remote Worker Guide](docs/REMOTE_WORKER_GUIDE.md) - Setting up distributed workers
- [Docker Executor](docs/DOCKER_EXECUTOR_SUMMARY.md) - Container-based execution
- [Isolation Design](docs/ISOLATION_DESIGN.md) - Security and isolation strategies

## Development

### Running Tests

```bash
# Run all tests
cargo test

# Test specific crate
cargo test -p expbuild-server
cargo test -p expbuild-worker

# Run integration tests
cargo test --test integration_tests
```

### Code Structure

The project follows a workspace structure:

```
expbuild/
├── crates/
│   ├── cli/          # Command-line interface
│   ├── client/       # Core client library (re_grpc)
│   ├── server/       # Server library (re_server)
│   ├── server-bin/   # Server binary
│   ├── worker/       # Worker daemon
│   └── proto/        # Protocol definitions
├── configs/          # Example configurations
├── docs/             # Documentation
└── tests/            # Integration tests
```

## Contributing

**Contributions are welcome!** We appreciate your interest in improving ExpBuild.

### How to Contribute

1. **Fork the repository** and create a feature branch
2. **Write tests** for your changes
3. **Follow the existing code style** and run `cargo fmt`
4. **Ensure all tests pass** with `cargo test`
5. **Submit a pull request** with a clear description of your changes

### Areas We'd Love Help With

- 📖 **Documentation** - Improve guides, add examples, fix typos
- 🐛 **Bug Reports** - File detailed issues with reproduction steps
- ✨ **Features** - Implement VM isolation, additional storage backends
- 🔧 **Testing** - Add integration tests, improve test coverage
- 🌐 **Ecosystem** - Build integrations with other build systems
- 🚀 **Performance** - Profile and optimize hot paths

### Getting Started with Development

```bash
# Clone your fork
git clone https://github.com/YOUR_USERNAME/expbuild.git
cd expbuild

# Create a feature branch
git checkout -b feature/your-feature-name

# Make your changes and test
cargo build
cargo test
cargo fmt --all -- --check
cargo clippy -- -D warnings

# Commit and push
git commit -m "Add your feature"
git push origin feature/your-feature-name
```

### Guidelines

- **Be respectful and inclusive** - Follow the Rust Code of Conduct
- **Write clear commit messages** - Explain what and why, not just how
- **Keep PRs focused** - One feature/fix per pull request
- **Update documentation** - Keep docs in sync with code changes
- **Add tests** - New features should include appropriate test coverage

### Questions or Ideas?

- Open an [issue](https://github.com/your-org/expbuild/issues) for bugs or feature requests
- Start a [discussion](https://github.com/your-org/expbuild/discussions) for questions or ideas
- Check existing issues and PRs to avoid duplicates

We look forward to your contributions! 🎉

## Roadmap

- [ ] VM-based isolation (Firecracker, gVisor)
- [ ] Additional storage backends (S3, GCS, Azure Blob)
- [ ] Worker auto-scaling
- [ ] Web-based monitoring dashboard
- [ ] Build analytics and metrics
- [ ] Bazel integration improvements

## License

This project is dual-licensed under:

- MIT License ([LICENSE-MIT](LICENSE-MIT) or http://opensource.org/licenses/MIT)
- Apache License, Version 2.0 ([LICENSE-APACHE](LICENSE-APACHE) or http://www.apache.org/licenses/LICENSE-2.0)

You may choose either license for your use.

## Acknowledgments

- Built with [Tokio](https://tokio.rs/) for async runtime
- Uses [Tonic](https://github.com/hyperium/tonic) for gRPC implementation
- Implements the [Bazel Remote Execution API](https://github.com/bazelbuild/remote-apis)

---

**Star ⭐ the project if you find it useful!**
