# Experimental Nx HTTP cache

`nx-http@0.1.0` is an opt-in engine with a client configuration profile pinned to **Nx 22.7.12**. Protocol fixtures and platform tests validate this implementation. Real Nx acceptance has not run; this is not certified client support.

This implements Nx's self-hosted HTTP protocol. WebDAV, Gradle and REAPI endpoints are not interchangeable with it. Archives are opaque binary data; the task hash is neither a digest of those bytes nor an authorization boundary.

## Enable and connect

Build `images/nx-cache/Dockerfile` and set your administrator-approved immutable digest in `images.nx`. It defaults to empty, so new Nx instances remain disabled until approval. The existing image workflow builds and smoke-tests images with `push: false`; it does not publish images. Durable image binding follows the other engines' rules.

```yaml
images:
  nx: your-registry.example/expbuild/nx-cache@sha256:YOUR_APPROVED_DIGEST
```

Create an Nx HTTP instance through the console or API with a positive `cacheGiB` below `storageGiB`. The Operator creates one process, a dedicated retained PVC and a root HTTP endpoint. Gateway exposure uses HTTPS and no gRPC route. Use trusted certificates; never disable TLS verification. Internal HTTP is for the trusted cluster network only.

Save the one-time instance password as the Bearer token. It is scoped by the server deployment to that instance and its PVC. Neither a caller's task hash nor a query parameter can select another namespace. The mounted credential stores a bcrypt hash; the separate health identity cannot read or write archives. Rotation uses the existing credential workflow. Encrypted pending operation credentials are cleared after reconciliation. The generated recipe prompts for the token inside a subshell and does not embed it or save it to browser storage.

The Ready connection panel requires a workspace-local **Nx 22.7.12** already installed, with its native package. It does not install software. It sets:

- `NX_SELF_HOSTED_REMOTE_CACHE_SERVER` to the instance origin **without a trailing slash or `/v1` suffix**.
- `NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN` from a hidden interactive prompt.
- `NX_NO_CLOUD=true` and `NX_DAEMON=false` inside the subshell, then runs the workspace's `nx run-many -t build`.

Ensure `nx.json` has no other configured remote provider (S3, GCS, Azure or shared filesystem). Those providers precede HTTP in the pinned client. WASM does not support this HTTP cache. The server token grants reads and writes; there is no separate server-enforced read-only token role in this release. Use it only in trusted build environments, never untrusted pull requests. A client configuration flag cannot reduce the authority of a leaked token.

## Wire contract

| Request | Response |
| --- | --- |
| `GET /v1/cache/{hash}` | 200 with unchanged binary body, Content-Type application/octet-stream and exact Content-Length; 404 on a miss |
| `PUT /v1/cache/{hash}` | Content-Length required; 200 for first atomic publication; 409 whenever the key exists, including identical bytes |
| `GET /status` | Separate Basic health credentials; configured namespace and logical capacity for Operator readiness |

Client requests require a single `Authorization: Bearer <instance password>` header. Invalid credentials return 401 with exact `Content-Type: text/plain`, matching the pinned client's error decoder. Error bodies are generic and never include credentials. A wrong-instance token fails authentication before the hash is consulted.

Hashes are case-sensitive, 1–256 ASCII letters, digits, hyphens, underscores or dots, excluding `.` and `..`. They map to private SHA256 filenames, never caller paths. Query parameters and encoded paths are rejected. Unsupported methods return 405. The implementation has no Turbo team/status/events routes, archive extraction, server-generated signatures or Nx Cloud features.

Unknown upload length returns 411; oversized bodies return 413; incomplete or mismatched bodies return 400. One staging upload runs at a time, with up to 16 admitted upload requests and a five-minute cancellable wait. Excess admission returns 503 so clients may retry later. Filesystem failures and corruption fail closed with 503, not a false cache hit. The pinned Nx client treats statuses outside its documented 200/409/403 PUT and 200/404 GET cases as errors; it may fail a build rather than retry automatically.

## Storage and trust boundaries

An envelope stores the key, size, private checksum and unchanged archive. A completed temporary file is fsynced before atomic create-only hard-link publication, then its directory is synced. Partial uploads remain invisible and temporary files are removed. Existing entries cannot be overwritten, including retries with identical bytes. Concurrent requests cannot combine metadata and bytes from different uploads.

The single-process LRU index reconstructs on restart. The logical budget counts body bytes plus a 4096-byte envelope per entry. A bounded staged upload additionally needs headroom. The renderer caps an archive at 256 MiB and further reduces this limit to fit the budget and PVC headroom. This is a logical capacity bound, not a physical block/inode quota. ENOSPC rejects publication. Eviction removes whole entries; a later upload can recreate an evicted key.

Startup refuses corrupt, nonregular or unexpected files and needs operator diagnosis rather than silently discarding them. Symlink roots/files and FIFO entries are rejected. Reads validate checksum and size against the in-memory index, and keep bytes accounted while downloading. Reads are currently serialized, with a five-minute HTTP read/write timeout and bounded headers. This is an experimental single-process design, not a throughput or scale claim. No statistics/history/metrics capability is advertised.

The checksum detects storage corruption; it does not prove a build is correct. Create-only writes prevent replacing retained entries but cannot prevent a malicious authorized writer from poisoning a key first, or after eviction. Keep independent instances and credentials for different trust domains, rotate compromised credentials and clear or replace affected caches. Do not share a read/write token with untrusted jobs. Follow Nx's recommendation to skip caches for deployment artifacts when that trust is required. This implementation does not provide Nx Cloud branch isolation, personal-token roles or end-to-end encryption.

## Validation and pending acceptance

Existing CI covers Go HTTP fixtures, actual HTTP binary roundtrips, authentication, namespace isolation, create-only conflicts, rejected and concurrent uploads, recovery, corruption and symlink handling. It also covers rendering/admission/image approval, API credential lifecycle, UI and Bash recipes, browser behavior and Python HTTP smoke checks against the built product image. These fixtures do not execute Nx itself.

Before claiming real client compatibility, use an isolated runner with pinned `nx@22.7.12`, its npm dependencies and the matching Linux native package `@nx/nx-linux-x64-gnu@22.7.12`. Exact package integrity and transitive versions must be recorded in a lockfile. Reuse existing Node and an `nx:run-commands` fixture with a built-in Node build script; no create-nx-workspace installer or framework plugin is needed. Download/execution approval is pending, and this change adds no workflow to install or run Nx.

Acceptance must show a cold remote write, a fresh local cache with removed outputs restoring from remote, output comparison against an uncached baseline, source/argument/dependency invalidation, wrong and cross-instance tokens, duplicate writes, partial/oversized uploads and unavailable-server behavior. Record the client version, server SHA, Node version and fixture revision. Actual new-template deployment and HTTPS acceptance remain separate gates from protocol mocks and existing-cluster regressions.

## Pinned upstream evidence

- [Nx 22.7.12 release](https://github.com/nrwl/nx/releases/tag/22.7.12)
- [HTTP routes, headers, archive transport and response handling](https://github.com/nrwl/nx/blob/22.7.12/packages/nx/src/native/cache/http_remote_cache.rs)
- [Native HTTP error decoding](https://github.com/nrwl/nx/blob/22.7.12/packages/nx/src/native/cache/errors.rs)
- [Remote-provider selection](https://github.com/nrwl/nx/blob/22.7.12/packages/nx/src/tasks-runner/cache.ts)
- [Nx Cloud selection](https://github.com/nrwl/nx/blob/22.7.12/packages/nx/src/utils/nx-cloud-utils.ts)
- [Self-hosted caching specification](https://nx.dev/docs/kb/self-hosted-caching)
- [Cache security guidance](https://nx.dev/docs/kb/cache-security)
