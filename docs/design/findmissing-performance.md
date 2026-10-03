# FindMissing Performance and Reclamation Consistency

Date: 2026-09-28. Status: focused design; not implemented or load-tested. No claim can currently be made about supporting a particular enterprise scale; peak RPC/s, digests per request, active blob count, hotspot distribution, and target hardware are still unknown. This document supplements the P0 contract without changing the decision to use PostgreSQL as the authoritative metadata source.

## 1. Current Implementation and Conclusion

[find_missing_blobs](https://github.com/expbuild/expbuild/blob/a0458e723818f943107c96cbc7a0895237bd06ca/crates/server/src/storage/filesystem.rs#L164) calls [has_blob](https://github.com/expbuild/expbuild/blob/a0458e723818f943107c96cbc7a0895237bd06ca/crates/server/src/storage/filesystem.rs#L45) serially for each digest; the latter calls synchronous `Path::exists()`. Wrapping this in an `async` function does not make file-metadata I/O concurrent or nonblocking; with cold caches and many files, it may block Tokio execution threads. The current path also does not check namespaces and cannot be deployed directly as a multitenant solution.

The new design turns FindMissing into a batch metadata query within an authorized scope. Its normal path does not access FS/S3 or issue SQL queries or object HEAD requests per digest. This approach merits validation for the first enterprise release; measured results determine capacity, and a fixed QPS cannot be inferred merely from having indexes.

## 2. Request Path

1. Parse scope and obtain valid authorization for each RPC; do not call the control plane per digest. Measure initial credential verification separately from cached authorization.
2. Validate the algorithm, length, hex, and size of every digest; deduplicate by `(algorithm,digest,size)` and handle the canonical REAPI empty blob. Different sizes cannot be merged merely because hashes match.
3. Construct an input relation with bounded array parameters and batch-query `blob_identity → blob_visibility → blob_generation`. Fetch only ID, generation, state, and retain_until; do not read payloads, files, or reference closures.
4. Mark `live` rows whose retention already covers the current usage window as present; route other recoverable candidates through the batch renewal described below. Absent objects and those already deleting/deleted are missing. Quarantined corrupt objects follow the established DATA_LOSS policy and cannot produce false hits.
5. Combine the missing response after all chunks finish, then recheck authorization expiry/revocation before returning. Unlike BatchRead/BatchUpdate, FindMissing has no per-item status; invalid input and backend failures use whole-RPC errors. Database timeouts, connection failures, and renewal failures must not degrade the entire response to missing; return retryable errors to avoid triggering full reuploads.

Join against `unnest(bytea[],bigint[]) WITH ORDINALITY` or an equivalent parameterized input table; first verify equal array lengths and non-null elements. SQL chunks of 500, 1,000, and 2,000 digests are initial load-test variables, not client protocol limits. Bound concurrent chunks per RPC and connection-pool waits; do not launch a task for every digest. [PostgreSQL array functions](https://www.postgresql.org/docs/18/functions-array.html)

RPCs also have separate limits for digest count, actual encoded message bytes, and processing deadlines; validate over-limit behavior with native clients. **Capabilities' `max_batch_total_size_bytes` applies to total object bytes in BatchRead/BatchUpdate; the sum of queried object sizes must not limit FindMissing.** An existence query for a very large object is itself small. [In-repository specification](https://github.com/expbuild/expbuild/blob/a0458e723818f943107c96cbc7a0895237bd06ca/crates/proto/proto/build/bazel/remote/execution/v2/remote_execution.proto#L2230)

## 3. GC Protection and Low Write Overhead

REAPI requires recently queried objects to remain available for subsequent use and recommends that FindMissing extend retention when needed. The earlier contract detailed read protection only for GetEntry; this section fills in FindMissing. A SELECT followed by immediate eligibility for GC deletion does not provide reliable integration. [REAPI specification](https://github.com/bazelbuild/remote-apis/blob/main/build/bazel/remote/execution/v2/remote_execution.proto), [frozen repository specification](https://github.com/expbuild/expbuild/blob/a0458e723818f943107c96cbc7a0895237bd06ca/crates/proto/proto/build/bazel/remote/execution/v2/remote_execution.proto#L340)

- Define `use_grace` and a longer `refill_horizon`, calibrating values against real build intervals; experiments may start at 10 and 30 minutes. These are storage-retention parameters, not authorization lifetimes.
- The read-only fast path must prove that the `live` generation's `retain_until` covers **the latest possible completion time of this response + use_grace**. Use the same time basis as GC, a bounded server-side deadline, and clock-skew handling. Comparing only with query start time is insufficient because slow requests would shorten the promised window.
- For candidates with insufficient retention or in tombstoned state, lock identity, generation, and visibility in the metadata contract's stable order, recheck current state/visibility, then conditionally restore and extend retention to cover both the window above and refill_horizon. Report present only after the transaction succeeds; report missing if GC has already won the transition to deleting.
- Renewal only increases retain_until; it does not change reference ownership, double-count usage, or acquire the namespace quota lock. No network I/O or object hashing occurs inside the transaction. P0 does not use a namespace-wide coarse lock shared by all requests on this path.
- Repeated queries with sufficient existing protection do not update access times or create durable per-digest leases/outbox records; protection updates within a batch are combined. Renewal involves real writes, so measure WAL, lock waits, vacuum, and tail latency when many renewals expire together.
- GC must respect committed retention periods and cannot bypass them to reclaim disk. Authorization revocation, explicit administrative deletion, and corruption quarantine may still cause later requests to fail; retention does not guarantee bypassing permissions.

If a multi-chunk RPC fails overall after some renewals, the extra retention may remain; do not shorten already-promised periods to roll back a response. Near the deadline, fail for retry if protection cannot be completed, rather than returning unconfirmed present results.

## 4. Index and Cache Tradeoffs

The existing DDL provides keys for the three-stage query: identity's unique `(tenant,project,namespace,algorithm,digest,size)` index, visibility's scoped blob primary key, and generation's scoped blob+generation primary key. Equality constraints across the full scope fit the current composite-index prefixes; this establishes queryability, not certified performance. [DDL](metadata-schema.sql#L110), [PostgreSQL multicolumn indexes](https://www.postgresql.org/docs/18/indexes-multicolumn.html)

First run `EXPLAIN (ANALYZE, BUFFERS)` for representative batches, examining plans, heap fetches, shared-block hits/physical reads, and query duration; measure WAL and locks separately for renewal. If necessary, evaluate `INCLUDE(id)` on identity's unique index rather than widening indexes redundantly across all three tables without testing. Covering indexes remain affected by the MVCC visibility map; frequently updated retention tables cannot guarantee index-only scans. [PostgreSQL covering indexes](https://www.postgresql.org/docs/18/indexes-index-only-scans.html)

P0 starts with authoritative database queries and no additional existence cache. If a cache is added later:

- Positive cache entries must bind the full namespace, digest+size, specific generation, and protection deadline; a short TTL alone cannot prevent GC races. Authorization is still checked per request; deletion/quarantine needs reliable invalidation.
- A Bloom-filter hit means only “possibly present” and requires exact confirmation; false positives cannot cause clients to skip required uploads. Negative results from a lagging or incompletely rebuilt filter are not authoritative absence either. Define consistency protocols for publication, deletion, and recovery before discussing how many queries a filter saves.
- Read replicas, local KV stores, or asynchronous materialized tables must not confirm present from unchecked stale state; they may enter the fast path only when sufficiently current and backed by still-valid retention evidence.

## 5. Capacity Reporting and Acceptance

The primary load unit is `digest checks/s = RPC/s × digests per RPC`; also report counts before/after deduplication, hit rate, and actual rows renewed per second. For example, 200 RPC/s × 1,000 digests = 200,000 digest checks/s; this is a load conversion, not achieved throughput.

Initial experiment matrix (to be replaced with real projects):

| Dimension | Samples |
|---|---|
| Active blobs per namespace | 1 million, 10 million; 100 million to explore scale boundaries |
| Digests per RPC | 100, 1,000, 10,000; separately test duplicate digests and message limits |
| RPC load | Increase open-loop arrival rates from low to high, recording the first SLO violation; fixed concurrency is supplementary only |
| Hits and locality | 0%, 50%, 99% hit rates; repeated hotspots and uniform random access |
| Data state | Warmed, cold cache, ample retention, concentrated near-expiry |
| Concurrent operations | Upload publication, GC, revocation, recovery, contention between hot and small tenants |

An initial **candidate engineering target** is: same-datacenter RTT≤1ms, reused TLS, warmed authorization, and 1,000 digests per RPC, with end-to-end P95≤20ms and P99≤50ms at the selected pilot's peak load. This neither reuses earlier 1KiB entry-query test results nor promises already-achieved performance. Targets must include CPU/RAM/NVMe, DB parameters, total row count, hit ratio, and renewal ratio; report first client authentication and cold starts separately.

Measure total RPC time, authorization, connection-pool queueing, SQL, renewal, serialization, CPU/I/O, WAL, lock waits, database size, and cumulative FindMissing wait in real builds. Include overload errors, timeouts, and rejected requests; do not count only successful requests and hide queueing. Follow the roadmap requirement for at least 5 reproducible runs and complete environment records.

This FindMissing work is a pilot-release gate for EXP-003/007/012: correct batch SQL/permission isolation, no stale present results from GC races, and latency targets met under target load. If targets are missed, analyze batch size/plans/index residency and renewal write amplification in that order, then evaluate a dedicated query index or sharding with a designed consistency protocol. Naming Redis or RocksDB is no substitute for performance evidence.
