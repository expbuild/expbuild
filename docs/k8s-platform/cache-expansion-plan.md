# expbuild Cache Type Expansion Research and Plan

Compiled: 2026-10-02. Basis: research into official documentation and project materials on 2026-10-01. Status: candidate expansion plan; no runtime, compatibility, or performance validation of new engines has been conducted. This document records the recommended scope and sequence; specific engines and versions will be selected after prototype validation.

Prioritize Docker/OCI image pull caching, BuildKit build caching, and general artifact and CI caching, followed by language-specific package caches. Continue the Kubernetes architecture for managing independent instances, reuse existing engines, and unify lifecycle, credentials, configuration, and observability entry points.

Existing templates cover REAPI/Bazel HTTP, Gradle HTTP, and Apache WebDAV; see [Implementation Status](progress.md) for actual delivery and validation boundaries. This plan does not mean new types are already integrated or change the agreement to leave WebDAV unchanged for now; see the [WebDAV Cache Service Plan](webdav-cache-plan.md) for the internally developed service direction.

## Expansion Principles

- Define service templates by use case and client. The same protocol can serve different purposes; using HTTP does not establish interoperability.
- The platform manages instances, while engines handle protocols and data. Cache requests go directly to engines; the management API and Operator do not participate in individual cache reads and writes.
- Continue using small, independent instances by default. Engines manage their own entries and indexes; do not introduce a unified cross-engine CacheCatalog.
- Each exact template version declares verified storage, cleanup, metric, and client capabilities. Mark missing capabilities as unsupported rather than inventing default implementations.
- A candidate engine's object-storage support does not mean expbuild currently supports object-storage instances; the associated resource model, credentials, and quotas require separate implementation.

Integration assessments and priorities in this document's tables are planning recommendations; linked sources support upstream capabilities and do not replace actual expbuild acceptance testing.

## Cache Types and Candidate Implementations

| Type | Content and purpose | Candidate implementation or integration | Suggested sequence |
|---|---|---|---|
| Docker/OCI image pull cache | Cache upstream image manifests, configurations, and layers to reduce repeated downloads | [Distribution](https://distribution.github.io/distribution/recipes/mirror/), [zot](https://zotregistry.dev/v2.1.21/articles/mirroring/), Harbor | Phase 1 |
| BuildKit build cache | Reuse Dockerfile build steps and multistage build results | Writable OCI Registry using [cache-to and cache-from](https://docs.docker.com/build/cache/backends/registry/) | Phase 1 |
| General artifact and CI cache | Store files, directory archives, and intermediate results by key | HTTP/WebDAV, S3; prioritize validation of [GitLab Runner distributed caching](https://docs.gitlab.com/ci/caching/) | Phase 1; establish data-retention semantics first |
| npm package cache | Package metadata and tarballs for npm, pnpm, and Yarn | [Verdaccio](https://www.verdaccio.org/docs/caching/) | Phase 2 |
| Maven dependency cache | JARs, POMs, plugins, and repository metadata | [Reposilite](https://reposilite.com/), Nexus Repository | Phase 2; validate proxy-cache behavior |
| Python package cache | Wheels, source packages, and the PyPI index | [devpi](https://github.com/devpi/devpi) | Phase 2 |
| Go Modules cache | Module versions' .mod, .info, and .zip files | [Athens](https://docs.gomods.io/configuration/storage/) | Phase 2 |
| C/C++ and Rust compilation cache | Compilation outputs and metadata needed for lookup | Remote storage interfaces of [sccache](https://github.com/mozilla/sccache) and [ccache](https://ccache.dev/manual/latest.html) | Phase 3; prioritize reuse of existing backends |
| Monorepo task cache | Outputs and logs from build, test, and other tasks | [Turborepo](https://turborepo.dev/docs/core-concepts/remote-caching), [Nx self-hosted cache API](https://nx.dev/docs/kb/self-hosted-caching) | Phase 3 |
| HTTP download cache | SDKs, toolchains, installers, and source archives | [NGINX caching proxy](https://nginx.org/en/docs/http/ngx_http_proxy_module.html), configured for designated upstreams | Phase 3, or earlier based on actual demand |
| Other package ecosystems | NuGet, Cargo, Composer, APT, RPM, Alpine, and others | [Nexus format support](https://help.sonatype.com/en/formats.html), corresponding Pulp plugins, or dedicated services | Validate individually based on customer needs |
| Nix binary cache | Built Nix store contents | [Attic](https://docs.attic.rs/) | Specialized extension; further maturity assessment required |
| Model and dataset cache | Model files, datasets, and their downloaded content | First research upstream-specific APIs, authentication, redirects, and storage protocols | Specialized extension; engine not yet selected |

These types do not each require a new engine. For example, an OCI engine can host images, BuildKit caches, and OCI artifacts, but product entry points, permissions, cleanup policies, and acceptance criteria should be defined separately. Maven dependency caching accelerates dependency downloads, while the existing Gradle HTTP cache reuses task results; they complement each other.

## Docker and OCI Services

### Image Pull Caching and BuildKit Build Caching

First define templates for two distinct purposes:

| Purpose | How data enters the service | Main configuration |
|---|---|---|
| Image pull cache | The service fetches from upstream when a client requests an uncached image | Upstream address and credentials, allowed repository scope, revalidation and retention policies |
| BuildKit build cache | Build clients explicitly upload cache data for later builds to read | Read/write credentials, cache repository or reference, branch isolation, retention and reclamation policies |

BuildKit's Registry backend can store caches separately from final images and supports `mode=max` to export multistage build caches. Integration still requires validation of client versions, build drivers, and media-type combinations. [Docker Registry cache documentation](https://docs.docker.com/build/cache/backends/registry/)

Use independent instances for the first release, then assess repository isolation within a single engine later. An instance supporting only pull-through proxying cannot simultaneously be treated as a writable cache repository; for example, Harbor proxy-cache projects explicitly do not support push. [Harbor proxy cache](https://goharbor.io/docs/main/administration/configure-proxy-cache/)

### Engine Comparison

| Candidate | Capabilities in official sources | Suggested assessment for expbuild | Validation priorities |
|---|---|---|---|
| Distribution | Single-upstream pull-through caching and expiration cleanup; official guidance recommends filesystem storage for pull-through caches | Minimal implementation and compatibility baseline | Docker/containerd/BuildKit integration, credentials, cleanup, metric definitions |
| zot | On-demand synchronization, local and object storage, retention policies, online GC, Prometheus metrics | Primary candidate for broader OCI uses | Original digests, multi-architecture images, upstream authentication, reads during cleanup, resource overhead |
| Harbor | Proxy-cache projects for multiple upstream types, quotas, retention policies, and repository management | Prioritize integration with existing enterprise Harbor deployments | Standalone deployment cost, external-service ownership, management permissions, and quota mapping |

Sources: [Distribution pull-through cache](https://distribution.github.io/distribution/recipes/mirror/), [zot image synchronization](https://zotregistry.dev/v2.1.21/articles/mirroring/), [zot storage](https://zotregistry.dev/v2.1.21/articles/storage/), [zot retention policies](https://zotregistry.dev/v2.1.21/articles/retention/), [zot metrics](https://zotregistry.dev/v2.1.21/articles/monitoring/), [Harbor proxy cache](https://goharbor.io/docs/main/administration/configure-proxy-cache/).

Prototype Distribution and zot comparatively before fixing the final choice. Integration with external Harbor instances is only a candidate direction and does not mean the current Operator can manage external registries.

### Protocol and Cleanup Boundaries

The Docker daemon's `registry-mirrors` mechanism targets Docker Hub; it does not establish transparent proxying for every Registry. Other upstreams need corresponding client configuration or rewritten image references; the platform should generate client-specific integration instructions. Distribution also requires the mirror address to be at the domain's root path, aligning with the platform's dedicated instance domains. [Distribution documentation](https://distribution.github.io/distribution/recipes/mirror/)

Pulling images by digest must preserve content identity. zot has specific configuration for mixed Docker/OCI image compatibility and digest preservation; prototypes should cover digest-pinned references, multi-architecture manifests, and associated signatures or reference information, rather than testing only pulls by tag. [zot synchronization and compatibility configuration](https://zotregistry.dev/v2.1.21/articles/mirroring/)

Understand image cleanup as three separate steps: retention policies select references eligible for deletion, GC reclaims data no longer referenced, and capacity control determines behavior when space runs out. Native GC support does not imply LRU eviction under a capacity limit; the UI must not combine these into one switch. [zot storage and GC](https://zotregistry.dev/v2.1.21/articles/storage/)

The authorization scope of upstream credentials must match instance access scope. A proxy's access to private upstream repositories must not leak to other projects through a shared cache endpoint with broader permissions. [Harbor proxy credential boundaries](https://goharbor.io/docs/main/administration/configure-proxy-cache/)

## Artifact and CI Caching

### Data Purposes and Retention Rules

“Artifacts” describes file purposes, not a universal caching protocol. Phase 1 should establish the following boundaries before defining exposed templates:

| Data purpose | Examples | Suggested management rules |
|---|---|---|
| Rebuildable cache | Dependency directories, compilation directories, temporary-result archives | Read/write by key, with expiration and capacity eviction allowed; clients can regenerate lost data |
| Pipeline artifacts | Intermediate packages and test reports needed by subsequent stages | Associate with a build or task, verify integrity, and set an explicit retention period |
| Release artifacts | Official version installers and delivery packages | Versioning and immutability, retention protection, download permissions; do not reuse ordinary cache auto-eviction semantics |

GitLab treats cache and artifacts as separate mechanisms: the former reuses cached data, while the latter stores and passes task outputs. expbuild's service design should preserve this distinction. [GitLab caching and artifacts](https://docs.gitlab.com/ci/caching/)

Validate rebuildable caching in the first round. Pipeline and release artifacts remain separate candidate capabilities; the product scope of a full artifact repository is undecided, and cache templates do not promise permanent retention by default.

### Integration Path

Ordinary files and CI archives can use HTTP/WebDAV or S3. GitLab Runner already supports distributed caching and object-storage lifecycle cleanup, making it suitable as the first real client. S3 supplies only the storage interface; key rules, fallback matching, archive formats, and hit semantics remain the responsibility of clients or adapter services. An S3-compatible backend does not establish compatibility with every CI system. [GitLab distributed caching](https://docs.gitlab.com/ci/caching/)

OCI artifacts can reuse a Registry, with ORAS uploading and downloading ordinary files. Declare clients, artifact formats, and retention policies separately; file upload support does not establish artifact-repository features such as release approvals or complete version governance. [ORAS quickstart](https://oras.land/docs/quickstart/)

GitHub Actions requires a separate adapter. Self-hosted runners connected to GitHub.com still use GitHub's cache storage by default; exposing S3 does not directly replace official `actions/cache`. Later work should specify whether to provide a dedicated Action/CLI or implement and validate the corresponding service protocol. [GitHub caching overview](https://docs.github.com/en/actions/concepts/workflows-and-actions/dependency-caching)

## Package and Task Caching

### Dedicated Package Services

Prioritize evaluating Verdaccio, devpi, Athens, and Reposilite, verifying real package-manager requests, index refresh, private upstreams, offline reads, recovery, and cleanup behavior for each. Measure resource overhead, startup time, and per-instance cost rather than relying only on projects' claims of being lightweight.

Package services need separate descriptions of metadata expiration, content eviction, and physical-space reclamation. Verdaccio's `maxage` controls upstream metadata validity and cannot be displayed directly as package-file retention; cleanup and metrics for third-party storage plugins also require separate certification. [Verdaccio caching policy](https://www.verdaccio.org/docs/caching/)

When many package formats are needed, evaluate Nexus or Pulp as another deployment option. At the time of research, Nexus Community Edition documentation listed usage limits of 40,000 components and 100,000 requests per day; recheck the target version and license during selection. Pulp provides on-demand downloads and space reclamation, with exact support depending on plugins; a reclamation API does not establish implemented automatic LRU. [Nexus usage limits](https://help.sonatype.com/en/usage-center.html), [Pulp on-demand downloading](https://pulpproject.org/pulpcore/docs/user/learn/on-demand-downloading/), [Pulp space reclamation](https://pulpproject.org/pulpcore/docs/user/guides/reclaim-disk-space/)

### Compilation and Monorepo Tasks

sccache supports remote backends including S3 and WebDAV; ccache also provides remote storage mechanisms. Integration can initially reuse existing services, adding client configuration, independent namespaces, and compatibility acceptance tests. Their keys, data formats, and statistics differ, so entry interoperability must not be assumed. Certify ccache remote storage and helper mechanisms against specific client versions as well. [sccache](https://github.com/mozilla/sccache), [ccache manual](https://ccache.dev/manual/latest.html)

Turborepo provides a public remote-cache protocol and community implementations, while Nx provides an OpenAPI for self-hosted services. Evaluate separate protocol adapters reusing file or object storage, while managing authentication, task content, and compatible versions separately. [Turborepo protocol](https://turborepo.dev/docs/core-concepts/remote-caching), [community service implementation](https://github.com/ducktors/turborepo-remote-cache), [Nx API](https://nx.dev/docs/kb/self-hosted-caching)

### Specialized Extensions

For Nix, investigate Attic. Its documentation describes an S3 backend, deduplication, and GC, but still labels it an early prototype; further check maintenance and release status. [Attic](https://docs.attic.rs/)

Model and dataset caching requires dedicated research. Hugging Face downloads involve Hub APIs, redirects, and separate storage services; proxying one domain alone does not establish compatibility. Dragonfly's P2P acceleration may also be investigated for large-scale image or file distribution, but this is a distribution-layer extension and must not replace each cache service's own data and permission semantics. [Hugging Face download path](https://github.com/huggingface/hub-docs/blob/main/docs/hub/datasets-downloading.md), [Dragonfly](https://d7y.io/docs/)

## Platform Template Capability Extensions

Existing templates integrate through a compiled-in registry, and current declarations cannot express every candidate service. Add the following capabilities incrementally alongside the first prototypes, avoiding an oversized unified model before prototyping.

| Capability dimension | What the template must describe |
|---|---|
| Purpose and protocol | Image proxy, build cache, file archive, release artifacts; corresponding protocols and operations |
| Data source | Client writes, upstream fetches, or a verified combination |
| Upstream configuration | Address allowlists, repository scope, credential references, revalidation, disconnected behavior |
| Storage | PVC, object storage, optional local acceleration tier; capacity and cleanup boundaries for each |
| Cleanup policies | Support and effective timing for capacity eviction, expiration, version retention, GC, and retention protection |
| Observability | Metric sources, hit units, upstream traffic, reclamation results, data-quality status |
| Clients | Certified versions, integration configuration, authentication, read/write permissions, and real acceptance results |

Object-storage instances need separate designs for credentials, bucket or prefix ownership, quotas, and deletion policies; PVC capacity and object-storage capacity are not the same field. Engines should clean up entries, while the Operator declares configuration, triggers supported maintenance actions, and observes results.

Organize the service catalog by purpose, providing Chinese and English names, configuration guidance, and client examples in line with the platform's global audience. Unsupported policies must not appear as selectable options or be accepted and silently ignored.

## Observability and Statistical Semantics

Continue the identity isolation, low metric cardinality, and missing-data rules in the [Observability Plan](observability-plan.md). Evaluate at least requests, server errors, latency, traffic, capacity, and cleanup results for new types; only metrics that can actually be measured enter template capability declarations.

| Statistic | Meaning and limitations |
|---|---|
| Request hits | Whether valid cache queries directly obtain existing data; count authentication failures, server errors, and successful first upstream fetches separately |
| Byte hit rate | Proportion of requested data bytes served from cache; distinguish request counts from byte counts |
| Upstream traffic | Actual upstream requests and transferred data; do not fabricate precise savings without observing upstream behavior |
| Build task hits | How much work BuildKit, compilers, or task clients skipped; requires client data |
| Storage usage | Show logical entries, actual physical usage, temporary uploads, and space pending reclamation separately |
| Cleanup results | Show reference deletion, data reclamation, bytes freed, failures, and backlog separately |

A successful response is not a cache hit: a proxy's first successful upstream fetch also returns success. Having `/metrics` does not establish an accurate cache hit rate; inspect counter definitions and compare cold and warm requests. Each template counts operations such as metadata, manifest, blob, and task results separately, without directly averaging hit rates with different meanings.

## Suggested Implementation Sequence and Acceptance

| Phase | Work scope | Outputs before the next phase |
|---|---|---|
| Phase 1 | Compare Distribution and zot; prototype image pull, BuildKit, and general artifact/CI caching | Establish engines and versions, artifact-retention boundaries, storage approach, client compatibility, and metric gaps |
| Phase 2 | Verdaccio, devpi, Athens; validate Maven candidates | Package templates, upstream authentication and isolation, metadata refresh, executable cleanup, and client examples |
| Phase 3 | sccache/ccache, Turborepo/Nx, HTTP download proxy, and other package ecosystems | Client/template certification matrix, reusable storage adapters, separate statistics |
| Specialized extensions | Nix, models and datasets, P2P distribution, external Harbor, and others | Separate plans based on actual user needs, avoiding prerequisites for initial delivery |

This sequence is a recommendation, not a calendar or delivery commitment. HTTP upstream proxies still require validation of Cache-Control, revalidation, authentication-response isolation, and eviction; this plan does not extend the existing Apache WebDAV template further.

Minimum acceptance scope for new templates:

- Real-client cold requests, warm requests, missing data, and error behavior; OCI additionally validates digests, multi-architecture images, and BuildKit cache restoration.
- Private upstream authentication, instance read/write permissions, credential rotation, and project isolation; cache ownership must not broaden existing authorization.
- Concurrent reads/writes, duplicate upstream fetches, interrupted uploads, restart recovery, exhausted disk or storage budgets, and concurrent cleanup and reads.
- Compare cleanup rules with space ultimately released, and ensure ordinary cache policies do not delete protected retained data.
- Lifecycle and management flow: creation, configuration, suspension/resumption, deletion, storage retention, and consistent Helm/API/Operator behavior.
- Verify hits, misses, errors, and upstream fetches in metrics; measure startup, throughput, latency, memory, and recovery duration before defining specifications.

Each prototype should ultimately deliver a pinned version or image digest, native configuration and capability matrix, real-client cases, metric mappings, cleanup and recovery results, and known limitations. Proceed to formal template, CRD, management API, and UI implementation only after passing validation; this document does not initiate that development work.
