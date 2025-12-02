# ExpBuild

A Rust implementation of the [Bazel Remote Execution API v2](https://github.com/bazelbuild/remote-apis), providing both client and server components for distributed build execution.

## Overview

ExpBuild consists of:

- **CLI Client** (`expbuild-cli`) - Command-line tool for remote execution operations
- **Server** (`re-server`) - Full Remote Execution API server implementation  
- **Client Library** (`re_grpc`) - Reusable gRPC client library
- **Protocol Definitions** (`re_grpc_proto`) - Generated protobuf code from Remote Execution API

## Quick Start

### Build

```bash
cargo build --release
```

### Run Server

```bash
cargo run --bin re-server -- --config expbuild-server.toml --verbose
```

### Run Client

```bash
# Check server capabilities
cargo run --bin expbuild-cli -- capabilities

# Ping server
cargo run --bin expbuild-cli -- ping

# Upload files
cargo run --bin expbuild-cli -- upload <files>

# Execute remote action
cargo run --bin expbuild-cli -- run <command> --input <dir> --output <dir>
```

## Configuration

### Client Configuration

Create `expbuild.toml` (see `expbuild.toml.example`):

```toml
remote_endpoint = "http://localhost:50051"
instance_name = "main"
```

### Server Configuration  

Create `expbuild-server.toml` (see `expbuild-server.toml.example`):

```toml
address = "0.0.0.0:50051"

[cas_storage]
type = "filesystem"
root_path = "/var/cache/expbuild/cas"

[action_cache]
type = "filesystem"
root_path = "/var/cache/expbuild/action_cache"
```

## Architecture

### Components

- **`cli/`** - CLI client implementation
- **`re_grpc/`** - Core client library with action building, upload/download, execution
- **`re_server/`** - Server library with storage backends and service implementations
- **`re_server_bin/`** - Server binary entry point
- **`re_grpc_proto/`** - Generated protobuf code

### Supported Services

- Execution API - Execute actions remotely
- Content Addressable Storage (CAS) - Store and retrieve blobs
- Action Cache - Cache action results
- ByteStream - Stream large files
- Capabilities - Query server capabilities

## Development

### Testing

```bash
# Run all tests
cargo test

# Test specific crate
cargo test -p re_server
```

### Documentation

To be done

## License

MIT 
