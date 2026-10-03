# Implementation Roadmap, Acceptance, and Migration Plan

Date: 2026-09-28. This document plans future work. The current work completed only static code review, official-source research, and design; none of the following PoCs, interoperability tests, or benchmarks were executed.

## 1. Resource Assumptions and Delivery Cadence

Assume a dedicated team of 4–6: two Rust/storage/protocol engineers, one control-plane engineer, one frontend engineer, and one platform/test engineer, with additional product and security review support. People may cover multiple roles, but the workload does not disappear. Assume no hard production-migration constraints; prioritize Linux servers, with client operating systems determined by the pilot matrix.

The first release covers two ecosystems: REAPI cache-only + Gradle HTTP; sccache may replace Gradle depending on the customer mix. After the first release succeeds, introduce other protocols in batches, labeling each separately as experimental/beta/certified/deprecated. Phases advance on acceptance. The durations below are scheduling ranges, not performance or delivery guarantees.

| Phase | Indicative duration | Deliverables | Exit criteria |
|---|---|---|---|
| M0 / Decisions and PoC | 2–3 weeks | Pilot profiles, protocol/model ADRs, correctness repair list, two native-client PoCs, workload baseline | Core model demonstrably supports both CAS graphs and opaque entries; onboarding/benefit targets preregistered with customers; key risks have mitigation plans |
| P0 / Enterprise pilot release | 8–12 weeks after M0 | Two protocols, FS + one object backend, project permissions, service accounts, quotas/GC, real metrics, private deployment, basic backup/recovery | Core gates pass; real projects in two different ecosystems achieve agreed value targets; customer administrators can take over basic operations |
| P1 / Enterprise general release | Another 6–10 weeks | May ship with the same two ecosystems; OIDC, HA, automated recovery/upgrades, complete onboarding and diagnostic workflows | Selected protocol versions pass acceptance; recovery and authorization-failure tests pass; sustained trial operation and complete operational documentation |
| P1.x / New protocol releases | Separately estimated at 4–8 weeks per batch; may overlap later platform work | Prioritize sccache/Turbo/Bazel HTTP; then Nx/ccache as needed; basic BES/BEP | Each adapter independently certified; experimental features do not block enterprise GA |
| P2 / Extensions and scale | Another 8–12 weeks, divided into batches as needed | Edge, SDK, OCI registry integration, Maven as needed, deeper analytics | Third-party adapters require no kernel changes; revocation/deletion propagate correctly; measurements demonstrate Edge benefits |
| P3 / Remote execution and broader ecosystems | Separate 12–20+ week workstream | Execution-backend integration or persistent-scheduler refactor, isolated workers, dedicated Nix/GHA and other demand-driven work, SaaS readiness | Execution correctness/isolation/failure recovery independently certified; multi-region/billing initiatives commissioned according to customer needs |

Under these assumptions, the pilot release takes about 3–4 months and the enterprise general release about 4–6 months; the comprehensive platform is better managed as a rolling 9–15 month roadmap. With only 1–2 people, reduce simultaneous protocol support and prioritize mature storage and execution engines rather than mechanically committing to the same dates. P3's duration does not include completing every listed optional ecosystem at once.

## 2. Required P0 Scope and Deferred Work

| Required for P0 | Deferred |
|---|---|
| Validated REAPI cache subset and Gradle HTTP | Full remote execution, all digest/compressor types, all optional REAPI RPCs |
| Principal → project → namespace authorization, read-only/write access, separate result-publication permission | Custom ABAC, multilevel organizations, complex approvals |
| Streaming uploads, atomic publication, digest/path validation, limits, reference-safe GC | Content chunking/CDC, P2P, global replication |
| Enterprise-usable deployment, health checks, backup/recovery scripts, real metrics and auditing | Cross-region disaster recovery, fully automated operations, SaaS billing/payments |
| Complete management workflows for onboarding, projects/credentials/quotas/retention/storage/auditing | Plugin marketplace, hot updates, deep miss diffs for every tool |
| Hard storage quotas, object-size/concurrency/rate limits; download usage and soft budgets | Strict cross-node hard limits on total download traffic in P1 according to enterprise needs |

If OIDC is a prerequisite for pilot launch, move it into P0 and cut other features. P0 must support at least manual backup/recovery and complete one drill; P1 adds automated backups, PITR, failover, and formal RPO/RTO. Basic authorization, integrity, or recovery capabilities required for a general release must not be left as “future additions.”

## 3. Initial Work Items, Ready to Become Issues

| ID | Work item / suggested owner role | Dependencies | Reviewable definition of done |
|---|---|---|---|
| EXP-001 | Define compatibility baseline and capability matrix / Protocol | None | Pin remote-apis commit, client release, supported RPCs/compression/digests; every capability derives from the implementation |
| EXP-002 | Repair current input and capability boundaries / Rust | 001 | No unsupported capability declarations; deterministic errors for invalid digest/path; execution cannot be invoked in cache-only mode |
| EXP-003 | Namespace and RequestContext / Rust + Control plane | 001 | The same digest/key cannot bypass authorization across tenants/projects/protocols; BlobVisibility covers direct reads and FindMissing |
| EXP-004 | BlobStore and UploadSession / Rust | 002, 003 | Constant-memory streaming IO, offset validation, commit/abort, cancellation and recovery; concurrent writes of the same digest do not corrupt files |
| EXP-005 | CacheEntry/reference/GC state machine / Storage | 003, 004 | Both opaque and REAPI entries can be published; GC and commit share fencing; missing references cannot produce false hits |
| EXP-006 | IAM/project/service-account/policy APIs / Control plane | 003 | Tokens shown only on creation, revocable/rotatable; roles enforced end to end; policy versions and revocation latency measurable |
| EXP-007 | REAPI native-client validation / Protocol + Test | 004, 005, 006 | Repeated builds with a clean Bazel client hit; error codes, empty files, resume, batch/compression tested within scope |
| EXP-008 | Gradle HTTP adapter / Protocol | 004, 005, 006 | Real Gradle project verifies GET/PUT/404/413, read-only behavior, consistent cold/warm/incremental outputs; no second IAM system |
| EXP-009 | Quota and event ledgers / Rust + Control plane | 005, 006 | Atomic reservation/settlement/release; concurrency does not exceed hard storage limits; usage can be deduplicated and reconciled; errors are not mixed into hit counts |
| EXP-010 | Real end-to-end management console / Frontend | 006, 009 | Onboarding wizard, permissions, quotas, storage, auditing, empty/error states; remove production mock fallback |
| EXP-011 | Private deployment/object backend/recovery / Platform | 004, 005, 006 | Compose/systemd documentation, TLS, health, backend failures, backup/recovery, post-recovery reconciliation and safe GC |
| EXP-012 | Enterprise pilot and performance report / Test + Platform | 007–011 | Two real ecosystems, fixed test environment, negative isolation tests, load/failure reports, explicit remaining limitations |

Complete ADRs first in sequence (protocol boundaries, identity, blob/entry, GC, policy synchronization, plugin trust, deployment), then migrate. Do not begin with large-scale directory changes or a UI rewrite.

Recommended M0 schedule: week one establishes the factual baseline, customer samples, capability declarations, and security-boundary design; week two connects minimal REAPI + Gradle upload/hit paths and measures real traffic; week three addresses GC/upload races and capacity experiments and confirms P0 scope. If critical correctness experiments fail, reduce scope and keep fixing them instead of adding protocols to conceal the problem.

## 4. Release Gates

### A. Protocol and Result Correctness

- Every advertised feature has real-client and protocol-level cases; unadvertised optional features return specification-permitted unimplemented/unsupported statuses.
- Use independent temporary workspaces to eliminate local-cache effects: cold write → warm read on another runner → change one input and rebuild. Verify byte/hash consistency of artifacts in deterministic build fixtures.
- REAPI covers the CAS/AC distinction, zero-byte content, stdout/stderr, Directory/Tree, missing output references, batch per-item status, size limits, offsets, QueryWriteStatus, and compressed-digest semantics.
- Gradle covers opaque keys, Basic/TLS, push permissions, 404/413, Expect-Continue, retries, and errors; record wrapper/JDK/OS in the compatibility matrix.
- Later protocols such as sccache/Turbo/Nx/ccache require separate acceptance. A responding HTTP route is not client compatibility certification.

### B. Isolation and Trust

- Tenant A cannot read/write/probe tenant B's objects, entries, metrics, build records, logs, or exports. The same applies to unshared projects within one tenant.
- Forged client instance_name, teamId, project-filter parameters, or headers cannot bypass authorization.
- Developer credentials cannot publish trusted results; PR tokens cannot preemptively poison the main-branch cache.
- Revocation covers new requests, long streams, resumptions, and commits. Cached authorization must stop working when it expires during disconnection; no anonymous fallback.
- Read/write sizes, compression ratios, directory depth, RPC batches, and concurrency are limited; paths/symlinks cannot escape the root directory.

### C. Persistence and Failure Recovery

- Interrupted uploads, client cancellation, process crashes, concurrent same-key writes, duplicate commits, full disks, backend timeouts, and database disconnections must not produce partially visible entries or permanently leak quota reservations.
- Run GC concurrently with new uploads/reads/reference commits and verify tombstone/version/fencing behavior; never accidentally delete a new generation.
- Recovery test: restore policies/indexes/credentials and a selected object snapshot into an empty cluster; pause GC and writes first, then reopen after reconciliation. Missing blobs are safely invalidated and cannot create false hits.
- P1 tests multiple nodes, rolling node updates, policy delays, database failover, control-plane outages, and duplicate/out-of-order usage events.

### D. Operations and Complete Product Workflows

- Deploy from a clean environment, create a project, generate a token, connect a tool, and observe the first verifiable hit; report total elapsed time and failure points.
- Management actions are audited; production failures show real errors/stale data and never silently display demo data.
- Provide actionable alerts for storage quotas, rates, GC status, backend errors, and data freshness; credentials never enter logs or support bundles.
- Provide executable instructions for protocol versions, backups, upgrades, rollbacks, known limitations, and data deletion.

Customers preregister pilot-value gates in M0: select explicit targets from comparable build wall time, avoided repeated computation, onboarding time, and platform operational effort. P0 reports benefits and added download/storage overhead. A customer administrator who did not participate in development independently performs deployment, token rotation, cleanup, and one recovery drill to confirm operational handover. If evidence does not establish acceptable benefits or operational costs, adjust scenarios/policies first rather than compensating by adding protocols.

## 5. Benchmarking and Capacity Planning

Measure user value before throughput; a single GET QPS figure is not a substitute for build acceleration.

Workload groups:

| Group | Samples | What to observe |
|---|---|---|
| Small objects/high request counts | 1 KiB, 64 KiB; real Bazel CAS distribution | Index/request costs, batch effectiveness, CPU, tail latency |
| Medium archives | 1–16 MiB; real Gradle/sccache archives | Network/decompression costs, concurrent uploads, tiered hits |
| Large files | Configurable boundaries of 256 MiB–1 GiB | Memory does not grow linearly with object size, backpressure, interruption cleanup |
| Real project builds | Cold build, warm build, single-file edit, dependency change, branch switch | CI wall time, task hits, CPU time, transfer and storage costs |
| Mixed tenants | Hot tenants and small tenants in parallel | Fairness, quotas, queue wait, P95/P99 |
| Failures | Full SSD, slow backend, node restart, packet loss, expired authorization | Error classification, bounded retries, recovery, actual client fallback |

Every report fixes and records machine CPU/RAM/disk, network RTT/bandwidth, TLS/connection reuse, object-backend location, object distribution, hit ratio, concurrency, warmup, duration, and client/server versions. Repeat at least five times and report median, P95/P99, and samples rather than selecting only the fastest run.

Initial engineering targets (to be calibrated in M0): same-datacenter RTT ≤1ms, concurrency of 64, warmed connections and L1, 1KiB entry lookups with end-to-end P95 ≤20ms; process memory during large-file transfers constrained by configured concurrency/buffer budgets; cache-service CPU/network overhead substantially below the corresponding local rebuild cost. If a target is irrelevant to the target projects, replace it with a measured break-even point.

P1 may discuss a monthly 99.9% cache-service availability target, but commit only when supported by actual topology, failure drills, and operational data. Cache misses are not service errors; count authorization denials, quota denials, and backend errors separately. Define RPO/RTO separately for IAM/policies/indexes and rebuildable blobs.

Capacity estimates should include:

```text
Persistent capacity ≈ Daily new unique physical bytes × Retention days × Safety factor
                      + Temporary uploads + Object versions/backups + Metadata and logs
Peak egress bandwidth ≈ Peak concurrent downloads × Expected rate per stream
Index size ≈ Active entries + Unique blobs + Visibility/references + upload/lease
```

For capacity arithmetic only: 200GB of new data per day, 14-day retention, and a safety factor of 1.3 imply about 3.64TB for blobs alone, excluding backups/versions/logs. With 300 concurrent downloads each requiring 5MB/s, egress is about 12Gb/s. The latter illustrates why “a fast server” cannot compensate for narrow bandwidth and cross-region networks. Actual deduplication/compression factors must be measured; do not insert advertised ratios into budgets.

## 6. Migrating the Existing Repositories

1. Pin the current baseline and retain a rollback version; see the [current-state report](05-current-state-audit.md) for this audit's baseline. The new planning documents do not modify application code.
2. Retain usable parts of proto, client IO, digest utilities, and test harnesses. Repair capability declarations, input validation, ByteStream, and authorization before introducing the new model.
3. Old CAS/AC lacks reliable tenant provenance. Put it in a read-only isolated legacy namespace by default, or cold-start and rebuild. Migrate only when ownership and content are explicitly verified; never automatically expose old anonymous caches to every new tenant.
4. Add Tenant/Team/Membership/ServiceAccount/Token/Namespace/Policy/Audit/Usage models to the management application. Map old Project owners to membership roles and validate manually/programmatically. SQLite→PostgreSQL requires conversion and validation; do not claim “a seamless migration by changing the connection string.”
5. Old CacheMetric data without project attribution can only remain historical installation-level data with its source identified; do not invent tenant allocation. Bind BuildAgent identities through the new registration workflow; rotate old API keys into scoped tokens stored as hashes.
6. Run old and new endpoints in parallel and switch one pilot project at a time. Do not dual-write across different trust models by default. Old caches are only candidates for authorized read-only upstream fetching; new writes go only into the new model.
7. Observe hits, errors, latency, permission denials, costs, and build outputs; endpoints can be rolled back per project. Use expand/contract schema migration; rollback must not let old services read incompatible new data.

If there are no active users or data to preserve, simplify the process to a cold start with the new structure; do not spend months on nonexistent production-compatibility burdens. Whether production users exist remains unconfirmed and is not assumed to be zero in this research.

## 7. Major Risks and Triggers

| Risk | Early signal | Response / when to adjust |
|---|---|---|
| Continually expanding scope | Every new customer protocol changes the core; milestones lack runnable releases | Fix the first release at two ecosystems; queue new requests or replace existing scope |
| Unsafe or incorrect caching | Cross-project reads, inconsistent artifacts, AC hits with missing blobs | Block release, isolate affected entries, prioritize model and trust-boundary fixes |
| High hit rate but slower builds | Downloading/unpacking costs more than local execution | Analyze task/object-size distributions; use client policies and nearby nodes; do not universally force remote reads |
| GC/quotas become a single bottleneck | Index transaction waits, growing pauses, rising tail latency | Batch touches, partitioning, budget leases; separate index/event databases when benchmarks justify it |
| Protocols change upstream | Current documentation differs from client calls | Pin versions, maintain an official compatibility matrix and release CI; retain a supported-version window |
| Execution consumes cache-iteration resources | Scheduler/isolation fixes dominate development | Separate execution ownership and budget; prioritize mature backends |
| Commercial dependency constraints | Selected public repositories have licenses restricting commercial use | Pin dependency inventories and verify each path; prefer standard interfaces and retain replaceability |
| Management data looks good but is invalid | Mock fallback, unsourced time savings, metrics without scope | Explicitly label unknown/estimated values; unify event definitions and tenant attribution |

## 8. Recommended Architecture Decision Records

Initial ADRs: 001 cache-first and first-release scope; 002 tenants/namespaces/trust domains; 003 Blob/Entry/Visibility model; 004 publication and GC consistency; 005 policy snapshots/revocation/long streams; 006 usage and hard quotas; 007 plugin trust and version contracts; 008 enterprise deployment and recovery; 009 native-tool compatibility matrix; 010 remote-execution build-versus-integrate assessment.

Each records the problem, options, decision, costs, evidence, acceptance criteria, and conditions for reconsideration. When new evidence requires changing a current recommendation, update the ADR and compatibility matrix rather than continually adding implicit configuration switches.
