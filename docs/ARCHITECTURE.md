# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

ExpBuild is a Rust-based implementation of the Bazel Remote Execution API v2, consisting of:
1. **CLI Client** (`cli/`) - Command-line tool for interacting with remote execution services
2. **Server** (`re_server/`, `re_server_bin/`) - Full Remote Execution API server implementation
3. **Client Library** (`re_grpc/`) - Core gRPC client library
4. **Protocol Definitions** (`re_grpc_proto/`) - Generated protobuf code

## Common Commands

### Building
```bash
# Build everything
cargo build

# Build specific components
cargo build --release --package re_server_bin    # Server
cargo build --release --package expbuild-cli     # CLI client

# Build for release
cargo build --release
```

### Testing
```bash
# Run all tests
cargo test

# Test specific crate
cargo test -p re_server
cargo test -p remote_execution

# Run specific test
cargo test -p re_server test_put_and_get_blob
```

### Running Components

**CLI Client:**
```bash
cargo run --bin expbuild-cli -- ping
cargo run --bin expbuild-cli -- capabilities
cargo run --bin expbuild-cli -- upload <files>
cargo run --bin expbuild-cli -- run <command> --input <dir> --output <dir>
```

**Server:**
```bash
cargo run --bin re-server -- --config expbuild-server.toml --verbose
```

## Architecture

### Overall Structure

The codebase is organized as a Rust workspace with 5 main crates that form a client-server architecture:

```
Client Side:                           Server Side:
┌─────────────┐                       ┌──────────────────┐
│     cli     │───uses───┐            │ re_server_bin    │
└─────────────┘          │            └──────────────────┘
                         ↓                      │
                   ┌──────────┐                 │uses
                   │ re_grpc  │                 ↓
                   └──────────┘           ┌──────────┐
                         │                │ re_server│
                         └────uses────────┤  (lib)   │
                                  ↓       └──────────┘
                          ┌──────────────┐
                          │re_grpc_proto │
                          └──────────────┘
```

### Client Architecture (`re_grpc/`)

The client library is organized around the Remote Execution protocol:

**Core Client (`client/`):**
- `REClientBuilder` - Builds gRPC connections with TLS, compression, keepalive
- `REClient` - Main client wrapping Execution, CAS, ActionCache, ByteStream, Capabilities services
- `main_client.rs` - High-level upload/download/execution methods
- `execution.rs`, `upload.rs`, `download.rs` - Protocol-specific operations
- `compression.rs` - Handles zstd/brotli/deflate compression

**Action Building (`action/`):**
- `ActionBuilder` - Constructs Action and Command protos
- `DirectoryBuilder` - Manages input file trees (walks directories, creates Directory protos)
- `ActionExecutor` - Orchestrates action execution with progress tracking
- `types.rs` - `CommandSpec`, `ExecutionRequest`, `ExecutionResult`

**Configuration Flow:**
1. Load `ReConfiguration` from TOML (in `cli/src/config.rs`)
2. Pass to `REClientBuilder::build_and_connect()`
3. Returns connected `REClient` with all service clients ready

### Server Architecture (`re_server/`)

The server implements all 5 Remote Execution API services using a layered architecture:

**Storage Layer (`storage/`):**
- `traits.rs` - `BlobStore` and `ActionCacheStore` trait definitions
- `filesystem.rs` - FileSystem-based CAS implementation (hash sharding: `{hash[0:2]}/{hash[2:4]}/{hash}`)
- `filesystem_action_cache.rs` - FileSystem-based action cache
- Factory functions `create_blob_store()` and `create_action_cache_store()` for instantiation

**Management Layer:**
- `CasManager` (`cas/manager.rs`) - Wraps BlobStore, handles digest verification, directory trees
- `ActionCacheManager` (`cache/manager.rs`) - Wraps ActionCacheStore
- `ExecutionManager` (`execution/manager.rs`) - Tracks operations, manages execution state

**gRPC Services (`grpc/`):**
Each service is implemented as a separate module:
- `capabilities_service.rs` - ServerCapabilities response
- `cas_service.rs` - FindMissingBlobs, BatchUpdate/ReadBlobs, GetTree
- `action_cache_service.rs` - GetActionResult, UpdateActionResult
- `bytestream_service.rs` - Streaming Read/Write for large files
- `execution_service.rs` - Execute, WaitExecution (returns Operation streams)

**Server Entry (`re_server_bin/src/main.rs`):**
1. Parse config from TOML
2. Initialize storage backends
3. Create managers (CAS, Cache, Execution)
4. Wire up all gRPC services
5. Start tonic server

### Key Concepts

**Digest Format:**
Throughout the codebase, digests are `{hash}:{size_bytes}`. The hash is SHA256 hex-encoded.

**Configuration:**
- **Client:** `expbuild.toml` (or `~/.config/expbuild/expbuild.toml`)
  - Remote endpoints (engine, CAS, action cache)
  - TLS settings
  - Instance name
- **Server:** `expbuild-server.toml`
  - Bind address
  - Storage backend configuration (filesystem/redis/tiered)
  - Execution settings
  - Capabilities

**Action Execution Flow (Client):**
1. `ActionBuilder` creates Action and Command messages
2. `DirectoryBuilder` walks input directory, creates file tree
3. Upload Command, input files/directories, Action to CAS
4. Call Execution.Execute() with action digest
5. `ActionExecutor` streams Operation updates
6. Download output files on completion

**Server Request Flow:**
```
gRPC Service → Manager → Storage Trait → Backend Implementation
```

**Enum Handling (Important!):**
Protocol buffer enums are accessed via nested modules:
```rust
// Wrong:
ExecutionStage::Completed

// Correct:
use re_grpc_proto::build::bazel::remote::execution::v2::execution_stage;
execution_stage::Value::Completed as i32
```
Same pattern for `digest_function`, `compressor`, `symlink_absolute_path_strategy`.

### Extensibility Points

**Adding Storage Backends:**
1. Implement `BlobStore` and/or `ActionCacheStore` traits
2. Add variant to `CasStorageConfig` or `ActionCacheConfig` enums in `re_server/src/config/mod.rs`
3. Handle in `create_blob_store()` or `create_action_cache_store()` factory functions

**Example:** Redis storage would need:
- `redis.rs` implementing `BlobStore`
- Config: `CasStorageConfig::Redis { redis_url, ... }`
- Factory case: `CasStorageConfig::Redis { ... } => Arc::new(RedisBlobStore::new(...))`

**Adding Execution Backends:**
Currently execution is minimal. To add real workers:
1. Define `WorkerPool` and `Worker` traits
2. Implement local/docker/kubernetes workers
3. Wire into `ExecutionManager`

## Configuration Files

**Client Configuration Example:**
- `expbuild.toml.example` - Shows remote endpoints, TLS, instance name
- Searched in: CLI flag `-c`, `./expbuild.toml`, `~/.config/expbuild/expbuild.toml`

**Server Configuration Example:**
- `expbuild-server.toml.example` - Production config
- `expbuild-server-test.toml` - Test config with local paths

## Proto Generation

Protocol buffers are pre-generated in `re_grpc_proto/src/`. If proto files change:
```bash
cd re_grpc_proto
cargo build  # build.rs handles codegen
```

## Common Patterns

**Error Handling:**
- Use `anyhow::Result` for most functions
- Convert to `tonic::Status` at gRPC service boundaries
- Use `.context()` for error context

**Async Operations:**
- All I/O is async using tokio
- Services use `#[tonic::async_trait]`
- Storage traits use `#[async_trait]`

**Testing:**
- Unit tests use `tempfile::TempDir` for filesystem operations
- See tests in `re_server/src/storage/filesystem.rs` for examples

## Development Notes

When modifying proto message handling, remember:
- Message fields are `Option<T>` in Rust
- Always use `.ok_or_else()` for required fields
- Encode/decode with `prost::Message`

When adding new gRPC services:
1. Implement service trait from `re_grpc_proto`
2. Register in `main.rs` with `Server::builder().add_service()`
3. Create manager/handler in appropriate layer
