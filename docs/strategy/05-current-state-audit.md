# Current-State Audit of expbuild and expbuild-admin

Audit date: 2026-09-28. Repository: `/home/ubuntu/work/expbuild/expbuild`. Commit: `a0458e723818f943107c96cbc7a0895237bd06ca`, dated 2025-12-05. The working tree was clean when the audit began.

Admin repository: `/home/ubuntu/work/expbuild/expbuild-admin`; commit: `853a48c521100b89e287f2e98f2f1931f67be495`. The 15 data-plane findings appear first, followed by the admin findings. Planning recommendations throughout are subject to the phase scope in the overview and final roadmap.

Method: directly read production implementations, configuration, interfaces, and tests; README feature claims were not treated as implementation evidence. No compilation, tests, performance testing, or exploit testing was performed. The findings below therefore come from a static code audit and do not indicate successful compatibility tests with real clients. No product code was changed.

Overall assessment: this is currently a Rust REAPI prototype with real CAS/AC reads and writes and a remote-worker path, suitable for refactoring while retaining components. It is not a multi-protocol cache platform, and existing configuration options or management concepts cannot be treated as production capabilities. Correctness and trust boundaries come first, followed by a protocol-independent cache core, tenant/policy context, streaming storage, and a control plane.

## 15 Key Findings

### 1. Reusable REAPI, CAS, AC, and worker layers exist, but the product still supports only one protocol family

- Implemented: Tokio/tonic gRPC services, CAS/AC managers, filesystem CAS and AC, RE client, CLI, Host/Docker executors.
- Evidence: [crates/server-bin/src/main.rs:67](https://github.com/expbuild/expbuild/blob/a0458e723818f943107c96cbc7a0895237bd06ca/crates/server-bin/src/main.rs#L67) registers only Capabilities, CAS, AC, ByteStream, Execution, and a custom WorkerScheduler; [crates/server/src/cas/manager.rs:20](https://github.com/expbuild/expbuild/blob/a0458e723818f943107c96cbc7a0895237bd06ca/crates/server/src/cas/manager.rs#L20) validates SHA256/size for ordinary CAS reads, and `:32` validates ordinary CAS writes.
- Missing: service adapters for HTTP build cache, Gradle, Bazel HTTP, Turborepo, OCI/BuildKit registry, S3-compatible caching, and others; the current product cannot be called “multi-protocol.”
- Plan: retain transport implementations, digest utilities, clients, and test assets; separate protocol adapters from core storage/policy/index interfaces.

### 2. Basic CAS APIs exist, but REAPI details and resource controls are incomplete

- Implemented: FindMissingBlobs, BatchReadBlobs, BatchUpdateBlobs, GetTree.
- Partial implementation: [crates/server/src/grpc/cas_service.rs:49](https://github.com/expbuild/expbuild/blob/a0458e723818f943107c96cbc7a0895237bd06ca/crates/server/src/grpc/cas_service.rs#L49) processes batch writes serially without enforcing the declared total batch-size limit; a missing digest fails the entire RPC early. GetTree at `:140` collects the whole tree before sending, ignores page_size/page_token, and has no tree-size limit.
- SplitBlob at `:175` and SpliceBlob at `:182` explicitly return Unimplemented. Capabilities correctly declares both false, so they are not protocol violations that must be filled immediately.
- Plan: first define the supported REAPI version and feature subset; make error codes, request sizes, compression, pagination/streaming, empty blobs, malformed inputs, and similar cases part of the conformance-test gate.

### 3. Advertised Capabilities differ from the implementation and will break real-client compatibility

- [crates/server/src/config/mod.rs:145](https://github.com/expbuild/expbuild/blob/a0458e723818f943107c96cbc7a0895237bd06ca/crates/server/src/config/mod.rs#L145) advertises ZSTD/DEFLATE by default; [crates/server/src/grpc/capabilities_service.rs:61](https://github.com/expbuild/expbuild/blob/a0458e723818f943107c96cbc7a0895237bd06ca/crates/server/src/grpc/capabilities_service.rs#L61) advertises compression for both ByteStream and BatchUpdate.
- However, [crates/server/src/grpc/cas_service.rs:64](https://github.com/expbuild/expbuild/blob/a0458e723818f943107c96cbc7a0895237bd06ca/crates/server/src/grpc/cas_service.rs#L64) computes SHA256 directly over incoming raw data without decompressing according to compressor; ByteStream `:34` recognizes only blobs paths, not compressed-blobs.
- Capabilities `:25` can advertise SHA1/MD5/SHA384/SHA512, but [crates/server/src/util/digest.rs:5](https://github.com/expbuild/expbuild/blob/a0458e723818f943107c96cbc7a0895237bd06ca/crates/server/src/util/digest.rs#L5) actually hardcodes SHA256.
- `action_cache_update_enabled` / `exec_enabled` affect only advertisements; services are always registered, and their implementations do not read these switches.
- Plan: derive capabilities from actual implementations; prohibit “support by configuration alone.” Prioritize real Bazel/Buck2 and other client interoperability tests over adding more proto definitions.

### 4. ByteStream writes provide neither true streaming persistence nor reliable resume

- [crates/server/src/grpc/bytestream_service.rs:128](https://github.com/expbuild/expbuild/blob/a0458e723818f943107c96cbc7a0895237bd06ca/crates/server/src/grpc/bytestream_service.rs#L128) accumulates the entire upload in a Vec and validates size/hash only at finish_write; it ignores write_offset and subsequent resource-name changes and lacks a hard cumulative upload limit.
- `:23` defines write_states, and `:185` queries it, but production code never inserts or updates it, so QueryWriteStatus cannot report upload progress/completion.
- `:78` casts a negative read_offset directly to u64; reads call blob_store directly, bypassing CasManager validation. Downloads are chunked, but a single stream's channel can queue approximately 100 chunks of 1 MiB each.
- Plan: implement UploadSession, durable commit points, sequence/offset validation, streaming digests, temporary-object commit/abort, backpressure, tenant quotas, and session cleanup.

### 5. There is no tenant isolation or server-side identity boundary; instance_name is merely sent by the client

- [crates/server/src/config/mod.rs:21](https://github.com/expbuild/expbuild/blob/a0458e723818f943107c96cbc7a0895237bd06ca/crates/server/src/config/mod.rs#L21) defines instance_name, but actual server request paths neither validate nor use it; CAS, AC, and execution requests extract only digests or names.
- Interfaces at [crates/server/src/storage/traits.rs:11](https://github.com/expbuild/expbuild/blob/a0458e723818f943107c96cbc7a0895237bd06ca/crates/server/src/storage/traits.rs#L11) and `:42` have no tenant, namespace, principal, or policy context; keys are only REAPI Digest.
- [crates/server-bin/src/main.rs:77](https://github.com/expbuild/expbuild/blob/a0458e723818f943107c96cbc7a0895237bd06ca/crates/server-bin/src/main.rs#L77) starts all gRPC services directly, without authentication interceptors, TLS, permission checks, or a separate worker identity boundary. Client-side TLS support does not establish server-side security capabilities.
- [crates/worker/src/agent.rs:52](https://github.com/expbuild/expbuild/blob/a0458e723818f943107c96cbc7a0895237bd06ca/crates/worker/src/agent.rs#L52) also hardcodes the CAS client to an empty instance_name, tls=false, and no headers.
- Plan: implement principal → organization/project/namespace → read/write/admin policy at protocol entry points; key mappings for different protocols must include namespace; authenticate worker channels separately. Whether to deduplicate underlying content across tenants should be independent of visibility and access control.

### 6. Input paths and digests are not strictly validated at trust boundaries

- [crates/server/src/storage/filesystem.rs:23](https://github.com/expbuild/expbuild/blob/a0458e723818f943107c96cbc7a0895237bd06ca/crates/server/src/storage/filesystem.rs#L23) and [crates/server/src/storage/filesystem_action_cache.rs:23](https://github.com/expbuild/expbuild/blob/a0458e723818f943107c96cbc7a0895237bd06ca/crates/server/src/storage/filesystem_action_cache.rs#L23) use external hashes directly in paths and byte-indexed string slices; without length, hex-character, or nonnegative-size constraints, this creates structural risks of path escape/Unicode-slicing panics.
- Unlike CAS data writes, AC Update does not prove that the hash equals a content digest, so ordinary CAS verify_digest cannot cover this boundary.
- [crates/client/src/client/main_client.rs:552](https://github.com/expbuild/expbuild/blob/a0458e723818f943107c96cbc7a0895237bd06ca/crates/client/src/client/main_client.rs#L552) and `:568` directly join remote Directory node names and write to disk; workers use this code to materialize into host directories before containers start.
- [crates/worker/src/agent.rs:424](https://github.com/expbuild/expbuild/blob/a0458e723818f943107c96cbc7a0895237bd06ca/crates/worker/src/agent.rs#L424) and [crates/worker/src/executor/host.rs:134](https://github.com/expbuild/expbuild/blob/a0458e723818f943107c96cbc7a0895237bd06ca/crates/worker/src/executor/host.rs#L134) likewise join output_path/working_directory directly.
- Plan: make ValidatedDigest and ValidatedRelativePath core types; reject absolute paths, .., invalid node names, and symlink escapes. Directory materialization needs root confinement and tree-size/depth budgets. This audit did not attempt exploitation.

### 7. AC is a simple mutable mapping without reference integrity, write trust, or cache-correctness policies

- [crates/server/src/grpc/action_cache_service.rs:34](https://github.com/expbuild/expbuild/blob/a0458e723818f943107c96cbc7a0895237bd06ca/crates/server/src/grpc/action_cache_service.rs#L34) returns the stored ActionResult directly; `:67` directly accepts callers' results. The manager itself does not own CAS and therefore cannot verify that referenced blobs exist.
- inline_stdout/inline_stderr/inline_output_files requests are not handled, artifact-reference liveness is not checked, and trusted CI writes are not distinguished from developer read-only access.
- [crates/server/src/execution/manager.rs:164](https://github.com/expbuild/expbuild/blob/a0458e723818f943107c96cbc7a0895237bd06ca/crates/server/src/execution/manager.rs#L164) unconditionally writes AC on completion; it does not read Action.do_not_cache or distinguish caching policy for failed exit codes.
- Plan: separate the mutable action/key index from immutable blobs. Jointly design write permissions, reference/visibility checks, result-reproducibility policies, leases/retention references, and stale AC cleanup to avoid “hit but artifacts missing” after GC.

### 8. Only the filesystem backend is complete; persistent-storage concurrency safety and scalability remain inadequate

- [crates/server/src/storage/mod.rs:20](https://github.com/expbuild/expbuild/blob/a0458e723818f943107c96cbc7a0895237bd06ca/crates/server/src/storage/mod.rs#L20), `:23`, `:36`, and `:39` immediately bail for Redis, Tiered, Redis AC, and Memory AC, although configuration can deserialize these options.
- [crates/server/src/storage/filesystem.rs:84](https://github.com/expbuild/expbuild/blob/a0458e723818f943107c96cbc7a0895237bd06ca/crates/server/src/storage/filesystem.rs#L84) uses a fixed CAS temporary filename; AC at `filesystem_action_cache.rs:69` does the same, so concurrent writes to the same digest/action contend for temporary files.
- BlobStore has streaming read/write interfaces, but ordinary interfaces still use Vec. Streaming writes verify length but not hash; the main ByteStream write path does not use streaming writes. Ordinary writes do not fsync, and corruption/missing-storage errors are primarily handled as strings.
- Plan: use filesystem storage for development and node L1, and add S3-compatible object storage for production. Separate metadata/indexes from blobs; first define commit conditions, idempotent writes, unique temporary objects, corruption detection, verification, and recovery. Do not view caching large objects in Redis as the only scaling path.

### 9. Lifecycle, operational management, and service observability do not yet form complete workflows

- [crates/server/src/config/mod.rs:153](https://github.com/expbuild/expbuild/blob/a0458e723818f943107c96cbc7a0895237bd06ca/crates/server/src/config/mod.rs#L153) defines GcConfig, but service startup and manager code do not use config.gc; there is no GC scan/mark/sweep, capacity watermarks, TTL enforcement, or tenant quotas.
- AC touch updates timestamps and a CAS touch interface exists, but there is no lifecycle controller; worker working-directory cleanup at [crates/worker/src/agent.rs:514](https://github.com/expbuild/expbuild/blob/a0458e723818f943107c96cbc7a0895237bd06ca/crates/worker/src/agent.rs#L514) is commented out.
- [crates/server-bin/src/main.rs:93](https://github.com/expbuild/expbuild/blob/a0458e723818f943107c96cbc7a0895237bd06ca/crates/server-bin/src/main.rs#L93) initializes tracing logs. No server-side Prometheus/OTel metrics export, health/readiness service, audit events, management API, tenant CRUD, configuration versions, or database migrations were found.
- Plan: metrics should include at least protocol/tenant hit rates, byte hits, p95/p99 latency, transferred bytes, rejected writes, GC reclamation and safety skips, backend errors, and saved build time. Admin needs real control APIs and audit records, not pages assembled solely from logs.

### 10. The scheduler is an in-memory prototype; its leases do not provide failure recovery

- [crates/server/src/execution/scheduler.rs:14](https://github.com/expbuild/expbuild/blob/a0458e723818f943107c96cbc7a0895237bd06ca/crates/server/src/execution/scheduler.rs#L14) stores queues, workers, leases, and results in process-local collections; restarts lose state, and consistent multi-replica scheduling is impossible.
- `:349` only deletes expired leases, explicitly logging “would requeue in production”; it does not requeue or generate a failure result. Heartbeats refresh workers but do not renew task leases.
- `:89` is FIFO; priority is unused for queue ordering. There is no per-project fair scheduling, idempotent deduplication, or persistent recovery. Worker max_concurrent_executions is not enforced on the server lease path.
- Plan: if the cache platform comes first, retain Execution as a separate experimental module. Production remote execution needs a full design for durable state machines, lease renewal/fencing, attempt ids, retries/timeouts/cancellation, fair queues, and worker identities.

### 11. Execution semantics contain errors that waste builds and leave requests hanging

- [crates/server/src/execution/manager.rs:110](https://github.com/expbuild/expbuild/blob/a0458e723818f943107c96cbc7a0895237bd06ca/crates/server/src/execution/manager.rs#L110) marks an operation done after an AC hit, but after `:188` returns, it still unconditionally constructs a task and submits it at `:204`; a cache hit therefore still triggers redundant execution.
- `:83` always sets ExecuteResponse.cached_result to false.
- `:198` fixes platform to None, timeout to 3600 seconds, and priority to 0 rather than extracting actual constraints from Action/ExecuteRequest.
- `:217` only logs worker Failed and exits the monitoring loop without completing the operation with an error; lease loss likewise cannot complete it. `grpc/execution_service.rs:54` polls every second and does not exit after send failure; operations are not reclaimed.
- Plan: first turn Operation into a durable state machine with explicit terminal states. Every success/failure/cancellation/disconnection path must terminate within a bounded time. Cache hits must not enter the execution queue.

### 12. Worker isolation has interfaces and a Docker foundation, but cannot support untrusted multi-tenant execution

- [crates/worker/src/executor/mod.rs:19](https://github.com/expbuild/expbuild/blob/a0458e723818f943107c96cbc7a0895237bd06ca/crates/worker/src/executor/mod.rs#L19) implements TaskExecutor. Docker `executor/docker.rs:172` configures CPU, memory, pids, readonly rootfs, network_mode, and non-privileged operation; this is actual code, not just a design document.
- Host at [crates/worker/src/executor/host.rs:148](https://github.com/expbuild/expbuild/blob/a0458e723818f943107c96cbc7a0895237bd06ca/crates/worker/src/executor/host.rs#L148) uses the host Command without env_clear. The so-called whitelist at `:77` copies all requested environment variables when filtering yields none. Timeouts use timeout(cmd.output()) without kill_on_drop/process-group cleanup.
- Docker `:135` merges NetworkPolicy, but actual execution at `:177` uses only the global network_mode; working_directory at `:170` is fixed to /workspace. Disk limits are not implemented (capabilities correctly declares false).
- Docker `:187` sets auto_remove=true, but logs and artifacts are read only after waiting for exit after `:386`. Automatic container removal therefore creates a race risk of losing logs/artifacts; this was not dynamically validated.
- Plan: prohibit Host executors for public/untrusted workloads by default. Define the tenant trust model before choosing containers/micro-VMs and resource/network policies; real Docker failure-path tests are needed.

### 13. Output and directory-tree protocols have specific compatibility gaps

- [crates/worker/src/agent.rs:553](https://github.com/expbuild/expbuild/blob/a0458e723818f943107c96cbc7a0895237bd06ca/crates/worker/src/agent.rs#L553) immediately continues on empty contents, losing zero-byte output files.
- `:581` collects only the old output_directories field; directories in modern output_paths are not collected the same way. Host returns only is_file artifacts.
- upload_directory_tree_from_path at `:587` actually returns a Directory digest (`crates/client/src/client/main_client.rs:507`), but `agent.rs:595` puts it in both tree_digest and root_directory_digest. REAPI Tree and Directory objects do not have the same encoding.
- `crates/client/src/client/main_client.rs:529` does not handle symlinks when downloading directory trees; `crates/client/src/action/directory.rs:107` constructs them with empty symlinks. Execution metadata start/end times are both generated after execution completes (agent.rs:463).
- Plan: real third-party clients should test zero-byte files, nested output directories, executable bits, symlinks, working directories, Tree and Directory semantics, failure artifacts, and timing.

### 14. Extension boundaries are worth retaining, but current interfaces bind the core to REAPI types

- [crates/server/src/storage/traits.rs:2](https://github.com/expbuild/expbuild/blob/a0458e723818f943107c96cbc7a0895237bd06ca/crates/server/src/storage/traits.rs#L2) directly depends on REAPI Digest/ActionResult. Separating BlobStore from ActionCacheStore is a good start, but it is not a platform-level Key/Blob/Manifest/Policy model.
- `TaskExecutor` supports execution-backend extension; the storage factory is a closed enum match. There is no protocol registration, extension capability negotiation, plugin versioning/permissions/isolation, extension configuration schema, or hooks.
- Plan: use compile-time Rust traits and separate adapter crates in the near term, then offer out-of-process gRPC plugins after stabilizing internal APIs. Do not initially promise an open ecosystem through a dynamically loaded Rust ABI. BlobStore should support streaming put/get, range, stat, and commit/abort, with a separate namespace-aware CacheIndex/ManifestStore; REAPI ActionResult can remain a protocol-specific payload.

### 15. A real integration-test framework exists, but coverage cannot demonstrate production correctness

- [tests/Cargo.toml:10](https://github.com/expbuild/expbuild/blob/a0458e723818f943107c96cbc7a0895237bd06ca/tests/Cargo.toml#L10) and `:15` actually register 2 integration-test targets. The harness starts a local gRPC server and Host worker; it is not all mocks.
- There are 4 CAS integration cases and 3 execution cases, covering basic small/large blobs, directories, and echo/file output/exit 42.
- [tests/integration/test_cas_operations.rs:116](https://github.com/expbuild/expbuild/blob/a0458e723818f943107c96cbc7a0895237bd06ca/tests/integration/test_cas_operations.rs#L116) is named test_find_missing_blobs, but `:138` and `:141` only call download_blob and never call the FindMissingBlobs RPC.
- No coverage was found for real Bazel/Gradle or other client interoperability, ByteStream resume, cross-namespace isolation, GC reference consistency, concurrent same-key writes, corrupt data, lease loss, restart recovery, Docker execution, authentication, or quotas. Worker tests mainly cover Host echo/health/capabilities and enum defaults.
- Plan: establish a protocol conformance suite + native-client smoke tests + data-integrity/security negative cases + network-disconnection/restart/backend-failure tests. Existing tests were not run in this audit and cannot be described as passing.

## Direct Recommendations for Replanning

1. Make “trusted, operable multi-protocol caching” the first-phase focus. Give remote execution separate milestones rather than squeezing secure-isolation and scheduling-system complexity into the cache MVP.
2. Minimal platform core: RequestContext(principal/tenant/namespace/protocol), ValidatedDigest, immutable BlobStore, mutable CacheIndex, object references/retention policies, UploadSession, Quota/Policy, Metrics/Audit.
3. Select only 2–3 protocols with high demonstrated value for the first batch: REAPI cache (fix correctness first), Bazel HTTP/Gradle (each needs its own key and authentication conventions), with Turborepo as a possible second batch. Treat OCI/BuildKit as a separate registry adapter/integration; merely mapping blobs does not establish support.
4. The management plane owns organizations/projects, credentials and RBAC, quota/retention policies, hit/capacity analysis, protocol instances, backend configuration, auditing, and operational tasks. High-frequency data-plane reads/writes must not be held back by synchronous management-database writes.
5. Retain client transport, proto, trait layering, the file backend, Docker foundations, and the integration harness. Refactor the tenant-aware core, capability advertisements, streaming writes, lifecycle, and scheduling state machine instead of piling more switches onto existing fields.

## Actual Completion Status of expbuild-admin

### A1. Frontend and backend foundations exist, but there is no real organization-level multi-tenant model

React pages, Express APIs, JWT login, project CRUD, pipeline reporting, and the Prisma database are not purely static mocks and are worth retaining. The current model has a User owning multiple Projects rather than organizations, members, teams, projects, and service accounts. A Project directly stores one plaintext apiKey; there is no independent token lifecycle, scope, or multiple CI identities. See [schema.prisma](https://github.com/expbuild/expbuild-admin/blob/853a48c521100b89e287f2e98f2f1931f67be495/server/prisma/schema.prisma#L13) and [project creation](https://github.com/expbuild/expbuild-admin/blob/853a48c521100b89e287f2e98f2f1931f67be495/server/src/routes/projects.ts#L34).

Design documents describe PostgreSQL in production, but the actual schema provider is sqlite; there is no evidence of a completed production PostgreSQL migration. A new data model and migration plan are needed; the README's target architecture must not be treated as an operational capability.

### A2. Project filtering has a path that overrides authorization scope

The pipeline list initially restricts where.projectId to the current user's project set, but a supplied projectId directly overwrites that condition without checking that the specified project remains authorized. This creates a structural risk of cross-project list exposure; it is a static-code finding, not a dynamically exploited issue. See [pipeline.ts](https://github.com/expbuild/expbuild-admin/blob/853a48c521100b89e287f2e98f2f1931f67be495/server/src/routes/pipeline.ts#L16) and [condition override](https://github.com/expbuild/expbuild-admin/blob/853a48c521100b89e287f2e98f2f1931f67be495/server/src/routes/pipeline.ts#L24).

The new query layer should enforce the intersection of authorization scope and user filters consistently for details, lists, search, and exports. It cannot rely on every route developer remembering to add ownerId manually.

### A3. CacheMetric has no project ownership, so statistics cannot be reliably isolated by tenant

The reporting endpoint verifies the Project associated with an apiKey but does not save projectId when writing CacheMetric. GET /cache queries only by time, and the dashboard aggregates recent metrics across the entire database. Thus, even with login protection, different users may see the same cache statistics. See the [model](https://github.com/expbuild/expbuild-admin/blob/853a48c521100b89e287f2e98f2f1931f67be495/server/prisma/schema.prisma#L67), [metric writes](https://github.com/expbuild/expbuild-admin/blob/853a48c521100b89e287f2e98f2f1931f67be495/server/src/routes/metrics.ts#L54), and [global aggregation](https://github.com/expbuild/expbuild-admin/blob/853a48c521100b89e287f2e98f2f1931f67be495/server/src/routes/metrics.ts#L108).

savingsSeconds is supplied directly by the reporter; it cannot be established whether it means CPU savings, wall-clock difference, or a manual estimate. The existing dashboard is not evidence of actual acceleration. Event source, definition, baseline, aggregation, and confidence fields are needed.

### A4. Agent heartbeats are unauthenticated, and the node list has no tenant scope

POST /heartbeat uses neither authenticate nor API-key verification; upsert by hostname can modify existing node status. GET requires login but queries all BuildAgent records. The model has no tenant/project/pool foreign keys. See the [node list](https://github.com/expbuild/expbuild-admin/blob/853a48c521100b89e287f2e98f2f1931f67be495/server/src/routes/agents.ts#L9) and [heartbeat](https://github.com/expbuild/expbuild-admin/blob/853a48c521100b89e287f2e98f2f1931f67be495/server/src/routes/agents.ts#L35).

Use registered machine identities and instance IDs instead, with hostname only for display. Node ownership, heartbeat permissions, lost-contact status, and drain commands should be part of one complete management workflow. There is no implementation evidence that the existing Rust worker automatically integrates with this API.

### A5. The UI uses real APIs but still mixes in demo values and hides errors

dataService generates fake 10.0.x.x IPs for agents, fixes CPU/memory to 0, and treats time since the last heartbeat as uptime. Pipeline buildNumber, initiator, and Jenkins URL are also frontend placeholders. Failed metrics/pipelines requests return MOCK data directly. See [agent mapping](https://github.com/expbuild/expbuild-admin/blob/853a48c521100b89e287f2e98f2f1931f67be495/services/dataService.ts#L36), [metrics fallback](https://github.com/expbuild/expbuild-admin/blob/853a48c521100b89e287f2e98f2f1931f67be495/services/dataService.ts#L56), and [pipeline mapping](https://github.com/expbuild/expbuild-admin/blob/853a48c521100b89e287f2e98f2f1931f67be495/services/dataService.ts#L75).

Pages, charts, layouts, and type organization can be reused, but the data model and failure states need rebuilding. Production must not display “unknown resource utilization” as “0%” or disguise service failures as healthy demo data.

### A6. Quotas only check build-report counts and cannot constrain cache resources

pipeline report first reads usedBuilds and monthlyQuotaBuilds, then creates a record, then increments the count. This is not an atomic quota reservation in one transaction, and retries have no idempotency key. Although schema names say monthly, the current route has no monthly billing-period or reset model. See the [quota check](https://github.com/expbuild/expbuild-admin/blob/853a48c521100b89e287f2e98f2f1931f67be495/server/src/routes/pipeline.ts#L112) and [separate increment](https://github.com/expbuild/expbuild-admin/blob/853a48c521100b89e287f2e98f2f1931f67be495/server/src/routes/pipeline.ts#L136).

At most, this is a prototype report-count limit, not a quota for storage/bandwidth/object count/concurrency/execution resources. Resource admission enforced by the data plane and a reconcilable ledger are required; adding admin quota fields alone is insufficient.

### A7. Authentication and platform operations are not yet complete enterprise capabilities

When JWT_SECRET is unset, a fixed development default is used; production should reject this configuration. There is currently no evidence of complete implementations for independent role-authorization middleware, team membership, token scope/rotation/revocation, SSO, auditing, or configuration versioning. See [authentication utilities](https://github.com/expbuild/expbuild-admin/blob/853a48c521100b89e287f2e98f2f1931f67be495/server/src/utils/auth.ts#L5) and [authentication middleware](https://github.com/expbuild/expbuild-admin/blob/853a48c521100b89e287f2e98f2f1931f67be495/server/src/middleware/auth.ts#L16).

“Login” and “SaaS” on management pages do not establish enterprise IAM or SaaS isolation. Control- and data-plane authentication, policies, and events should currently be planned as new contracts yet to be established.

## Reuse and Refactoring Decisions

| Asset | Recommendation | Rationale |
|---|---|---|
| Rust/Tokio/tonic, proto, client IO | Reuse selectively | Technical direction fits, but interface semantics and capability advertisements need alignment |
| File storage and existing traits | Adapt | Retain basic IO; add scope, streaming commits, integrity, and backend capabilities |
| REAPI services | Fix item by item against the actual specification and tests | Existing service registration is not compatibility certification |
| In-memory scheduler/worker | Keep experimental for now; refactor/integrate separately later | Major gaps in durable state, failure recovery, isolation, and result formats |
| React pages/layouts/charts | Reuse visual and component foundations | Product information architecture, real data, and error states need adjustment |
| Express/Prisma framework | May be retained | No need for an immediate rewrite merely to unify languages; rebuild domain models and authorization layers |
| Current database model and API-key design | Refactor and migrate | Lacks organizations/namespaces/service accounts/reliable usage and isolation fields |
| Existing docs and tests | Retain as historical evidence; update claims and expand effective cases | Avoid mistaking historical goals for current capabilities |

This round changes no product code and does not imply that the issues above are fixed. Implementation should address correctness and permissions before adding protocols.

Release metadata also needs cleanup: expbuild's root LICENSE is actually MIT, while the README describes MIT/Apache dual licensing and links to currently missing LICENSE-MIT/LICENSE-APACHE files. No independent LICENSE was found among expbuild-admin's tracked project files in this audit. Before commercialization, maintainers should confirm intent, rights provenance, and distribution licensing rather than simply carrying forward the README's dual-license claim. This records file inconsistencies only; it does not infer a license to use code without authorization. [Current LICENSE](https://github.com/expbuild/expbuild/blob/a0458e723818f943107c96cbc7a0895237bd06ca/LICENSE#L1).
