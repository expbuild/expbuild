# Public Code Evidence for Depot's Architecture

Research date: 2026-09-28. This document's code findings apply only to the immutable commits below. Public clients, BYOC agents, and the current hosted production environment do not provide the same scope of visibility. **The existence of a code path does not mean every Depot product uses it.**

## 1. Code Baselines

| Official repository | Commit examined | Commit date (repository record) | Research use |
|---|---|---|---|
| [depot/cli](https://github.com/depot/cli/tree/788a3d5373bc5f4bc19f40f8d6148899b763706c) | `788a3d5373bc5f4bc19f40f8d6148899b763706c` | 2026-09-23 | Build control protocol, BuildKit connections, cache protocol, older Go cache client |
| [depot/cloud-agent](https://github.com/depot/cloud-agent/tree/727d4b99a6678d48e190d08724715adf013aa731) | `727d4b99a6678d48e190d08724715adf013aa731` | 2026-05-24 | Cloud resource reconciliation, persistent volumes, Ceph management paths |
| [depot/machine-agent](https://github.com/depot/machine-agent/tree/f6183c52bb8992d408ad0b246fa87f24a597ed60) | `f6183c52bb8992d408ad0b246fa87f24a597ed60` | 2026-09-25 | Machine identity registration, BuildKit configuration, mounting, and cleanup |
| [depot/setup-action](https://github.com/depot/setup-action/tree/91bc8495a33ebfc504ffc89e5674379ccf23c29c) | `91bc8495a33ebfc504ffc89e5674379ccf23c29c` | 2026-08-20 | GitHub Actions OIDC exchange and CLI installation |

Method: shallow clones of official public repositories and static review of source files and protobuf definitions. No Depot account credentials were held, no paid build services were called, and no runtime packet capture or load testing was performed.

## 2. Facts Directly Supported by Code

### 2.1 Separate Build Control and Execution Channels

By default, the CLI sends management and build-control RPCs to `https://api.depot.dev` using Connect-generated clients. `CreateBuild` returns `build_id`, `build_token`, a build URL, Registry configuration, and other fields; the CLI then requests `GetBuildKitConnection` for amd64 / arm64. The connection can be pending with a retry delay, or it can return an endpoint, server name, client certificate, CA, and identity/gzip compression choice. [Client entry point](https://github.com/depot/cli/blob/788a3d5373bc5f4bc19f40f8d6148899b763706c/pkg/api/rpc.go#L22), [build protocol](https://github.com/depot/cli/blob/788a3d5373bc5f4bc19f40f8d6148899b763706c/proto/depot/cli/v1/build.proto#L81), [connection protocol](https://github.com/depot/cli/blob/788a3d5373bc5f4bc19f40f8d6148899b763706c/proto/depot/cli/v1/build.proto#L149).

After obtaining connection information, the CLI establishes a TLS connection using a BuildKit client configured with the returned CA, server name, and client certificate; a direct TLS connection implementation also exists. Build health messages are reported to the control API approximately every 5 seconds, and the server can return a cancellation time. This establishes that the build-control API need not carry all BuildKit build traffic: the CLI has an independent path to the execution endpoint. The client cannot determine whether a layer-4 proxy sits behind that endpoint. [Connection, health loop, and BuildKit client](https://github.com/depot/cli/blob/788a3d5373bc5f4bc19f40f8d6148899b763706c/pkg/machine/machine.go#L45), [TLS connection](https://github.com/depot/cli/blob/788a3d5373bc5f4bc19f40f8d6148899b763706c/pkg/connection/machine.go#L18).

### 2.2 A Separate Cache Service Protocol with Batched Existence Checks and Bundle Metadata

The CLI's default cache endpoint is `https://cache.depot.dev`, overridable through `DEPOT_CACHE_HOST`. `CacheService` in the public protobuf includes:

| Method / field | Confirmed meaning | What it does not establish |
|---|---|---|
| `CreateEntry(entry_type, key, scope?)` | Starts an upload by entry type and key; returns an entry ID and upload-part URLs | That all protocols share one database table or global deduplication domain |
| `FetchMorePresignedURLs(entry_id, next_part, count)` | Supports obtaining additional upload-part URLs in subsequent batches | Part size, actual upload concurrency, or which protocols use this path |
| `FinalizeEntry(size_bytes, upload_part_etags, children, segments)` | Upload and final entry publication are separate phases; child entries and segment information are supported | Publication transactions, reference consistency, or garbage-collection algorithms |
| `CheckEntries(entry_type, repeated keys)` | **Batched key-existence checks**, returning `found` for each key | Whether internals use SQL, KV, Bloom Filter, S3 HEAD, or any particular latency |
| `GetBundle(entry_type, subkey)` | Gets a bundle URL, bundle key, total size, and segments using a subkey | Server cache layout, prefetch strategy, or target bundle size |
| `Segment(subkey, offset, size)` | Locates a subentry within a single bundle | That packing necessarily crosses tenants or that global compaction occurs on the server |
| `GetDownloadURLByPrefix(key_prefixes, scope)` | Prefix fallback and optional isolation scope; comments cite GHA restore keys as an example | That arbitrary clients have permission to access other scopes |

All of the above comes from [cache.proto](https://github.com/depot/cli/blob/788a3d5373bc5f4bc19f40f8d6148899b763706c/proto/depot/cache/v1/cache.proto#L7). The comment on `fail_if_upload_in_progress` indicates that the generic interface can disallow concurrent uploads; otherwise, it permits concurrency with last-write-wins behavior. **This generic-interface comment must not be generalized into overwrite rules for every CAS/Action Cache protocol.** [CreateEntry definition](https://github.com/depot/cli/blob/788a3d5373bc5f4bc19f40f8d6148899b763706c/proto/depot/cache/v1/cache.proto#L19).

The CLI's `UploadCacheEntry` does execute `CreateEntry → PUT to presigned URL → read ETag → FinalizeEntry`. A code comment explicitly identifies the URL as an S3 URL; uploads are skipped on `AlreadyExists`. This is actual client evidence for “metadata API + direct object-storage upload,” not just an architectural-diagram hypothesis. This helper uses the first part URL and a complete in-memory `[]byte`; it does not establish that every Depot client streams uploads or uses only one part. [Implementation](https://github.com/depot/cli/blob/788a3d5373bc5f4bc19f40f8d6148899b763706c/pkg/api/cache.go#L16).

### 2.3 The Public CLI's Go Cache Implementation Is Still v1 and Cannot Substitute for v2 Evidence

At the examined commit, `depot gocache` implements Go's stdin/stdout JSON external cache protocol, handling each request in a goroutine. GET checks local disk first, then calls `/gocache/v1/{actionID}` on a miss; PUT writes to local cache before starting a remote PUT in the background. Requests carry a Bearer token and additionally `X-Depot-Org` when an organization is specified. Network failures and some server errors fall back to cache misses. Shutdown waits for background uploads and cancels them after 10 seconds. This is not a client in which every read synchronously accesses the remote service. [Protocol loop](https://github.com/depot/cli/blob/788a3d5373bc5f4bc19f40f8d6148899b763706c/pkg/cmd/gocache/gocache.go#L134), [read implementation](https://github.com/depot/cli/blob/788a3d5373bc5f4bc19f40f8d6148899b763706c/pkg/cmd/gocache/gocache.go#L342), [write implementation](https://github.com/depot/cli/blob/788a3d5373bc5f4bc19f40f8d6148899b763706c/pkg/cmd/gocache/gocache.go#L457).

By contrast, Gocache v2, described in the official 2025-05-30 article, aggregates small PUTs into bundles and downloads the relevant bundle and segment index on GET, prefetching neighboring entries. The article explicitly explains that this reduces the request overhead of accessing small objects in S3. This product mechanism is supported by the official article, and the public `GetBundle`/`Segment` protocol is consistent with it, **but this review found no public client repository allowing review of the complete v2 implementation**. v1's per-object path must not be treated as the implementation for every current Depot Go workload, nor can we claim to have verified v2 thresholds, concurrency, and compression settings from open-source code. [Official v2 explanation](https://depot.dev/blog/now-available-gocache-v2-faster-improved-golang-build-performance).

### 2.4 Multiple Authentication Lifecycles: User/Project, Build, and Machine Credentials

The CLI supplies a Bearer header and optional `x-depot-org`. Project authorization can be resolved from an explicit token, environment, local configuration, CI OIDC provider, JIT/cache token, and other paths, while the organization authorization code path is not identical. “The CLI supports OIDC” does not mean every command automatically performs the same token exchange. [RPC headers](https://github.com/depot/cli/blob/788a3d5373bc5f4bc19f40f8d6148899b763706c/pkg/api/rpc.go#L79), [authorization resolution](https://github.com/depot/cli/blob/788a3d5373bc5f4bc19f40f8d6148899b763706c/pkg/helpers/token.go#L13).

When `oidc` is enabled, `setup-action` requests a GitHub ID token with audience=`https://depot.dev`, POSTs it to `https://github.depot.dev/auth/oidc/github-actions`, then places the exchanged result in the workflow environment as `DEPOT_TOKEN` and marks it secret. Open-source fork PRs also have a separate public OIDC fallback. This demonstrates an integration entry point for short-lived credential exchange, not the backend's complete trust policy, token TTL, or revocation mechanism. [Action source](https://github.com/depot/setup-action/blob/91bc8495a33ebfc504ffc89e5674379ccf23c29c/src/index.ts#L30).

BuildService returns a separate `build_token`. Machine registration instead uses an AWS instance identity document + signature or Fly OIDC to obtain a task stream and machine token. These identity distinctions support layered permissions and scheduling control rather than every request sharing one long-lived organization key. [Build token](https://github.com/depot/cli/blob/788a3d5373bc5f4bc19f40f8d6148899b763706c/proto/depot/cli/v1/build.proto#L81), [machine registration](https://github.com/depot/machine-agent/blob/f6183c52bb8992d408ad0b246fa87f24a597ed60/src/index.ts#L36).

### 2.5 The BYOC Agent Is a Desired-State Reconciler, Not a One-Time Startup Script

`cloud-agent` reads the current state of cloud resources, requests desired state from the Depot API, then reconciles machine and volume creation/changes. AWS and Fly have different providers. The AWS implementation includes EC2 RunInstances, start/stop/terminate, and EBS gp3 volume create/attach/detach operations. Volume capacity, IOPS, and throughput are parameters supplied by the control plane. The Connect channel configures HTTP/2, a connection token, and keepalive; there is also a loop for updating the agent version. [Reconciliation loop](https://github.com/depot/cloud-agent/blob/727d4b99a6678d48e190d08724715adf013aa731/src/handlers/state.ts#L31), [AWS implementation](https://github.com/depot/cloud-agent/blob/727d4b99a6678d48e190d08724715adf013aa731/src/utils/aws.ts#L55), [HTTP/2 channel](https://github.com/depot/cloud-agent/blob/727d4b99a6678d48e190d08724715adf013aa731/src/utils/grpc.ts#L12).

Volume reconciliation is a separate server stream. The public implementation sets a concurrency limit of 25 and tracks running and recently completed actions; when it cannot acquire the control-plane connection lock, it backs off according to the error code. These are implementation clues for “continuous reconciliation + idempotent resource operations,” not evidence that the entire platform has only one scheduler. [Volume reconciler](https://github.com/depot/cloud-agent/blob/727d4b99a6678d48e190d08724715adf013aa731/src/handlers/volumes.ts#L46).

### 2.6 BuildKit Persistent Caches Have Real Block-Storage Paths; Ceph Is Confirmed but Its Scope Is Limited

cloud-agent contains a complete set of Ceph RBD management calls: namespace, image, snapshot, clone, client credentials, per-namespace auth caps, and sparsify. RBD creation specifies stripe-unit 64K / stripe-count 4, and cloning uses clone format 2. This proves that Depot's public agent supports block-device snapshots/clones and tenant volume authorization paths. It does not prove that every hosted region, every product, or current Depot Metal production block storage uses the same implementation. [Volume lifecycle](https://github.com/depot/cloud-agent/blob/727d4b99a6678d48e190d08724715adf013aa731/src/handlers/volumes.ts#L117), [low-level Ceph calls](https://github.com/depot/cloud-agent/blob/727d4b99a6678d48e190d08724715adf013aa731/src/utils/ceph.ts#L35).

machine-agent receives mount configuration, runs `rbd map` if needed, then formats/mounts ext4, XFS, or Btrfs as the BuildKit root. Non-Ceph paths bind-mount the executor working directory at `/mnt/executor`, showing that persistent cache and temporary execution directories can be placed separately. Shutdown stops BuildKit, runs sync and optional fstrim, unmounts/unmaps storage, then notifies the API that it has exited. [Mount implementation](https://github.com/depot/machine-agent/blob/f6183c52bb8992d408ad0b246fa87f24a597ed60/src/utils/mounts.ts#L9), [executor directory](https://github.com/depot/machine-agent/blob/f6183c52bb8992d408ad0b246fa87f24a597ed60/src/utils/mounts.ts#L169), [shutdown flow](https://github.com/depot/machine-agent/blob/f6183c52bb8992d408ad0b246fa87f24a597ed60/src/tasks/buildkit.ts#L296).

### 2.7 The Machine Agent Exposes BuildKit-Specific Optimization Controls

The BuildKit configuration generated by the examined code includes TCP 443 + a Unix socket, a TLS CA, an OCI worker, the stargz snapshotter, and policies for cache size and retention days, with additional config overrides supported. Tasks can also select a private BuildKit binary, parallel gzip, resolver concurrency, SQLite metadata/cache backends, OTLP tracing, and a profiler. [BuildKit task implementation](https://github.com/depot/machine-agent/blob/f6183c52bb8992d408ad0b246fa87f24a597ed60/src/tasks/buildkit.ts#L16).

The SQLite option here belongs to the **metadata/cache implementation inside a BuildKit machine**. It is not evidence that Depot's platform control database or multiprotocol cache index uses SQLite. Default concurrency and chunk sizes in the configuration should likewise not be treated as platform-wide performance parameters.

## 3. Reasonable Architectural Inferences and Confidence

| Inference | Confidence | Basis and limits |
|---|---|---|
| Depot has a logically separate control plane and multiple data channels | High | BuildService allocates execution connections; the CLI connects to BuildKit; CacheService allocates object URLs. This does not prove that physical deployment is necessarily a microservice cluster |
| The cache metadata API manages key-to-object/segment locations, while larger payloads can go directly through object storage | High | Create/Finalize/GetDownloadURL/GetBundle and the actual presigned PUT helper. Does not prove that every protocol bypasses the cache service for transfer |
| Tool semantics map to underlying storage capabilities through entry type/scope and adapters | Medium-high | Generic cache.proto coexists with a Gocache-specific endpoint. The server adapter registry and all namespace rules were not visible |
| Bundling is an important design for reducing small-object request amplification, not merely improving compression ratios | High | Segment protocol + the official v2 explanation of request overhead; compression format and target size are unknown |
| Build compute resources can be reclaimed while persistent cache volumes retain a separate lifecycle | High (public agent path) | Machines/volumes reconciled separately; disks mounted as BuildKit roots and unmounted on exit; snapshot/clone support. Production policies and retention boundaries are unknown |
| A resource reconciliation layer may encapsulate differences across regions/cloud providers | Medium | AWS/Fly providers, supplied endpoints, and separate volume paths. No evidence establishes a single global scheduler or a specific consistency protocol |
| Management and performance-critical components coexist with different languages/storage technologies | Medium | Go CLI, TypeScript agents, and a separate BuildKit program; **client languages cannot establish closed-source server languages** |

## 4. Limits on FindMissing Performance Conclusions

`CheckEntries(repeated keys)` is direct evidence of a batched query protocol, **not evidence of Depot's server-side `FindMissingBlobs` implementation**. The public code examined cannot answer:

1. Whether REAPI internally calls this CacheService or uses a separate CAS index.
2. How many database accesses a request makes, whether sharding is per tenant, or whether Bloom Filters / in-memory indexes exist.
3. Whether an existence check also establishes a protection window, and how it coordinates with GC.
4. Cache consistency, index rebuilding, handling of incorrect existence results, and measured P95/P99 and digest/s.

What can be learned is the API shape and direction of cost control: batched existence checks, separation of metadata and payload, small-object aggregation, and local disk caching/prefetching. **Depot's product speedup ratios cannot be converted into FindMissing latency promises for expbuild.**

## 5. Lessons for expbuild

- Separate a “cache platform” into shared management capabilities and tool-specific adaptation semantics. Preserve room for types/scopes, prefix restore, related objects, and bundle indexes, but do not treat every tool key as a content digest.
- Prioritize validating the `CheckMany`/FindMissing batch path. Measure existence-index and blob-payload throughput separately; do not substitute RPC/s for digest/s.
- Leave room for client-local caching and bundle interfaces for tools with frequent small-object accesses. The initial version can omit bundles, but the core should avoid the irreversible assumption that one semantic entry can map only to one standalone object.
- Maintain clear boundaries between upload sessions and publication. Before introducing presigned multipart uploads, solve validation, publication, orphan cleanup, and credential permission boundaries; Depot's proto does not disclose these correctness details.
- Enterprise self-hosting can learn from desired-state agents, but “BYOC with a vendor-operated control plane” and “fully offline self-hosting” are different product commitments.
- Plan capacity, recovery, and isolation separately for build execution and persistent cache. Ceph/RBD is one observed implementation, not a reason expbuild P0 must introduce Ceph.

## 6. Still Unknown and Not to Be Presented as Fact

Cache service language, exact table schemas, index types, hot-shard allocation, cache GC algorithms, the scope of physical CAS deduplication, global routing implementation, bundle target sizes/compression/eviction, server-side FindMissing SQL, client-certificate lifetimes, token-revocation propagation, physical network paths for all products, and actual deployment proportions between the public agents and Depot Metal's new architecture. The code in this note neither proves these implementations nor disproves portions already disclosed in other official material.
