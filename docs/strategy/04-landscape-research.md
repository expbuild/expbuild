# expbuild Competitive and Platform Capability Research

Research date: 2026-09-28. Priority scenario: enterprise self-hosting, with an architecture that leaves room for SaaS. This report distinguishes officially verified capabilities from inferences for expbuild; it does not compare performance without uniform testing or rank market prices. License information is for product-selection diligence only; integrations still require pinned versions and file-by-file verification.

## 1. Recommended Positioning

**expbuild should become a trusted cache and acceleration control platform shared across build ecosystems, prioritizing enterprise self-hosting.** The core value is not “supporting the most protocols,” but enabling Java, JS/TS, C/C++, Rust, Go, Bazel, and container-build teams within the same enterprise to use consistent project permissions, trust policies, quotas, data lifecycles, and cache diagnostics; remote execution can be integrated later.

“Unified multi-protocol caching” already has direct competitors. Depot officially lists integrations including GitHub Actions, Bazel, Go, Gradle, Pants, sccache, Nx, Turborepo, Maven, and moonrepo, and offers cache browsing, usage statistics, retention, and capacity configuration. Multi-protocol support must therefore not be described as an original invention; the competitive opportunity is **independent enterprise deployment + protocol-neutral governance + explainable benefits + an extensible data plane**. [Depot Cache overview](https://depot.dev/docs/cache/overview), [product page](https://depot.dev/products/cache)

Recommended product promise: retain existing build tools and CI. Tools with native remote caching integrate primarily by configuring endpoints, credentials, and cache switches; extension-based approaches such as Maven receive separate installation steps. Platform administrators centrally allocate, govern, and audit cache resources; developers investigate misses, latency, and policy denials using collected evidence.

## 2. Competitive Map: Engines and Platforms

| Project/product | Officially verifiable positioning | Lessons for expbuild | What not to copy or assume directly |
|---|---|---|---|
| BuildBuddy | Bazel build events, results, remote cache, RBE; enterprise edition offers cloud hosting and on-premises deployment, OIDC, HA, etc. | Connect invocations, cache requests, build trends, and governance; distinguish CAS-write and AC-write permissions | Do not use its Bazel semantics as the sole domain model for every protocol; a public repository does not permit copying enterprise code |
| Buildbarn | REAPI storage and composable remote-execution components | Independent storage data plane, composed storage backends, AC integrity checks, execution routing by instance | A family of build infrastructure components, not a ready-made multi-protocol enterprise portal; assess operational and configuration costs |
| Buildfarm | REAPI caching and remote execution; instances represent resource pools; scheduler, workers, and Redis form a cluster | Instance/resource-pool mapping, queue and worker management, candidate execution backend | Building a full scheduler for the cache platform early significantly expands scope; instance names do not automatically authorize access |
| NativeLink | One Rust binary configured as CAS, AC, scheduler, or worker; composable stores | Preserve the same module boundaries for standalone and distributed deployment; capability declarations and storage decorators | Current license is FSL; do not assess commercial integration based on historical Apache assumptions; verify default configuration correctness/authorization individually |
| bazel-remote | HTTP/gRPC REAPI cache, disk LRU, object-storage proxy, compression, and metrics | Small deployments/edge caching, quick reference implementation and protocol compatibility target | Not a complete enterprise platform; the Go library does not promise API stability, so prefer process-level integration; CAS instance paths are not isolated by default |
| Gradle Develocity | Build analysis, caching, test acceleration, enterprise controls; Edge moves services closer to builds | Build Scan diagnostics, project access controls, short-lived credentials, Edge management, cross-node cleanup | The open Gradle HTTP cache protocol does not imply permission to imitate or reuse private Develocity capabilities; do not copy the complete analytics stack in phase one |
| Nx / Nx Cloud | Nx task caching; Nx Cloud adds distributed execution, task splitting, etc.; enterprise plans support self-hosting | Layered security domains, trusted writes, immutable entries, token tracing; integrate against current OpenAPI | Do not adopt deprecated self-hosted bucket packages; Nx Cloud commercial features are not Nx open-source capabilities |
| Turborepo / Vercel Remote Cache | Task-level HTTP remote caching, public self-hosting API, artifact signatures | Standard adaptation, original-client compatibility, transparent signature preservation, simple onboarding | HMAC verification does not replace tenant isolation and trusted writers; a cache hash is not a verifiable artifact-content digest |
| sccache | Compiler wrapper, local/remote caching, and separate distributed compilation | Reuse compiler semantics and WebDAV backend instead of rewriting compiler integration | A client/compiler ecosystem component, not an enterprise portal; sccache-dist is not a REAPI worker |
| Depot | Hosted cross-tool caching, builders, and runners | Unified multi-protocol onboarding, automatic configuration, cache browsing, retention/usage experience | Do not claim “nobody does multi-protocol”; investigate project granularity and trust policies beyond its publicly documented boundaries |

“Not a complete platform” in this matrix is a product-scope assessment, not a claim that a project has absolutely no authentication or UI. This research did not comprehensively audit every repository's features.

Sources: [BuildBuddy Enterprise](https://www.buildbuddy.io/docs/enterprise/), [Buildbarn storage](https://github.com/buildbarn/bb-storage), [Buildfarm architecture](https://buildfarm.github.io/buildfarm/docs/architecture/architecture/), [NativeLink architecture](https://docs.nativelink.com/explanations/architecture), [bazel-remote](https://github.com/buchgr/bazel-remote), [Develocity Edge](https://docs.gradle.com/develocity/edge/2.1/), [Nx self-hosting interface](https://nx.dev/docs/kb/self-hosted-caching), [Turborepo remote caching](https://turborepo.dev/docs/core-concepts/remote-caching), [sccache](https://github.com/mozilla/sccache).

## 3. Key Mechanisms: Details Worth Learning From

### 3.1 BuildBuddy: Cache Data Needs Build Context

BuildBuddy's authentication model distinguishes Admin, Writer, Developer, and Reader; a Developer can write CAS but only read AC. This is valuable: developers may need to upload content for execution and diagnosis without automatically being allowed to publish computed results that other builds directly trust. Personal-key permissions contract with the organization role, and removing a user from the organization deletes the corresponding key. [Authentication and roles](https://www.buildbuddy.io/docs/guide-auth/)

BuildBuddy's cache requests page analyzes object sizes, requests, and targets per build. Its implementation discussion describes asynchronously buffering request records before archiving them, avoiding synchronous business-database writes for every high-speed cache request. Its enterprise API also provides an audit-export interface with a separate Audit log reader key. [Cache debugging](https://www.buildbuddy.io/blog/bazel-remote-cache-debugging/), [audit API](https://www.buildbuddy.io/docs/enterprise-api/)

Recommendation for expbuild: unify permission actions beyond read/write: admin, policy.edit, cache.read, blob.write, result.publish, cache.invalidate, audit.read, usage.read. For opaque protocols without a CAS/AC distinction, treat result writes as result.publish; tailor the set to protocol capabilities. Management auditing uses a reliable append-only log; high-frequency access and diagnostic events may be asynchronously aggregated. They should not be conflated into one logging pipeline.

### 3.2 Buildbarn / Buildfarm: Standard Interfaces Make Execution a Replaceable Backend

Buildbarn's bb-storage can operate as a standalone cache or forward execution requests to a scheduler. Storage backends can compose gRPC, disk structures, and other components; examples show AC and execution routing for different instances. Buildfarm uses instances to represent resource pools, with multiple instances at one endpoint. [Buildbarn README](https://github.com/buildbarn/bb-storage), [Buildfarm architecture](https://buildfarm.github.io/buildfarm/docs/architecture/architecture/)

Recommendation for expbuild: complete caching, governance, and observability in phase one. Later, use ExecutionProvider to integrate existing REAPI engines and unify worker pools, tenant quotas, and usage. Do not rewrite scheduling, isolated execution, toolchain distribution, multi-platform workers, and cache storage in the same phase. This interface is only an integration boundary; it does not guarantee stateless interchangeability between engines. Cancellation, retries, platform properties, queues, and execution-result permissions require dedicated acceptance testing.

### 3.3 NativeLink: Small Interfaces Compose, but Correctness Cannot Be Left to Defaults

NativeLink builds a store graph around a unified StoreDriver interface. Its documentation explicitly distinguishes routing wrappers from transforming wrappers and discusses fast/slow two-tier write acknowledgment and coalescing reads of the same key. This can inspire expbuild's StorageProvider and compression/verification/tiering modules without copying its language or every abstraction. [Store model](https://docs.nativelink.com/explanations/store-model)

The same document explicitly states that a client digest on a normal upload is only a claim; the verify wrapper checks content, and the relevant checks are disabled by default. The lesson for expbuild is: **a content digest promised by the protocol must be verified when the write completes; temporary objects become visible only after verification. An opaque action/task key must not be mistaken for a blob content digest.** This is also why a generic `PUT key -> bytes` implementation cannot automatically satisfy every cache protocol.

### 3.4 bazel-remote: Instance Names Are Never Inherent Tenant Boundaries

The bazel-remote documentation explicitly states that instance names in CAS HTTP paths are ignored; AC incorporates the instance into its lookup key only when `enable_ac_key_instance_mangling` is enabled. It also does not guarantee internal API stability as a Go module. [bazel-remote README](https://github.com/buchgr/bazel-remote)

Recommendation for expbuild: authenticate and authorize to determine tenant/project, validate the requested namespace permissions, then construct the internal scope. External `instance_name`, teamId, URL paths, and headers are inputs to validate. When reusing external cache engines, verify actual physical/logical isolation rather than merely constructing different client prefixes. Prefer deduplication within tenants, without cross-tenant deduplication by default.

### 3.5 Develocity: Enterprise Value Comes from Complete Diagnostic and Operational Workflows

Develocity's task-input comparison can explain misses but requires task inputs and build context. A server seeing only opaque keys cannot reverse-engineer every cause. Edge provides central registration, node status, locations, traffic, configuration, and cleanup of specified objects across edges; short-lived tokens can bind permissions, projects, and expiration. [Task-input comparison](https://docs.gradle.com/develocity/tutorials/task-inputs-comparison/), [Edge manual](https://docs.gradle.com/develocity/edge/2.1/), [Token API](https://docs.gradle.com/develocity/api-manual/)

Recommendation for expbuild: define three levels of cache insight. Level one needs no agent: requests/hits/bytes/latency/backends/quotas/cleanup. Level two relies on build events and CI metadata: project, commit, branch, invocation, target/task, estimated avoided execution. Level three relies on client input models: miss diff, nondeterminism, and critical-path benefits. Show unknown when information is absent; do not present GET 404 as “a code change caused this miss.”

Self-hosted operations are also part of the product: initialization wizard, configuration validation, upgrade migrations, backup/recovery, health checks, support bundles, offline images, audit export, and data cleanup. Edge is more than deploying extra proxies; revocation, isolation, cleanup, and usage must cover every replica.

### 3.6 Nx / Turborepo: Trusted Results Matter More Than Preventing Overwrites

Nx deprecated its s3/gcs/azure/shared-fs self-hosted packages on 2026-05-21. The officially described CREEP risk is that untrusted PRs and protected main branches use the same cache key, allowing an untrusted workflow to write poisoned results first. The new self-hosting API requires 409 for an existing key, but first-write-wins alone cannot prevent an untrusted first writer. [Nx deprecation notice](https://nx.dev/docs/reference/deprecated/self-hosted-cache-packages), [security analysis](https://nx.dev/blog/creep-vulnerability-build-cache-security)

Nx Cloud describes immutable artifacts, per-task access, visibility layers, and token-source tracking. Turborepo can enable HMAC-SHA256 artifact signatures, treating verification failures as cache misses; every writer sharing the signing key remains in the same trust domain. [Nx cache controls](https://nx.dev/docs/kb/unknown-local-cache), [Turborepo remote caching](https://turborepo.dev/docs/core-concepts/remote-caching)

Recommended expbuild defaults: protected CI may write trusted namespaces; ordinary developers read trusted namespaces and may write personal/project development namespaces; external PRs read only publicly allowed content and write separate PR namespaces; trusted domains do not read back from untrusted domains. Identity/branch information must come from verified workload identity or backend bindings, not arbitrary client-reported headers. Promotion should rebuild/verify provenance and publish a new trusted record, rather than merely changing a UI label.

### 3.7 sccache: Integrate Existing Clients Before Building Another Cache Client

sccache supports compiler wrappers for C/C++/Rust and other languages, plus multiple remote stores. Its WebDAV backend offers endpoint, key prefix, read-only mode, and Basic/Bearer configuration. It handles compiler flags, toolchains, and cacheability semantics itself. [sccache README](https://github.com/mozilla/sccache), [WebDAV documentation](https://github.com/mozilla/sccache/blob/main/docs/Webdav.md)

Recommendation for expbuild: first provide compatible backend semantics, configuration snippets, connectivity diagnostics, and statistics ingestion. Add an optional expbuild CLI/agent only when standard entry points cannot provide secure identity exchange, edge proxying, or finer diagnostics. “Supporting Rust/C++” must not promise cache hits for every compilation and linking step.

### 3.8 Depot: Direct Competition and Specific Differentiation Opportunities

The subsequent [Depot Deep Dive and Architectural Inferences](../research/depot/README.md) adds public-code, database/storage evolution, and incident evidence. Depot Managed can deploy its data plane into a customer's AWS account while retaining its hosted control plane. Thus “running in the customer's cloud” is not unique to expbuild; differentiation should further validate fully independent deployment, offline operation, and unified extension governance. [Managed documentation](https://depot.dev/docs/managed/overview)

Depot Cache's official authentication page lists user tokens, organization tokens, and runner per-job tokens, and states that cache does not support project tokens because its project model is for container builds. Its GitHub Actions cache integration page describes repository isolation without enforced branch isolation; do not generalize that boundary to all of its products. [Cache authentication](https://depot.dev/docs/cache/authentication), [GitHub Actions integration](https://depot.dev/docs/cache/integrations/github-actions)

The product hypothesis expbuild can validate is that multi-team enterprises will pay for **consistent project authorization, namespace trust, budgets, auditing, and private deployment across all protocols**. This requires pilots at 3–5 enterprises with mixed technology stacks; market demand cannot be inferred directly from a feature table.

## 4. A Layered Definition of Comprehensive Management

| Management domain | Required in the first enterprise version | Later extensions |
|---|---|---|
| Tenants and organizations | tenant/org, project, namespace; enforced scope on every API query | Departments/project groups, suborganizations, independent data planes, dedicated bucket/KMS |
| Human and machine identity | Local bootstrap admin, project RBAC, service accounts, expiring/revocable tokens; OIDC in P1 general release, moved to P0 if customers require it | SAML, SCIM, workload OIDC, fine-grained ABAC |
| Trust policies | Separate cache read from result publish; CI/dev/PR domains; explicit sharing | Verified promotion, provenance, quarantine, bulk withdrawal |
| Quotas and governance | Soft/hard storage limits, upload sizes, concurrency, rates, retention, administrator cleanup | Team budgets, burst budgets, differentiated storage policies, cost allocation |
| Insights | Hit rate, misses, byte hit rate, latency percentiles, traffic, errors, policy denials, top namespaces | Invocation comparisons, input diffs, anomaly detection, optimization suggestions |
| Operations | Node/backend health, configuration changes, auditing, alerts, exports, backup/recovery | Multi-site and cross-region support, proactive warming, Edge management, SLA |
| Extension management | Versions/capabilities/health and compatibility ranges of built-in adapters | P2 SDK/plugin management; signed plugins, marketplace, staged rollout/rollback, and developer portal as needed later |
| Automation | Management API, configuration as code, CLI, standard metrics/trace | Terraform provider, policy templates, event integrations |

“Tenant” accommodates future customer boundaries. An enterprise self-hosted deployment may contain only one tenant, but business tables, object keys, events, and authorization decisions carry tenant_id from day one. Projects define permission and cost ownership; namespaces define protocol, trust level, platform/toolchain, or business sharing domains. Avoid making one string perform every role.

Quotas must define ledger semantics: logical/physical bytes, before/after compression, attribution of shared objects, write reservations, release on failure, and deletion delays. Separate soft-limit alerts from hard-limit rejection. Hard limits generally reject new writes while continuing reads of existing trusted caches. The product should not imply “high hit rate = necessarily faster”; download overhead and the critical path must also be observed.

## 5. What to Build, Integrate, or Defer

| Capability | Recommendation | Rationale and acceptance focus |
|---|---|---|
| Unified identity, tenants, projects, namespaces, policies, auditing, usage | Build the domain model; reuse mature OIDC/RBAC libraries | This is the cross-protocol product value; cover every path through blobs, indexes, logs, exports, and management actions |
| Gradle/Turbo/Nx/sccache protocol adapters | Build thin adapters against official specifications and real-client contract tests | Preserve protocol status codes, signatures, headers, idempotency, opaque-key semantics; do not force client changes |
| Blob storage | Reuse mature file/object-storage SDKs; define atomic publication and isolation layers | Do not rebuild S3 or use a database for large objects; verify checksums, streaming uploads, interruption cleanup |
| REAPI cache | Implement a core at small scale or initially proxy a mature engine as a reference | Capabilities, AC/CAS/ByteStream, compression, and integrity require separate acceptance checklists; “supports gRPC” is insufficient |
| Remote execution | Defer; integrate Buildbarn / Buildfarm first; conduct NativeLink license and boundary diligence first | Custom scheduler/worker development turns the platform into infrastructure for executing untrusted code and greatly expands scope |
| Compiler integration | Integrate clients such as sccache/ccache | Preserve upstream's accumulated compiler/toolchain compatibility work |
| Build events and analytics | Integrate BEP/CI/optional agents per protocol; build a unified event schema | Unify common fields and retain extension fields; opaque protocols cannot infer input changes on the server alone |
| Registry / package proxy | Integrate existing systems such as Harbor and Nexus/Artifactory first | OCI/package images, manifests, indexes, and deletion semantics differ; do not expand the first release into a repository manager |
| Edge / P2P / CDC | Add Edge after the cache kernel stabilizes; schedule P2P/CDC against actual bottlenecks | Quotas, deletion, revocation, recovery, and network costs become more complex; do not assume free acceleration in advance |
| Billing and payments | Start with explainable usage/cost allocation; integrate billing for SaaS | Validate capacity and benefits for enterprise self-hosting first; keep subscriptions out of the data plane |

Use two extension mechanisms: high-throughput adapters/stores use stable internal interfaces and compile-time modules; untrusted third-party or policy/event extensions use out-of-process RPC, time/resource limits, and version/capability negotiation. Plugins must never bypass identity and namespace checks. Prove boundaries with two built-in protocol adapters in phase one; publish the SDK and out-of-process plugin examples in P2, deferring marketplaces and hot loading.

## 6. Current Licensing and Commercial Boundaries

| Project | Findings verified in this research | Implications for expbuild selection |
|---|---|---|
| BuildBuddy | Root LICENSE lists ordinary code as MIT, but enterprise/ uses a separate Enterprise License; production use requires the corresponding subscription agreement | Study mechanisms; check licenses per path before code reuse; RBE, SSO, and other enterprise capabilities are not automatically MIT |
| Buildbarn bb-storage | Apache-2.0 | Integration candidate; verify actual dependencies/components per version |
| Buildfarm | Apache-2.0 | Candidate REAPI execution backend |
| bazel-remote | Apache-2.0 | Candidate standalone cache process/edge component; note internal library API stability |
| sccache | Apache-2.0 | Prioritize compatibility with existing clients |
| NativeLink current main | FSL-1.1-Apache-2.0; explicitly lists internal use and excludes commercial Competing Use; each release gains an additional Apache-2.0 license two years after release | Internal enterprise deployment and packaging as a commercial cache platform are different uses; do not assume resale or SaaS use is permitted or bind future business to unconfirmed rights |
| Nx open-source repository | MIT; does not establish licensing for Nx Cloud/Enterprise commercial services | Implement the public compatible API; separate product and service boundaries |
| Turborepo open-source repository | MIT; Vercel's hosted service is a separate product boundary | Implement the public cache API; handle signatures and team parameters according to the specification |
| Develocity / Depot | Commercial products; official documentation and downloadable components do not imply redistribution rights or permission to replicate services | References for product mechanisms or integrations with users' existing services; avoid dependence on unpublished interfaces |

Direct evidence: [BuildBuddy root license](https://raw.githubusercontent.com/buildbuddy-io/buildbuddy/master/LICENSE), [BuildBuddy enterprise license](https://raw.githubusercontent.com/buildbuddy-io/buildbuddy/master/enterprise/LICENSE), [Buildbarn repository](https://github.com/buildbarn/bb-storage), [Buildfarm license](https://raw.githubusercontent.com/buildfarm/buildfarm/main/LICENSE), [bazel-remote license](https://raw.githubusercontent.com/buchgr/bazel-remote/master/LICENSE), [sccache license](https://raw.githubusercontent.com/mozilla/sccache/main/LICENSE), [NativeLink current license](https://raw.githubusercontent.com/TraceMachina/nativelink/main/LICENSE), [Nx license](https://raw.githubusercontent.com/nrwl/nx/master/LICENSE), [Turborepo license](https://raw.githubusercontent.com/vercel/turborepo/main/LICENSE).

Recommended expbuild commercial boundary: the open-source core includes basic authentication, isolation, integrity, backup, and observability needed for viable production self-hosting. Prioritize commercial value in operational support, enterprise identity lifecycle, cross-site management, advanced analytics and compliance exports, and hosted services. Preventing cross-tenant access and untrusted-result use must not be paid features. Commercializing SSO itself is a business choice; with enterprise self-hosting first, at least basic OIDC should arrive early to avoid blocking internal trials.

## 7. Product Validation and Milestone Recommendations

1. **Pilot validation**: choose enterprises already using at least two build tools and at least two teams. Record cold builds, warm builds, CI reruns, branch switches, and the same commit in multiple environments. Focus on onboarding time, operational burden, trust domains, and benefits; synthetic GET QPS is no substitute.
2. **Enterprise cache platform v1**: complete end-to-end workflows for 2–3 real ecosystems, each covering onboarding, permissions, quotas, visualization, failure fallback, and operations. Protocol count is a secondary milestone metric.
3. **Extensions and Edge**: demonstrate that adding adapters does not change core authorization; support remote object storage + a local hot tier; propagate revocation and deletion through Edge. Establish single-site HA before multiple sites.
4. **Acceleration orchestration**: integrate mature REAPI execution engines and show concurrency, queue wait, execution time, and cost per worker pool. Do not promise remote execution for every cache protocol.
5. **SaaS readiness**: before commercialization, complete tenant migration, key isolation, region residency, tenant deletion, metering reconciliation, dedicated deployments, and abuse controls, evolving naturally from the tenant model above.

PoC acceptance emphasizes end-to-end metrics: minutes to first verifiable hit; build wall time / CPU-minutes / transferred bytes for the same workload; cache read/write P95/P99; remote-cache overhead per build; negative cross-tenant/cross-trust-domain tests; whether builds still complete without caching; and cleanup/revocation propagation latency. When time savings rely on historical estimates, the UI explicitly labels them “estimated” and names the baseline source; do not simply sum parallel task durations as developer time saved.

## 8. Research Conclusion Index (Detailed Evidence Above)

1. **Position around unified governance and trusted acceleration for enterprise self-hosting; multi-protocol support is not unique.** Depot already covers multiple mainstream tools. [Official overview](https://depot.dev/docs/cache/overview)
2. **Cache platform first, remote execution later.** Buildbarn demonstrates standalone storage and execution routing over standard protocols. [Official README](https://github.com/buildbarn/bb-storage)
3. **Separate tenant/project from external namespaces.** bazel-remote ignoring CAS instances is a concrete counterexample. [Official README](https://github.com/buchgr/bazel-remote)
4. **At minimum, separate content writes from result publication.** BuildBuddy's Developer CAS/AC permission split is worth adopting. [Role documentation](https://www.buildbuddy.io/docs/guide-auth/)
5. **Trusted writes and branch trust domains are kernel requirements.** Nx CREEP shows that immutable/first-write-wins does not prevent untrusted first writes. [Official analysis](https://nx.dev/blog/creep-vulnerability-build-cache-security)
6. **Cache insights must state their sources and explanatory limits.** Develocity input comparison depends on collected build models; opaque-key requests alone cannot provide equivalent diagnostics. [Official tutorial](https://docs.gradle.com/develocity/tutorials/task-inputs-comparison/)
7. **Extension architecture should retain small interfaces and capability declarations.** NativeLink's store graph deserves study, with verification, atomic publication, and isolation defined as explicit invariants. [Store model](https://docs.nativelink.com/explanations/store-model)
8. **Edge is part of the governance system.** Develocity provides node registration, health, statistics, and cross-Edge object cleanup; expbuild must likewise cover deletion/revocation propagation. [Official manual](https://docs.gradle.com/develocity/edge/2.1/)
9. **Prioritize compatibility with existing clients.** sccache already has WebDAV, read-only mode, and tokens; Turbo/Nx have public cache APIs. A proprietary agent need not be mandatory first. [sccache WebDAV](https://github.com/mozilla/sccache/blob/main/docs/Webdav.md), [Nx self-hosting](https://nx.dev/docs/kb/self-hosted-caching), [Turbo documentation](https://turborepo.dev/docs/core-concepts/remote-caching)
10. **Technical selection must also review future commercial use.** NativeLink's current FSL and BuildBuddy's separate enterprise licensing mean a public repository does not establish permission to package and sell it. [NativeLink license](https://raw.githubusercontent.com/TraceMachina/nativelink/main/LICENSE), [BuildBuddy license](https://raw.githubusercontent.com/buildbuddy-io/buildbuddy/master/LICENSE)
