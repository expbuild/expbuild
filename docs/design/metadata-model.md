# P0 Metadata Model, Transactions, and Reclamation Protocol

Date: 2026-09-28. Status: design draft ready for implementation review; not yet deployed. The accompanying [metadata-schema.sql](metadata-schema.sql) is a DDL skeleton for an empty database, not a migration script for the current Prisma/SQLite or Rust cache.

The scope remains enterprise self-hosting first, REAPI cache-only + Gradle HTTP, and PostgreSQL + FS/one S3 backend. This iteration further narrows the deduplication scope in the long-term plan: **P0 physical deduplication occurs only within the same namespace**. Future explicit sharing requires separate authorization and data-model evolution; it will not be implemented by changing ownership of existing namespaces.

## 1. Decisions Ready for Implementation

1. All persistent data-plane objects include `(tenant_id, project_id, namespace_id)`, obtained from a trusted RequestContext. Client paths resolve only a candidate namespace and cannot override authenticated scope.
2. A namespace's `protocol_id` and `trust_domain` are fixed at creation and cannot be switched in place. Matching trust_domain labels grant no sharing permissions; identical keys in REAPI and Gradle are not equivalent.
3. BlobIdentity represents the SHA-256 and logical size of validated bytes; BlobGeneration represents an actual durable copy; BlobVisibility represents the current namespace's access eligibility and independent CAS retention period. These three cannot be merged.
4. The current CacheEntry version occupies one row, with an increasing `generation`; replacement requires a conditional commit, with old references replaced in the same transaction. Reads already initiated are protected independently by retention/leases on specific blob generations.
5. Hard namespace storage quotas count the logical bytes of each unique visible BlobIdentity once; blob-object and entry counts have separate limits. Uploads reserve conservatively first and release the balance on successful deduplication. P0 download statistics and soft budgets do not claim to be cross-node hard download limits.
6. Upload sessions bind to a principal and a **specific credential ID**. A new token for the same principal cannot inherit an old session; restart the upload, or later use an explicitly designed transfer procedure.
7. Quota, visibility, entry references, committed results, and critical outbox events settle in one PostgreSQL transaction. Storage writes complete before the transaction; objects not accepted by the transaction enter orphan reclamation.
8. GC deletes the unique locator of a specific generation; a generation cannot be revived after entering `deleting`. New uploads use new generations/locators, preventing old cleaners from deleting new objects.

In P0, `trust_domain` is fixed to one of `trusted-ci / internal-dev / isolated-pr` and belongs to the current namespace; there is no separate cross-project trust-domain sharing graph. Trusted CI and external PRs use different namespaces. Expanding deduplication requires adding a shareable isolation-domain table and implementing authorized references first.

## 2. Responsibilities and Boundaries of the 16 Tables

| Schema / table | Key responsibility | Who may write |
|---|---|---|
| `expbuild_cp.tenant` | Tenant identity, status, monotonic `authz_epoch` | Control plane |
| `expbuild_cp.project` | Actual tenant→project parent relationship | Control plane |
| `expbuild_cp.principal` | Parent table for user/service_account/system principals within a tenant | Control plane |
| `expbuild_cp.credential` | Token ID, principal binding, expiry and revocation facts | Control plane |
| `expbuild_cp.policy_version` | Append-only policy versions and epochs | Control plane |
| `expbuild_cp.namespace` | project→namespace, fixed protocol/trust domain, current policy | Control plane |
| `expbuild_cache.quota_account` | Namespace quota, used/reserved bytes and blob counts, entry count | Quota-domain transactions; the control plane calls domain interfaces to configure quotas |
| `expbuild_cache.quota_reservation` | Upload-budget ownership, expiry, idempotent settlement | Data plane/recovery worker |
| `expbuild_cache.upload_session` | Upload offset, durable checkpoint, writer fence, and committed result | Data plane/recovery worker |
| `expbuild_cache.blob_identity` | Unique content identity within a namespace | Data plane |
| `expbuild_cache.blob_generation` | Immutable durable locator, health, and GC state | Data plane/GC |
| `expbuild_cache.blob_visibility` | Visibility established through authorized upload; retention of a specific generation | Data plane/GC |
| `expbuild_cache.cache_entry` | Tool key, current generation, protocol payload, write provenance | Data plane |
| `expbuild_cache.entry_reference` | Complete set of required blob references for the current entry | Entry commit/invalidation transactions |
| `expbuild_cache.blob_lease` | Short leases on specific generations for active reads | Data plane |
| `expbuild_cp.audit_outbox` | Critical facts and asynchronous event-delivery cursors | Appended by the relevant domain transaction; dispatcher changes delivery columns only |

These are domain responsibilities; they do not mean the data-plane database account may modify every control-plane table. The final migration needs database roles, column/table permissions, connection pools, and query budgets. The current DDL neither configures production credentials nor claims enforced isolation through RLS.

For the full control-plane User, Membership, Team, RoleBinding, ServiceAccount attributes, Token verifier/pepper, authentication sessions, API idempotency records, and cleanup jobs, see the [control-plane contract](control-plane.md); later migrations will add them. The `principal` here is a per-tenant principal projection: the same global User joining two tenants produces two separate principal bindings. Credential verifiers remain exclusively in the control plane and are never sent to the data plane.

`backend_id` is resolved through the administrator's storage-configuration registry; ordinary clients cannot provide backend addresses. That configuration table is not yet included in this minimal index DDL. Add a real FK when incorporating it into production migrations, or validate through a versioned configuration service. All current tenant/project/namespace, principal/token, policy, and cache-reference FKs point to tables present in the draft.

## 3. Composite Keys and Immutable Boundaries

Data-plane foreign keys never use bare `blob_id`, `entry_id`, or `project_id` alone. For example:

```text
project                  PK (tenant_id, id)
namespace                PK (tenant_id, project_id, id)
blob_identity            PK (tenant_id, project_id, namespace_id, id)
blob_generation          PK (tenant_id, project_id, namespace_id, blob_id, id)
blob_visibility          UNIQUE (tenant_id, project_id, namespace_id, blob_id, generation_id)
entry_reference          FK → cache_entry(..., id, generation)
                         FK → blob_visibility(..., blob_id, generation_id)
credential               UNIQUE (tenant_id, principal_id, id)
upload_session           FK → credential(tenant_id, principal_id, id)
                         FK → quota_reservation(scope, reservation_id, principal_id, credential_id)
```

Thus, supplying a real namespace belonging to another project, or attaching another principal's reservation to the current token, is rejected by FKs. Applications must still include full scope in query conditions; FKs do not constrain `SELECT` and are not an authorization policy.

SQL immutable triggers prevent changes to a namespace's tenant/project/protocol/trust, a BlobIdentity's digest/size, a BlobGeneration's locator/version, and a session's principal/token/target. PolicyVersion records are append-only. An Entry's scope/key are fixed; generation/payload/provenance change through replacement transactions.

P0 fixes SHA-256, uncompressed logical digests, and identity backend encoding; S3's own encryption does not change protocol digests. Future digests/encodings require compatibility-matrix updates and migrations, rather than being advertised in capabilities ahead of implementation. The SQL key limit of ≤512 bytes is a starting point for index-design review. Application configuration limits protocol payloads, total references, directory depth, and parsing budgets; the DDL does not duplicate these with another fixed payload limit. After protocol PoCs calibrate budgets, record them in versioned deployment configuration. Database drivers/request decoders must also cap transmitted parameters and statement budgets; sending oversized payloads straight to SQL before checking is forbidden. Keys, payloads, and reference lists must not be truncated. `invocation_id` only associates client-provided build context; it does not participate in hit keys, authorization, or full pipeline attribution.

## 4. Blob Visibility, References, and Reads

### Determining Visibility

`FindMissing`, direct CAS reads, BatchRead, and result publication authorize independently, then query BlobVisibility and BlobGeneration in the same namespace. An object existing in the physical backend, or even an existing BlobIdentity, cannot alone constitute a hit. Obtaining visibility for the first time requires a full upload and byte validation; P0 exposes no interface to add someone else's blob to a namespace merely by knowing its digest.

A serviceable object must at least have visibility, a healthy readable generation, and authorization. Retention roots come from still-valid entry references, `visibility.retain_until`, or active `blob_lease` records. Expiry only makes an object eligible for reclamation; retention may be restored according to protocol and policy if the data is still intact and irreversible deletion has not begun. Retention cannot restore tenant deletion, revoked authorization, or corruption quarantine.

FindMissing also provides a short usage window: live objects whose retention covers the response deadline plus grace may be confirmed read-only. Other candidates must be revalidated and renewed/restored under the same GC locking protocol before returning present; an unprotected tombstone cannot count as a hit. Queries and renewals are batched. This path does not increase usage and does not acquire the namespace quota lock; see the [focused design](findmissing-performance.md).

### Zero-Byte Objects

The canonical REAPI SHA-256 empty digest (size 0) is treated as a virtual core constant. Authorization and namespace routing must still succeed, but no BlobIdentity/Generation/Visibility is created, no bytes or blobs are counted, no durable read lease is acquired, and it is excluded from entry_reference. Protocol payloads retain the original empty digest; OpenBlob returns a virtual empty handle. After recognizing the canonical empty digest, reference enumeration excludes it from the durable closure; other invalid size-0 digests are not treated as constants. Empty writes still follow resource-name, offset, and native early-completion rules; validation cannot be waived arbitrarily. This rule does not extend to Gradle: if client validation shows zero-length archives are valid, retain their blobs/references as ordinary opaque entries and count them toward blob and entry counts, with zero logical bytes.

### Entry Reference Closure

Gradle has one required blob reference per archive. For REAPI, the adapter validates ActionResult and enumerates all required stdout/stderr, output files, Tree/Directory objects, and leaf-file content, recording the complete required closure for the actual representation returned. The same blob is recorded once per entry. Whether inline bytes enter CAS is determined by the pinned protocol agreement; the service cannot declare successful inlining while omitting required content.

At commit, verify that references exist and are visible. Reference counts, directory depth, total parsed bytes, and CPU are all bounded; exceeding a limit fails explicitly. An entry without a complete closure cannot be marked `ready`. The REAPI adapter's compatibility matrix determines scope and real-client use cases.

### Protection Window After Returning a Result

Before `GetActionResult/GetEntry` returns a result, lock the current entry version and its indexed blob generations, recheck states, extend the corresponding `visibility.retain_until` to `max(current_value, now + metadata_fetch_grace)`, and commit. Even if the entry is subsequently replaced, this independent window still protects its old blobs.

This is O(reference count) batched index work, without recursively parsing the directory tree on every read. P0 reference-count limits and initial grace values are calibrated by PoC, starting with bounded batch updates. If high ActionResult GET volume creates hot-row contention, retention can be extended sufficiently in advance and redundant updates skipped within a safe interval; skipped requests must still receive the full promised window. Sampled access times cannot substitute for protection.

Before an actual blob stream begins, create a `blob_lease` under the generation row lock, expiring no later than the current authorization lease/request deadline. Long streams periodically reauthorize and renew their protection leases; expiry, revocation, or renewal failure terminates the read. GC lease protection grants no permissions. A finite grace period cannot guarantee content remains available after an arbitrary client delay; missing content beyond the window follows the native protocol.

## 5. Uploads and durable_offset

```text
open → receiving → verifying → publishing → committed
  └───────────────→ aborted / expired
```

1. Normalize the resource and uniquely look up/create a CAS session by `(scope,client_upload_uuid,expected_digest,expected_size)`; uploading different blobs under the same UUID is valid. Internal session IDs are not client UUIDs, and QueryWriteStatus uses the same composite mapping after restart. Existing sessions require owner/token checks; their state must not leak to conflicting principals. Validate protocol input and the current AuthorizationLease, confirming tenant epoch, namespace status, operation permissions, and object limits.
2. Lock quota_account and atomically create the reservation and session. REAPI reserves the expected logical size. Gradle reserves Content-Length when available; otherwise, reserve a bounded window initially and expand it before accepting more bytes. Every nonempty upload initially reserves quota for 1 blob; release that reservation of 1 if final deduplication succeeds. Canonical zero-byte objects use the virtual path, without an upload session or reservation.
3. `durable_offset` denotes only the contiguous byte count recoverable after a server crash. All P0 backends first write to local durable staging and checkpoint according to a defined fsync policy. `staging_node_id` binds to a fixed node, and recovery requests must return there; they cannot continue writing to a same-named path on another node. Permanent node/volume loss invalidates the old session, releases its reservation, and requires a new upload; cross-node resumption is not promised. When needed for durable S3 publication, `backend_cursor` stores the internal multipart upload ID/part list, never secrets. Direct resumption at S3 multipart part boundaries is deferred for separate later validation.
4. Every resume, QueryWriteStatus, write, and commit revalidates the current principal/token and performs conditional updates using `writer_fence`, owner, and lease. Takeover increments the fence. **A database fence cannot stop an expired process from continuing to write bytes to the same staging file**, so every takeover uses a new staging locator containing the new fence and continues after copying/restoring the acknowledged prefix. The old attempt can contaminate only its own staging path.
5. The digest may be recomputed from the durable prefix and then continue streaming; P0 does not depend on a library's internal hasher serialization format. Declared length must match the final byte count; unknown lengths are determined from the completed upload. After validation, publish the uploaded object at a unique immutable durable locator.
6. The commit transaction confirms that the session has not expired, the fence remains valid, and the token is currently valid; it selects a healthy live generation within the namespace or accepts a new generation, establishes visibility, settles quota, and records the committed result. An opaque entry is published in the same domain commit; REAPI CAS and AC publication authorize separately.
7. A successful retry returns the recorded result without duplicate accounting. Revoked credentials cannot use historical success to bypass current authorization and expose session state. Terminal sessions are cleaned up after a bounded idempotency window; recovery does not promise unlimited QueryWriteStatus history.

Concurrent uploads of the same digest may all complete byte validation, but only one generation becomes the current live copy. Later commits reuse the winner after locking BlobIdentity, placing their own redundant staging/durable objects into orphan cleanup. Physical deduplication must not remove the requirement to prove the first authorized upload. An object completed before a failed database transaction leaves a reclaimable orphan, not a visible partial entry.

For pause/crash and upload-storage details, see the [cache-core design](cache-core.md). Session TTL, writer lease, idempotency window, and backend orphan grace are separate parameters: staging cleanup windows must cover sessions that may still recover; objects cannot be deleted solely by creation time.

## 6. Quota Definitions and Transactions

| Measure | P0 definition |
|---|---|
| Logical bytes used | Sum of BlobIdentity.logical_size for the namespace's current BlobVisibility records |
| Logical bytes reserved | Sum of reserved_bytes in active reservations within the namespace |
| Blobs used/reserved | Current nonvirtual BlobVisibility count in the namespace / sum of reserved_blobs in active reservations |
| Entry count | Ready entries still retained in the index; released by invalidation/deletion transactions |
| Physical storage | Actual backend generations, temporary objects, versions, and bytes awaiting cleanup; observed separately, without presenting logical hard limits as disk protection |
| Downloads | Actual wire/logical bytes sent, counted separately; P0 uses soft budgets |

A blob referenced by multiple entries in the same namespace is charged logical bytes only once. Another namespace uploading identical bytes is still metered separately and physically isolated. Standalone CAS is also charged; omitting AC publication cannot bypass quota.

Admission sketch (using numeric intermediate values to avoid bigint addition overflow):

```sql
UPDATE expbuild_cache.quota_account
SET logical_bytes_reserved = logical_bytes_reserved + :delta,
    blobs_reserved = blobs_reserved + :object_delta,
    revision = revision + 1
WHERE tenant_id = :tenant AND project_id = :project AND namespace_id = :namespace
  AND :delta >= 0 AND :object_delta BETWEEN 0 AND 1
  AND blobs_used::numeric + blobs_reserved::numeric + :object_delta <= blob_limit::numeric
  AND logical_bytes_used::numeric + logical_bytes_reserved::numeric + :delta
      <= logical_byte_limit::numeric
RETURNING revision;
```

This must occur in the same transaction as reservation insertion/expansion. The initial reservation uses object_delta=1; expanding only bytes on an existing reservation uses object_delta=0. The application first converts `delta` to a bounded nonnegative integer. Lowering a limit below current usage is a valid administrative operation, so the DDL has no `used <= limit` CHECK. New growth is then rejected, while existing reads and reclamation continue; existing data is not deleted immediately.

At commit, lock quota_account, session, and reservation in global order. New visibility produces `charged_bytes = logical_size, charged_blobs = 1`; a deduplicated commit of an already visible blob adds zero. Subtract reserved_bytes/reserved_blobs from the account, add the new charge to used, set the reservation to settled, and the session to committed. Even when entry publication conflicts, the protocol determines whether to retain uploaded CAS or roll back the entire opaque-operation transaction; settlement and visibility cannot complete only partially.

Expiry/abort may conditionally transition an active reservation only once and release its balance; it contends with commit on the same account/session locks. Actual bytes and blob counts release logical quota only when visibility is deleted, and remain charged when an entry has expired but CAS grace is still valid. Physical remnants after deletion begins are tracked separately as pending-reclaim, preventing the console from presenting “logical quota released” as disk space already reclaimed.

Entry creation/invalidation and `entries_used` are maintained in publication/deletion transactions. Hard blob-count limits bound index bloat from huge numbers of tiny CAS objects. Protocol metadata within entries and staging space are not charged byte-for-byte against logical blob quotas; they require independent protection through entry-count/payload limits, active-upload counts, staging capacity, and physical watermarks. Hard namespace quotas cannot replace protection for the entire backend disk.

This DDL cannot prove consistency between `quota_account` aggregates and reservations/visibility/entries. P0 provides a full recalculation tool after pausing writes, plus online discrepancy checks. Online reconciliation must not overwrite active account values directly without a consistent snapshot and incremental-change boundaries.

## 7. Lock Order and Publication Atomicity

Use PostgreSQL row locks + unique constraints + explicit conditional updates, initially at READ COMMITTED isolation. All write paths follow the same lock order:

```text
quota_account (when accounting is needed)
 → upload_session / quota_reservation (when needed; always session before reservation)
 → cache_entry (sorted by id, when needed)
 → blob_identity (sorted by id)
 → blob_generation (sorted by blob_id + generation_id)
 → blob_visibility (sorted by blob_id)
 → insert/remove references and leases, append outbox
```

Read-only authorization-cache hits need no quota lock. Persisting chunk offsets locks only the session; after locking a session, the transaction cannot go back to request quota expansion. Expansion transactions must restart in the order above. P0 offers no multi-namespace operations; future support must sort by full scope. All lock waits are bounded, and deadlocks/serialization failures have bounded retries; database locks cannot be held throughout a network upload.

Entry-publication transaction: lock the current entry (if no row exists, rely on a unique-key conflict and reread), check the expected generation; lock identities/generations to be referenced, restore recoverable tombstones, check visibility, integrity, and current permissions; delete old references, update generation/payload/provenance, insert new references, maintain entry counts and outbox, then commit. Deleting old references and updating the entry must share one transaction, or FKs will reject the change or reads will be inconsistent.

CacheEntry's `generation` is a monotonic version within the same row. Recreating the same key after cleanup uses a new entry ID; conditional tokens should encode `(entry_id,generation)` rather than a lone integer to prevent ABA. When a protocol's native PUT carries no conditional version, the adapter chooses a replacement policy allowed by its specification; internal CAS constraints cannot change native protocol behavior.

After acquiring a generation lock, GC queries roots/leases only through MVCC and does not acquire entry locks in reverse order. Publication/read protection queues on the same generation lock. If GC has already switched to deleting, waiters must fail, wait for a new copy, or reupload; querying “no references” outside the lock and then deleting is forbidden. GC conservatively skips candidates until committed old references have been cleaned up.

A namespace's quota_account serializes short commit transactions involving quota; **it does not serialize network transfers and all reads**. P0 measures lock waits/tail latency before considering quota sharding or budget leases; hard limits and atomicity are not sacrificed for theoretical throughput. SQL triggers do not encapsulate these paths; the implementation must consistently use domain repository/service methods.

## 8. GC Generation State Machine and Failure Recovery

```text
live ──no protection roots──→ tombstoned ──atomic recheck after grace──→ deleting ──backend confirmation──→ deleted
  ↑                              │
  └──valid new reference/read restoration──┘
live / tombstoned ──corruption detected──→ quarantined ──after isolating references──→ deleting
```

1. First invalidate/clean up expired entries and remove references, respecting pins and read protection. Expired sessions release reservations; staging cleanup proceeds separately. Sessions protect staging objects of active uploads that have not yet become live generations.
2. For a live generation with no roots/visibility retention/active leases, lock the identity and generation and set the tombstone, epoch, and delete_not_before. The epoch supports scan observability; **it is not the sole basis for concurrency safety**.
3. After the grace period, reacquire the same locks. Restoration/new-reference transactions allow only live generations or conditional tombstone restoration when authorized and the object is intact, writing protection at the same time. If GC sees protection, it stops processing that candidate.
4. Once deletion is confirmed permissible, lock quota_account, identity/generation/visibility; remove unprotected visibility, release logical quota, atomically change state to deleting, and assign/increment `gc_fence`, gc_owner, and gc_lease_until. Reference FKs prevent deleting visibility still used by entries. After this step, no new reference may use this generation.
5. Outside the transaction, delete the fixed `(backend_id, storage_key, backend_version)`. A deletion timeout means the outcome is unknown; do not mark deleted first. Retry the same locator. Reclaiming a task increments its fence; completion updates must use `WHERE state='deleting' AND gc_fence=:claimed AND gc_owner=:owner`.
6. Even if an old worker continues calling the backend after its lease expires, it can delete only this old generation, which can no longer accept references. **Fences protect database settlement; never reusing locators protects backend objects**. A new upload of the same digest creates a different locator and is unaffected by old deletions.
7. Once the backend confirms absence, mark deleted and record an event. Retain metadata until the idempotency windows of referencing sessions/leases end. Clean tombstone metadata in stages; deleting a row must not permit reuse of its old locator.

`quarantined` generations are unreadable and accept no new references. Corruption detection must first invalidate affected entries and protect streams being aborted. Quarantine still releases visibility under the same locking/quota rules; a quarantined object cannot be treated as an ordinary cache miss while bytes silently continue streaming.

When the backend is unreachable, deleting retries accumulate and trigger alerts. Show logical quota release separately from physical watermarks; low available disk space may still reject new uploads. Keep GC disabled if recovery state, policy version, or proof of index consistency is not established before startup. When restoring an old index, disable writes/GC first, then gradually reopen after reconciliation and authorization versions are aligned.

## 9. PolicyVersion, Auditing, and Outbox

Control-plane permission changes increment `tenant.authz_epoch`, append PolicyVersion, update the current version of affected namespaces, and write outbox in one transaction. Token introspection returns a short-lived signed AuthorizationLease; the data plane uses its policy_version/epoch and does not read verifiers. `UploadSession.policy_version_at_start` records only a fact, not permanent authorization to commit; commit records the current version separately.

Outbox commits in the same transaction that produces the critical facts. Event IDs provide idempotence; producer sequence expresses only producer order, not a global event timeline for the whole tenant. Consumers deduplicate by `(tenant_id,event_id)` or an agreed producer sequence. Delivery is at least once and may repeat after lease expiry; audit content is immutable, while delivery status may change. Message-arrival order cannot substitute for policy-version/epoch comparisons when determining publisher order.

This table carries management audits and critical cache-state/settlement events; it does not write a durable audit record for every GET. High-volume read metering, operational metrics, and build events have separate aggregation paths; P0 does not claim this one outbox solves future SaaS billing. Event payloads must not contain plaintext tokens, complete signed leases, or arbitrary build-environment content.

DDL FKs ensure that records reference an actual policy version, but do not prove it remains valid or enforce correspondence to the current epoch. The authorization service and data plane must implement and test monotonic versions, signature validation, revocation propagation, maximum offline leases, and termination of active streams on expiry.

## 10. What DDL Proves and What the Implementation Must Still Prove

| Invariant | Provided by DDL | Additional implementation/testing required |
|---|---|---|
| Scope does not cross tenant/project/namespace boundaries | Composite FKs, PKs, immutable triggers | Scope in every query; authentication/authorization; database permission/RLS selection |
| Namespace cannot change protocol or trust domain | Immutable trigger | Administrative process to create a replacement namespace |
| Token matches the upload principal | Composite credential/reservation FKs | Reauthorization on resume/commit, revocation/expiry, and epoch |
| Content identity is unique | Unique digest/size key | Actual streaming digest calculation, size validation, trusted upload sources |
| References exist and point to exact generations | Entry/version/visibility FKs | Complete closure, health status, atomic publication, and read protection |
| At most one publishable copy exists at a time | live/tombstoned partial unique index | Backend durability, winner selection, orphan cleanup |
| Byte/entry quotas are not exceeded | Nonnegative and simple within-row CHECKs | Account transactions for reserve/settle/release, idempotence, reconciliation |
| Offset is genuinely durable | CHECKs for nonnegative values/not exceeding expected size | FS/S3 checkpoint semantics, fence and staging isolation |
| GC does not delete new uploads accidentally | Unique locators and immutable fields | State transitions, common lock order, never reusing paths, backend version behavior |
| Audits are not lost and can be deduplicated | Unique envelopes and immutable triggers | Writing in the same business transaction, delivery retries, downstream deduplication/retention |

Reference counts or isolated cross-table CHECK calculations cannot replace these transactions. PostgreSQL's official documentation explains that cross-row/cross-table constraints should use appropriate foreign keys, unique constraints, and related mechanisms; lock acquisition and deadlock handling still require application design. [PostgreSQL 18 constraints](https://www.postgresql.org/docs/18/ddl-constraints.html), [explicit locking](https://www.postgresql.org/docs/18/explicit-locking.html), [triggers](https://www.postgresql.org/docs/18/sql-createtrigger.html).

## 11. Minimum Validation Checklist and Current Validation Status

For the first index implementation PR, execute the DDL/migrations against a temporary PostgreSQL instance and cover these integration cases:

- A namespace in project A cannot be spliced into uploads, references, or events in project B; another principal's token cannot reference the current reservation.
- 50 concurrent commits of the same digest produce only one current visibility and one logical charge; failed transactions do not leak permanent reservations.
- An unknown-length upload stops accepting new bytes immediately after reservation expansion fails; recovery after power loss reports only durable_offset, not the in-memory length.
- After worker A expires and B takes over an upload, A's continued writes/commit cannot overwrite B's staging or metadata; changing tokens for the same principal cannot take over the session.
- Replacing an entry after it is read still leaves later CAS reads protected by the promised grace; GC waiting on new references/leases does not delete incorrectly, and an old timed-out GC does not harm a new generation.
- Replacing references for entry generation 1→2 either succeeds entirely or preserves generation 1 entirely; deleting and recreating the same key does not cause ABA for `(entry_id,generation)`.
- Lowering quota below usage preserves reads and rejects net growth; logical release does not falsely report completed physical-space reclamation.
- Outbox delivery failure does not roll back business facts that already succeeded durably, and redelivery does not settle twice; policy revocation covers already-open streams and commit.
- GC/writes remain disabled during old-index restoration; missing objects produce definite misses/invalidation, never false hits or deletion of new objects that have not been reconciled.

In this iteration, the accompanying SQL was parsed with `pglast 8.4` temporarily downloaded to `/tmp`: **47 PostgreSQL statements passed syntax parsing**. Static AST checks also confirmed that all 34 FKs across 16 tables point to existing unique keys with compatible column types. The JSON-wrapped output of separate PL/pgSQL parsing was abnormal and was not counted as a passing check. No PostgreSQL server was run; server-side PL/pgSQL compilation, actual FK creation, concurrent transactions, failure recovery, and performance were not validated. Production migrations, complete IAM tables, database-role permissions, and the integration validation above remain implementation deliverables.
