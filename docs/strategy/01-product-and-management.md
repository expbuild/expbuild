# Product Positioning and Enterprise Management Capabilities

Date: 2026-09-28. This document contains design recommendations; repository status and external facts are covered separately in the audit, protocol, and competitive research reports.

## 1. Product Promise and Boundaries

ExpBuild helps enterprises deploy and manage shared build caches without replacing their build tools or CI systems, reduce repeated work, and gradually move demanding builds onto controlled execution resources.

The long-term product consists of four layers:

| Layer | User value | Delivery boundary |
|---|---|---|
| Cache | Shared cache service for multiple languages and tools | Protocol compatibility, trusted reads/writes, storage tiers, lifecycle, and cost |
| Connect | Lower integration and diagnostic costs | Native tool configuration, CI plugins, identity federation, optional local/edge proxies |
| Insight & Govern | Enable platform teams to manage, explain, and control | Organizational permissions, budgets, auditing, real metrics, build correlation, cache troubleshooting |
| Execute | Accelerate builds that caching cannot eliminate | REAPI execution, isolated workers, scheduling, capacity, and execution costs |

These are capability modules; immediately separating them into four commercial SKUs is not recommended. The first usable product is Cache + basic Connect + Govern; existing workers remain experimental.

Evaluate dependency package proxies, image registries, release artifact management, and full CI orchestration separately. Prioritize integration with Harbor/existing registries, enterprise package repositories, and Jenkins/GitLab/GitHub Actions. Build caches contain rebuildable data; release artifacts usually have stronger long-term retention, versioning, and supply-chain requirements and should not share the same default deletion policy.

## 2. Initial Users and Hypotheses to Validate

| Role | Current pain-point hypothesis | Outcome to deliver |
|---|---|---|
| Enterprise platform engineer | Different tools have separate cache servers, permissions, and metrics | One set of identity, project, storage, operations, and onboarding documentation |
| Developer | Difficult onboarding and no explanation for ineffective caching | Copy working configuration, diagnose connectivity, inspect cache behavior for this build |
| CI/build engineer | Ephemeral runners lose caches; repeated builds and hot downloads | Trusted CI warmup; compare cold/warm/incremental builds; identify resource bottlenecks |
| Security and operations | Cache poisoning, unclear cross-project permissions, uncontrolled capacity | Traceable write sources, testable isolation, controlled quotas/cleanup, recoverable failures |
| Engineering manager | Hit rates alone cannot explain costs and benefits | Time/resource comparisons with defined methodology, usage attributed to projects |

Interview 3–5 companies or teams covering at least two ecosystems. Collect tools and versions, cacheable steps, pipeline P50/P95, cache-hit/download time, daily build volume, object sizes and counts, network RTT, storage budgets, and SSO/offline deployment requirements. Do not directly turn these hypotheses into market-size estimates or performance commitments.

Initial adopters should have reasonably established build workflows and platform teams that control CI identity and configuration. For tasks with undeclared inputs, unstable dependencies, or timestamps in outputs, diagnose cacheability first; a server cannot fix every nondeterministic build.

## 3. Management Hierarchy and Trust Model

```text
Deployment / Cluster (one installation hosting one or more tenants)
  Tenant (enterprise or isolated organization; boundary for data, metering, keys, and policies)
    Team / Membership (users may join multiple teams)
    Project (associated repository, budget, and maintainers)
      Namespace (protocol, environment, cache lifecycle, and read/write policies)
        trust_domain attribute (bound exclusively to one of trusted-ci / internal-dev / isolated-pr)
```

Tenant and Project are separate. Even when the first enterprise deployment has only one tenant, tenant_id must be included in queries, cache indexes, object visibility, quotas, events, and audits.

Each namespace is bound to exactly one trust_domain; the same key space must not contain both trusted and untrusted writes. Create two namespaces when the same protocol needs two trust levels. A namespace does not mean a permanently dedicated cache for every branch: trusted branches may share results when tool keys are correct; untrusted PRs use isolated write areas and short lifecycles. Reading a specific trusted upstream cache may be explicitly authorized, but PR writes must not automatically be promoted into a trusted namespace.

Service accounts represent CI/machines; user identities represent people. Authorization derives from accounts and policies, not client-supplied tenant/project strings. Native protocol instance_name, teamId, and path prefixes are only routing identifiers that require validation.

## 4. Console Information Architecture

| Module | Complete P0 workflow | Later capabilities |
|---|---|---|
| Overview | Request hits, bytes, errors, latency, capacity, health per protocol; explicit time range/sample count | Build benefits, project comparisons, budget trends |
| Projects and onboarding | Create project/namespace; choose tool; generate version-specific configuration; verify connectivity and first read/write | Repository import, CI identity federation, multi-environment templates |
| Cache | Search by protocol/project/size/creation time; metadata; expiry and quotas; cleanup preview | Popularity, retention policies, controlled upstream fetching, individual-hit correlation |
| Identity and access | Users/teams/members; service accounts; roles; token creation/revocation/rotation | OIDC, SCIM, enterprise directories, fine-grained conditional policies |
| Storage and nodes | Backend connection status, usage, data-plane nodes, disk watermarks | Edge nodes, cross-site topology, backend migration |
| Audit and operations | Login/permission/token/policy/cleanup operation records; alert configuration; backup status | Audit export, external SIEM, policy approvals |
| Build records | No promise of native collection from every tool yet; support explicit CI reporting first | Bazel BES/BEP, sccache statistics, tool plugins, build comparisons |
| Execution resources | Experimental entry point disabled by default | worker pool, queues, resource utilization, draining, scaling, failure diagnosis |

Rename the current SaaS pages to “Organizations and Projects”; move the existing Build Farm under “Execution Resources.” Enterprise administrators' frequent onboarding, permission, cache-policy, and storage tasks should not be hidden in SaaS or node-monitoring pages.

Product states must distinguish not connected, no samples, collecting, stale data, and request failure. Production API failures must not fall back to mocks or disguise unknown values as 0. Demo mode should be an explicit, separate, identifiable data source.

## 5. Permissions and Credentials

Use fixed roles in the first release and allow custom combinations later:

| Role | Available permissions | Denied by default |
|---|---|---|
| Platform administrator | Installation configuration, storage and data-plane operations | No direct access to all tenant artifacts by default; emergency access requires explicit authorization and auditing |
| Tenant administrator | Members, projects, policies, budgets, service accounts | Other tenants' data |
| Project maintainer | This project's namespaces, tokens, retention policies, diagnostics | Global IAM, cross-project reads |
| Developer | Cache reads and build-record access in authorized namespaces | trusted-ci writes and deletion |
| Observer | Metrics and metadata within authorized scope | Artifact downloads, credentials, policy changes |
| CI service account | Explicitly granted cache.read/cache.write/event.write | Organization management, arbitrary namespaces, arbitrary deletion |

Permission actions should include at least cache.read, blob.write, result.publish, cache.invalidate, artifact.download, metadata.read, event.write, execution.submit, worker.register, and admin.manage. Product-level cache.write is a convenient grouping of related write permissions; internally, “uploading content” must be distinct from “publishing results others can trust.” REAPI CAS writes do not automatically authorize AC updates; writing a complete opaque-protocol entry counts as result.publish. Hiding a UI menu is not authorization; every API, gRPC request, and object-download path requires authorization.

API keys use high-entropy random values and are displayed only on creation. Store a searchable identifier and a server-protected verification value in the database, avoiding directly usable plaintext. Record the principal, scope, expiry, last use, creator, and revocation time; provide a short overlapping rotation window. Browser sessions and CI tokens have separate lifecycles. Refuse startup in production if JWT/session secrets are missing.

Revoking a token does not automatically revoke results it previously published. Cache entries retain the publishing principal, a non-secret token identifier, namespace, trust domain, publication time, and optional invocation. The management application provides a response workflow: search by source → preview → quarantine/invalidate → audit → rewarm with trusted CI. Preserve source metadata from P0; P0 must at least provide an audited bulk-invalidation API/CLI, with fuller UI in P1. Invalidate result mappings first rather than blindly deleting shared CAS still referenced by other trusted entries.

OIDC should be included in P1; if SSO is a hard launch requirement for a pilot, move it to P0 and replace other noncritical work. Exchanging CI OIDC federation for short-lived credentials comes later; do not assume all build tools can directly use OIDC.

## 6. Quotas and Lifecycle

Support at least logical storage bytes, object count, maximum object size, concurrent uploads, request rate, and download traffic; add CPU/memory duration after execution launches. The current limit based on “pipeline report count” does not adequately constrain cache use.

Quotas appear in the UI, admission checks, and background reconciliation: reserve before upload, enforce streaming limits for unknown sizes, release on cancellation, and settle on successful commit. Cross-node allocations use persistent leases/atomic ledgers, not independent per-node counters. When over quota, block new writes first and preserve allowed reads without directly disrupting objects in use. Actual protocol error codes and client fallback behavior require testing.

Separate capacity measures: logical storage (accounted per namespace, aggregated by project), physical storage (actual backend usage), SSD hot cache, staging/pending-cleanup space, and object versions. P0 deduplicates only within namespaces; identical bytes in different namespaces are stored and metered independently. If shared blobs are introduced later, explicitly define each project's logical quota attribution rather than randomly allocating charges by physical proportion.

Lifecycle management supports TTL, last access, storage watermarks, minimum protection periods, upload/download leases, and protected root references. Necessary blobs referenced by retained result entries must not be removed. Administrators preview cleanup scope before running an auditable task. Tenant deletion first revokes authorization, then asynchronously cleans up its references and objects.

## 7. Metric Definitions and Actual Benefits

| Metric | Definition | Cannot directly establish |
|---|---|---|
| Entry lookup hit rate | Successful result-entry hits / entry lookups successfully classified as hit or miss | Task time saved, Bazel CAS request hit rate |
| CAS blob hit rate | Blob lookup hits / blob lookups; count batch requests per object | Action hit rate; one action may reference many blobs |
| Task cache hit rate | Hit tasks reported by tool events / cacheable tasks | Server hit rate for individual GETs |
| Bytes served / uploaded | Actual bytes sent/received, distinguishing wire and logical measures | Compilation CPU savings |
| Avoided compute estimate | Median historical execution time for matching tasks × hit-task count, with samples and estimate clearly identified | Entire pipeline wall-time benefit; tasks may run in parallel |
| CI wall-time change | Difference in build completion time between a comparable baseline and a cache-enabled group | That caching caused all changes |
| Storage efficiency | Logical bytes / physical bytes within the same isolation domain | Permission to share across domains between tenants |

Report errors and timeouts separately from the hit-rate denominator, alongside service availability; otherwise many errors may masquerade as normal misses. The statistics system must state whether retries are deduplicated, whether it counts batch objects or HTTP requests, the time window, and data freshness.

Estimated net resource benefit = avoided compute cost − cache-service compute cost − object-storage capacity cost − storage request cost − network cost. Report developer waiting time separately; avoided parallel CPU time is not human waiting time. Enterprises supply cost parameters; the plan does not use unverified cloud prices.

Present “why was this a miss?” in layers:

1. Server-confirmed facts: key absent, expired/evicted, permission denied, rate/quota limited, corrupted, or backend failed.
2. Client evidence: changed inputs/toolchain/environment/arguments, uncacheable tasks, failed signature verification, or client-local hits.
3. Inference: without input fingerprints, suggest only possible causes; do not claim that a particular source file definitively caused invalidation.

Bazel build events can correlate build results with configuration, but deeper analysis also requires version-specific execution logs or other fingerprint information. BES is the service protocol carrying events; BEP is the event format. Neither should be treated as a cache protocol. [Bazel BEP/BES](https://bazel.build/remote/bep).

## 8. Enterprise Delivery Options

- Development/evaluation: Compose, one data-plane node, PostgreSQL, file storage; the same domain model, without maintaining an incompatible simplified product.
- Enterprise production: containers or systemd + enterprise PostgreSQL + enterprise object storage + TLS; capacity, backup, monitoring, and upgrade documentation. Kubernetes is optional.
- P1 high availability: multiple data-plane nodes, shared persistent index/object storage, independent hot caches; management services can be upgraded separately.
- Offline environments: images and dependencies can be mirrored; the UI has no runtime dependency on public CDNs; provide offline installation and version inventories, upgrade steps, and rollback steps.
- Future SaaS: reuse tenant/project/namespace, quota, and service-account models; add account provisioning, subscriptions, regions, and dedicated enterprise data planes.

The open-source product itself should support a complete, secure self-hosted workflow. Commercial-edition boundaries for SSO, governance, or deployment require a separate decision based on customer buying reasons and maintenance investment; basic isolation, authentication, and repair capabilities must not be weakened to create commercial tiers.
