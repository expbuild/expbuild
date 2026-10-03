# Proposal for an expbuild WebDAV cache service

Date: 2026-10-01. Status: brief proposal, not yet implemented.

The goal is a small WebDAV service suited to build caching, with native hit statistics, capacity-based eviction, and extensible storage. It reuses a mature protocol library, implements a custom cache core, and integrates as an independent engine with the existing Kubernetes management platform.

## Initial scope

The initial implementation uses Go, with one active service process, separate PVC, and credentials per instance, backed by local files. It implements entry-hit statistics, capacity budgets, eviction by last access time, and optional expiration-based deletion. S3-compatible storage follows, then a local acceleration layer.

WebDAV methods are accepted against real clients, covering at least the directory, read/write, and locking behavior already verified for the current template, with explicit support for related methods such as HEAD, OPTIONS, and UNLOCK. Extensions such as COPY, MOVE, and PROPPATCH are validated and declared separately; partial method support does not justify compatibility claims for all WebDAV clients. This service stores cache data that may be deleted automatically; it does not promise permanent-retention semantics for ordinary file storage.

The existing Apache template remains unchanged. The custom service ships as a new template, with migration considered only after validation. The initial release does not introduce concurrent writes from multiple replicas or a shared entry index across instances.

## Core modules

| Module | Responsibilities and suggested implementation |
|---|---|
| Protocol adapter | Use Go's WebDAV Handler to connect file, directory, and lock operations to the cache core |
| Cache core | Manage entry versions, concurrent reads/writes, capacity, expiration, and eviction |
| Metadata | Record paths, versions, storage locations, sizes, access times, expiration times, and states; persist required directory, property, and lock information |
| Storage adapter | Unified streaming read/write and deletion interfaces; local files first, then S3 |
| Runtime management | Provide health checks, effective policies, status, and Prometheus metrics |

The protocol layer can reuse the Handler, FileSystem, and LockSystem interfaces in [golang.org/x/net/webdav](https://pkg.go.dev/golang.org/x/net/webdav); the service validates authentication, request limits, and client compatibility.

Metadata initially runs as an in-process module, preferably SQLite plus an in-memory hot index. SQLite WAL requires a volume with suitable filesystem semantics and must not be treated as a shared cross-node database; see the [WAL documentation](https://www.sqlite.org/wal.html). Prototype tests determine the database choice and index scale.

The existing [Gradle cache engine](../../operator/internal/gradlecache/server.go) provides references for upload publication, budgets, and counters. When extracting shared modules, preserve each protocol's key, overwrite, and locking semantics rather than directly adopting Gradle's first-write-wins rule.

## Read/write and eviction rules

- **Upload publication**: reserve space and write temporary data first, then commit a visible entry version after durability is established. Interrupted uploads must not expose partial data. Separate data and metadata commits require recovery records and orphan-data reclamation.
- **Read statistics**: distinguish missing entries, read failures, and successful reads. Update access times in memory and persist them in batches; the initial release accepts approximate LRU and does not promise strict global access ordering.
- **Safe eviction**: choose unlocked, reclaimable entries, prevent new read references, wait for existing reads to finish, then delete data for that version. Failures retain pending-cleanup state for retry; a newer overwritten version must never be deleted accidentally.
- **Capacity control**: account for entry budgets separately from actual disk consumption, including upload reservations, temporary files, and data awaiting reclamation. Release the corresponding space only after physical reclamation completes; throttle or reject writes if space cannot be freed.
- **Failure recovery**: on restart, reconcile unfinished uploads, pending-deletion records, and storage objects to restore indexes and capacity accounting. Publication, deletion, and version state must commit reliably; access hotness may recover approximately.

Expiration initially uses a retention duration measured from write or overwrite; the eviction queue uses last access time. Configure the two policies separately, coordinating both with active writes and valid DAV locks.

## Storage and metrics

Each instance initially chooses one primary store, with the cache core managing the complete entry lifecycle. When local SSD acceleration for remote object storage is added later, configure a separate local acceleration budget; cleaning local copies must not delete remote entries.

Initial metrics include entry hits/misses, read/write failures, traffic and latency, entry count and capacity, upload reservations, pending-reclamation space, and eviction counts/bytes by reason. Authentication failures and service failures are not misses; HEAD and directory probes are counted separately.

Tiered storage adds local-acceleration hit rates and remote read volumes. Instance metrics must not use paths or keys as labels; the platform metrics system handles history. Build-task hit rates require client data and cannot be replaced by service-request hit rates.

## Platform integration and implementation sequence

The Operator handles deployment, configuration, credentials, and status; the cache process performs actual eviction. The management API and UI display accurately declared template capabilities and effective policies. Each instance manages its own metadata; the management-platform database does not store per-entry cache records. Rolling updates and failure recovery must guarantee only one active writer per instance.

| Phase | Deliverables | Acceptance focus |
|---|---|---|
| Local storage | WebDAV adapter, metadata, capacity/expiration policies, metrics, new template integration | Real-client reads/writes and locks, overwrites, concurrent eviction, full disks, process interruption, restart recovery |
| Object storage | S3-compatible backend retaining entry policies and metrics | Upload failures, version publication, deletion retries, metadata/object reconciliation, restart recovery |
| Tiered acceleration | Local hot-copy cache with a separate budget | Hit rates for both layers, concurrent origin fetches, cache invalidation, local-space reclamation |

At each phase, measure latency, throughput, memory, and recovery time across entry sizes and concurrency levels before setting resource specifications and performance targets. Before replacement, pass existing platform lifecycle tests and real-client compatibility tests. This proposal does not indicate that these capabilities are already implemented.
