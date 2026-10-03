# expbuild: Kubernetes cache-service management platform

Updated: 2026-10-01. Status: implementation in progress; selected REAPI, WebDAV, and Gradle paths have passed disposable-cluster acceptance, while complete product and production-environment qualification remain unfinished. See [outstanding work in the implementation status](progress.md#current-outstanding-work) for current development tasks and validation boundaries, and [testing instructions](testing.md) for validation methods. The current WebDAV implementation remains unchanged for now; see the [custom WebDAV cache-service proposal](webdav-cache-plan.md) for future direction.

See [implementation-plan.md](implementation-plan.md) for implementation contracts and task breakdowns. This document defines the product and architecture; the implementation contract defines modules, data, state machines, and delivery gates. Together they form the current implementation baseline.

The [platform observability plan](observability-plan.md) defines the complete goals for platform and cache-instance monitoring, log diagnostics, and alerts. See [observability integration](observability.md) for the first implementation, user entry points, and deployment configuration, and [monitoring instructions](monitoring.md) for the existing Bazel history endpoint.

See [cache-type expansion research and planning](cache-expansion-plan.md) for candidate engines, integration boundaries, and suggested sequencing for Docker/OCI, BuildKit, artifact and CI caches, package caches, and task caches. That document records directions awaiting validation, not implemented capabilities.

This document is independent of the earlier unified-cache-engine proposals in `docs/design` and `docs/strategy`. Those proposals remain historical research and are not prerequisites for this design.

## Summary

expbuild is a Kubernetes-based cache-service management platform. Users choose a service template and configure resources and storage to create independent cache instances; the platform provides unified access configuration, lifecycle management, instance statistics, and eviction-policy management.

Established directions:

- Prioritize enterprise self-hosting, with Kubernetes as the instance runtime foundation.
- Reuse open-source cache engines; the first REAPI template uses bazel-remote, with its exact version to be pinned through a PoC.
- Give instances separate workloads, storage, and credentials; native protocol requests go directly to cache services.
- Unify management capabilities and interfaces without requiring all engines to share protocol semantics or eviction algorithms.
- Start with small independent services, without a unified CacheCatalog or cross-engine content index.

Initial implementation baseline: one cluster, persistent single-replica instances, a Go Operator, CacheInstance CRD, React/TypeScript management UI, TypeScript management API, PostgreSQL management data, and shared Prometheus-compatible metrics infrastructure. Management components join the main repository through selective migration of existing code. Time-boxed PoCs determine the HTTP/WebDAV engines, external ingress implementation, compatible cluster versions, and resource specifications before the corresponding templates are developed.

Sources of constraints: the user explicitly requested Kubernetes, multiple cache services, small independent instances, separate statistics, configurable eviction and extensibility, and enterprise self-hosting first. Languages, directories, and starting with a single cluster are engineering choices in this proposal. Mac, K3s/k3d, kind, specific cloud vendors, and educational technical discussions are not product or architecture constraints; users are not required to use a particular development device or purchase a particular cloud service.

This document covers product boundaries, architecture, resource models, template contracts, operations, engine selection, image delivery, development environments, and acceptance paths. Configuration and directory layouts are design examples, not existing executable implementations.

## 1. Product and initial scope

Goal: users create small, independent cache services for their workloads and receive connection configuration, instance statistics, and storage/eviction-policy management. Enterprise self-hosting comes first.

The platform owns instance lifecycle and governance; cache engines own protocols and data semantics. The initial release does not require every engine to share an index, physical storage, deduplication, or cache-entry model.

Initial recommendation: a single cluster, administrator-provided templates, one replica per instance, persistent volumes, separate credentials, in-cluster access plus one qualified external ingress, instance metrics, and native eviction policies. Manual pause/resume is supported; transparent scale-to-zero and wake-on-request are not provided.

“Fast creation” separately measures API acceptance, resource creation, Pod startup, application readiness, and the first successful protocol request. Image pulling, volume provisioning, and historical-data scanning are recorded separately; measure first, then set SLOs.

## 2. Distinguish protocols from service purposes first

HTTP is a transport, not a complete definition of cache semantics. Templates must state the service purpose:

| Service profile | Main behavior | Validation needed |
|---|---|---|
| REAPI cache | ActionCache + CAS, no remote execution | Client compatibility, authentication, native GC, metrics |
| HTTP artifact cache | PUT/GET build artifacts through agreed keys/paths | Qualify Bazel HTTP, Gradle, etc. separately; do not assume generic interoperability |
| HTTP proxy cache | Configure upstreams and cache responses | cache-control, isolation of authenticated responses, revalidation, upstream restrictions |
| WebDAV cache | Client reads/writes of files and directories | Required client methods, locks, concurrent writes, safe cleanup mechanisms |

Initial goals cover REAPI cache, HTTP artifact cache, and WebDAV cache. The first deliverable path uses bazel-remote, exposing both REAPI and Bazel HTTP. These can be two access methods for the same instance without deploying two engines. WebDAV is the second independent engine adapter. Gradle HTTP has been integrated as the third exact-version template and passed PVC, Helm/API, and HTTPS Gateway acceptance on disposable kind; production CSI and performance qualification remain outstanding. HTTP proxy cache belongs to the next set of independent templates, without mixing forms or hit-rate definitions. Pin versions and actual capabilities after PoCs; protocol names alone do not establish compatibility.

## 3. Control plane and runtime plane

```text
Web / CLI → Management API → Kubernetes CacheInstance CR
                                  ↓
                              Operator
                                  ↓
                     StatefulSet / Service / PVC
                     ConfigMap / Secret refs / NetworkPolicy

Build clients → TLS ingress or cluster Service → Cache engine
Monitoring    ← Engine metrics / optional exporter / cluster resource metrics
Console       → Metrics queries authorized per instance
```

The Operator uses reconciliation loops to turn declarations into actual resources, following the Kubernetes Operator pattern [S1]. The management API does not directly modify child resources such as StatefulSets managed by the Operator.

Implement the Operator with Go + controller-runtime. Move the console and management API into the main repository, restructuring them for the new project-permission and instance models. Reuse does not establish that expbuild-admin's original authorization implementation is adequate. Cache instances run their respective engine images, without requiring a common language.

The initial release does not mandate sidecars. Prefer native engine authentication and metrics; add a proxy or exporter only when a capability is missing and a reliable implementation exists, so auxiliary components do not cost more than the small engine itself.

## 4. Core objects and authoritative sources

| Object | Responsibility and source |
|---|---|
| EngineTemplate | Administrator-maintained versioned template package; initially shipped with the platform, without requiring a dynamic template CRD |
| CacheInstance | Namespaced CRD; sole authority for desired instance configuration |
| CacheInstance.status | Operator-written observations, actual versions, conditions, and endpoints |
| Kubernetes Secret | Instance credentials; CRs contain only same-namespace references |
| Platform database | Users, teams, project authorization, audits, asynchronous-operation records; no independently editable duplicate instance spec |
| Metrics system | Time-series statistics; no per-request or high-frequency metrics written to CR status |

No cross-system transaction is assumed between the database and Kubernetes. The management API first persists operation intent and an idempotency key, then writes the CR, checks fixed resource names and request fingerprints on retries, and finally records the outcome. Failures or lost responses can be retried and reconciled. The CR is ultimately authoritative for instance existence and desired configuration.

Recreating an instance with the same name produces a different CR UID; audit, metrics, and storage ownership all associate with the UID to prevent historical-data confusion. The API service account checks project mappings rather than trusting a Kubernetes namespace submitted by a client.

The initial release is managed through UI/API. Administrator-created CRs do not automatically receive business ownership or appear to users; they need explicit import and verification. GitOps management is deferred: in that mode, UI mutations will be disabled and the CR will remain authoritative, avoiding multiple writers overwriting one another.

## 5. CacheInstance draft

The following is a design example, with no corresponding CRD or installable template yet. Capacity and resources illustrate fields, not minimum engine specifications or performance promises.

```yaml
apiVersion: cache.expbuild.io/v1alpha1
kind: CacheInstance
metadata:
  name: bazel-ci
  namespace: expbuild-team-a
spec:
  templateRef:
    name: reapi-cache
    version: "0.1.0"
  desiredState: Running
  resources:
    requests:
      cpu: "250m"
      memory: "256Mi"
    limits:
      cpu: "2"
      memory: "1Gi"
  storage:
    className: standard
    capacity: 100Gi
    deletionPolicy: Retain
  access:
    exposure: ClusterInternal
    credentialsSecretRef: bazel-ci-auth
  eviction:
    capacity:
      maxBytes: 85899345920
    enginePolicy: lru
  engineConfig: {}
```

Resource requests/limits are validated by the template. Template versions bind pinned image digests, configuration schemas, and metric mappings; instance upgrades are explicit rather than drifting automatically with the latest template version. `engineConfig` is an allowlisted template configuration, not a way for users to inject arbitrary Pod specs, container commands, or host mounts.

`eviction` expresses cross-engine form intent only; it does not promise that every engine implements the illustrated policies. Unsupported fields must be rejected, not silently ignored.

Status includes `observedGeneration`, `appliedTemplateVersion`, `appliedConfigHash`, `credentialRevision`, `endpoints[]`, `conditions`, and `lastOperationRef`. Conditions include at least `Accepted`, `StorageReady`, `WorkloadReady`, `EndpointReady`, and `PolicyApplied`, plus failure reason/message. Ready must correspond to the current generation; Pod Running does not mean the instance is usable.

## 6. Template adapter contract

A template package describes:

- Service profile, supported client versions, and capability matrix.
- Pinned images, configuration schema, default resources, and minimum resource constraints.
- Workload rendering, configuration, ports, startup/readiness/liveness probes.
- Supported storage types, replica counts, update and pause strategies.
- Native authentication, credential rotation, and read-only/read-write permission capabilities.
- Metric names and semantic mappings; missing capabilities explicitly marked unavailable.
- Mapping of eviction policies to native configuration/APIs and confirmation that they took effect.
- Maintenance-operation implementations and concurrency protection where needed, plus client connection examples.

Initially use adapters compiled into the Operator and static schemas to validate commonality across service profiles. Introduce signed template packages and an extension SDK later only if independent releases are needed.

## 7. Kubernetes orchestration and lifecycle

A project maps to a platform-managed Kubernetes namespace; instances use separate workloads, Services, PVCs, and credentials. Label selectors and NetworkPolicies control network access between instances. Namespaces alone do not provide network isolation; NetworkPolicy depends on actual CNI support [S3].

Persistent instances initially default to single-replica StatefulSets. Declaring one replica does not enforce single-writer isolation across nodes. Prioritize validating CSI support for ReadWriteOncePod; ReadWriteOnce means read/write by one node, not a single-Pod lock. Failover after node loss depends on storage fencing; force-deleting the old Pod does not by itself establish safety [S2].

Reconciliation steps: validate template/input → create/check storage → render configuration and credential references → create workload and Service → configure ingress and monitoring discovery → aggregate readiness conditions. Every step is idempotent and reentrant; errors record the specific dependency rather than requiring deletion and recreation of the entire instance.

Lifecycle:

- Create: the API returns an asynchronous operation and displays stages such as waiting for a volume, pulling images, initialization, and protocol readiness.
- Update: use resourceVersion to avoid overwriting concurrent changes; display declared and actually applied versions separately.
- Pause: take the instance offline while retaining its PVC; resume includes startup and possible index scanning.
- Upgrade: allow maintenance interruption for a single replica and first verify engine-format compatibility; do not promise that every upgrade permits direct image rollback.
- Expand: enable only after StorageClass/CSI support and template validation; no volume shrinking initially [S2].
- Delete: revoke access and stop workloads first, then retain or clean storage according to explicit policy.

Default to `Retain`. PVCs to retain must not have ownerReferences that trigger garbage collection with CR deletion; record instance UID and ownership, and delete only under explicit Delete policy. PVC deletion and PV reclaimPolicy are separate layers; PVC absence alone does not prove backend data erasure [S2]. Reclaim, expiration cleanup, and usage statistics for retained volumes need management entry points.

Finalizers protect only necessary, retryable cleanup. Deletion failures display blocking resources and manual recovery steps. Old-instance deletion must remain possible after template uninstallation or upgrades.

For external access, initially choose one qualified ingress implementation: verify gRPC/HTTP2, streaming uploads, timeouts, large requests, and WebDAV methods, not just webpage GET. Endpoints use stable instance identity; no runtime configuration may put credentials into URL examples or logs.

Each instance supports its own subdomain, defaulting to `cache-<instance-id>.<base-domain>`, with separate subdomains per protocol where necessary; display-name changes do not change the domain. Shared ingress routes by hostname, without a public IP per instance. Administrators initially prepare the base domain, wildcard DNS, and certificates; the Operator creates routes and reports readiness. Private-network deployment is supported; user-defined domains and DNS-provider automation come later. See the implementation plan for the detailed contract.

## 8. Eviction policies

Display three quantities separately: volume capacity, engine cache budget, and actual current usage. PVC capacity does not automatically implement application-level LRU or TTL. A 100 GiB volume with an 80 GiB cache budget is only a starting point for reserving index/temporary-file space and needs calibration through engine tests.

Policy priority:

1. Native engine configuration/API: the platform validates, applies, and confirms effective state.
2. Engine-adapted maintenance jobs: explicit maintenance locks, progress, failure retries, and state display.
3. No reliable engine support: show unsupported; if necessary, offer only complete clearing during a maintenance window.

Do not provide a generic cross-engine “find files and delete them” job. REAPI references, WebDAV locks, and unfinished uploads require understanding by the respective adapter. Kubernetes CronJob concurrency policy does not replace concurrency protection inside the engine.

TTL must state whether it starts at creation, last write, or last access; a common “retention time” label must not hide different semantics. Templates also disclose whether LRU is approximate, eviction is asynchronous, or capacity may briefly exceed the limit. Successful configuration and effective policy are displayed separately.

WebDAV instance creation explicitly states that data may be reclaimed and offers only cleanup mechanisms validated for the template. Labeling an ordinary file service a cache does not give it a reliable eviction policy.

## 9. Statistics

Provide unified displays of resource usage, request counts, error rates, latency, traffic, capacity, and service state. Request-level statistics may come from engines or qualified ingress, but their measurement boundaries must be explicit. Resource metrics are not business metrics.

Show hit rates by operation: REAPI ActionCache hits, CAS availability checks, and CAS download results are independent; HTTP proxy hits come from the engine; WebDAV GET 2xx is not automatically a cache hit. Missing values display unknown, not 0.

Suggested labels: `cluster_id / namespace / instance_uid / engine / operation / outcome`. Do not use digests, complete paths, usernames, or tokens as regular time-series labels. Hit rates use ratios of counter increases over the same window; a zero denominator displays no requests. State which error types are included and excluded.

The platform provides per-instance authorized query APIs rather than arbitrary PromQL for ordinary users. Collection failures must not appear as cache-service outages. Initially reuse shared Prometheus-compatible infrastructure; use ServiceMonitor only when its CRD is installed, otherwise provide standard scrape configuration.

## 10. APIs and initial pages

Suggested management APIs (draft paths):

| API | Purpose |
|---|---|
| GET /v1/templates | Templates, capabilities, versions, configuration schemas |
| POST /v1/projects/{project}/instances | Idempotent creation, 202 + operation ID |
| GET /v1/projects/{project}/instances/{id} | Desired configuration, observed state, failure reasons |
| PATCH /v1/projects/{project}/instances/{id} | Version-conditional updates, applied asynchronously |
| POST /v1/projects/{project}/instances/{id}/operations | Pause, resume, template-supported maintenance |
| GET /v1/projects/{project}/operations/{id} | Operation progress and result |
| GET /v1/projects/{project}/instances/{id}/metrics | Queries with restricted time ranges and metric sets |
| DELETE /v1/projects/{project}/instances/{id} | Deletion with explicit storage policy, 202 |

All operations bind project permissions, distinguishing viewing, maintenance, credential management, policy changes, and deletion. Credential values do not appear in ordinary detail APIs. Clear/delete audits record the initiator, instance UID, configuration version, and final outcome.

Pages: template selection, instance creation, instance list, detail overview, connection configuration, statistics, policies, events, and operation history. Explicitly explain unsupported template capabilities rather than presenting nonfunctional buttons.

## 11. REAPI engine selection and the first instance template

### 11.1 Adopt bazel-remote

The first REAPI template adopts the open-source [bazel-remote](https://github.com/buchgr/bazel-remote) project rather than continuing to extend the old expbuild prototype as the initial protocol engine. The project is Apache-2.0 licensed and supports standalone-program and container deployment [S4, S5].

Capabilities documented upstream and their platform mappings:

| Engine capability | expbuild integration |
|---|---|
| REAPI ActionCache, CAS, Capabilities, and corresponding ByteStream APIs | REAPI profile without Execute/worker requirements |
| Bazel HTTP `/ac`, `/cas` reads/writes | The same instance can expose a Bazel HTTP endpoint |
| Local disk cache, capacity limit, least-recently-used file eviction | Separate PVC with template-mapped cache budget |
| Prometheus metrics and status endpoint | Instance collection and overview |
| Authentication such as htpasswd and mTLS | Secret injection and verified credential configuration |
| Proxy backends such as object storage | Future template capabilities; initially validate local PVCs |

REAPI FindMissingBlobs is an existence-query path for cache uploads and does not require remote execution. The platform reuses the engine implementation; the PoC includes batched upload queries and real-client validation rather than building another global existence service.

Initial resource mapping:

```text
CacheInstance: bazel-ci
  ├── StatefulSet: single-replica bazel-remote, pinned image digest
  ├── PVC: engine cache directory
  ├── ConfigMap: capacity, listen addresses, metrics, credentials-file path
  ├── Secret: credentials or certificates
  ├── Service: REAPI gRPC and optional Bazel HTTP
  └── Monitoring discovery: associated with instance_uid
```

Bazel HTTP is not generic Gradle HTTP or WebDAV. Do not treat naming behavior for `instance_name` or AC keys as tenant isolation; platform isolation remains separate instances, credentials, storage, and network-access boundaries.

### 11.2 Limits on publicly declared template capabilities

Initially expose capacity control and native engine eviction. Before the PoC, mark the following as unverified rather than promising them: arbitrary TTL, credential-based read-only/read-write separation, exact entry deletion, configuration changes without restart, immediate credential hot reload, and multiple processes safely sharing a cache directory.

Require authentication by default; if only instance-level authentication is verified, expose only instance-level capability. Anonymous-read configuration is not an “authenticated read-only user” permission. For finer permissions, first validate the engine or a protocol-aware proxy rather than inferring all gRPC permissions from HTTP methods.

Initially treat configuration changes as potentially requiring restart and display maintenance impact. Writing new configuration to a StatefulSet does not mean the engine applied the policy; pin runtime confirmation and probes in the template PoC.

### 11.3 Later candidates

[Buildbarn bb-storage](https://github.com/buildbarn/bb-storage) can provide standalone remote caching, supports composable storage backends, offers container images, and is Apache-2.0 licensed [S6]. Evaluate it as a second REAPI engine when different storage topologies are needed, without expanding the initial scope alongside the first template.

## 12. Images, templates, and enterprise delivery

### 12.1 Store three kinds of content separately

| Content | Location | Lifecycle |
|---|---|---|
| Container images | OCI image registry | Build, publish, synchronize, retain versions |
| Templates, Dockerfiles, configuration schemas | Git repository | Code review and versioned release |
| Cache content and runtime indexes | Instance PVC | Managed by instance storage policy |

Do not put runtime data in images, use container writable layers as persistent caches, or commit large image archives to Git.

Suggested layout, with corresponding implementations not yet created:

```text
expbuild/
├── apps/
│   ├── admin-web/                 # Management UI, selectively migrated from the existing repository
│   └── admin-api/                 # Management API, project permissions, audits, operation queue
├── operator/                       # CRD, reconciliation, template adapters
├── templates/
│   ├── bazel-remote/               # Template description, schema, defaults, metric mappings
│   └── webdav/
├── images/                         # Only Dockerfiles and scripts that actually require customization
├── deploy/charts/expbuild/          # Platform installer; instances are managed by the Operator
├── dev/                            # Optional development configuration and helper scripts
└── tests/e2e/                      # Instance lifecycle and real protocol tests
```

This is the target layout; this design update does not migrate the repository. Preserve old repositories and historical references during migration, review dependencies and licenses first, and then move useful modules. The old Rust protocol prototype does not join the new platform's default build/delivery path. Build separate images for the three platform components; a unified repository does not require combining deployment processes.

Prefer qualified upstream images. Maintain wrapper images only when startup scripts or modules are needed, and source forks only when engine behavior must change. Templates pin image digests and record upstream versions, architectures, and origins. Retain project licenses and image-dependency distribution information with delivery manifests.

### 12.2 Enterprise private registries and offline installation

Platform installation configuration allows administrators to override image registries and pull-credential references:

```yaml
global:
  imageRegistry: registry.company.internal
  imagePullSecrets:
    - company-registry
```

This is an installer design example, not yet implemented. Registry overrides require explicit mapping from original images to target repositories; replacing only a hostname cannot be assumed sufficient. Verify target digests after synchronization; if synchronization tools change manifests, produce a newly verified image lock manifest.

imagePullSecrets must exist in the namespace of the workload using the image. A Secret in the control-plane namespace does not automatically become referenceable by all instances; installation configures approved credential references or controlled copies in managed namespaces.

Each release provides the platform installer, CRDs, template versions, complete image list, supported architectures, and configuration/data-format upgrade instructions. Offline delivery includes corresponding image archives or synchronization packages; installation must not implicitly download plugins or engines from the public Internet.

Release path: Git changes → configuration/adapter tests → image builds or upstream-image validation → protocol end-to-end tests → template and image-manifest release. Instances pin template versions and upgrade explicitly rather than following latest.

## 13. Validation layers and optional development environments

Daily development does not require a full Kubernetes cluster to run continuously. Test layers:

| Layer | Environment | Validation |
|---|---|---|
| Console | API fixtures | Forms, state, permission display, interaction |
| Configuration and templates | Ordinary unit tests | Validation, configuration mapping, resource rendering |
| Operator | controller-runtime envtest | CRDs, API behavior, reconciliation, status, retries |
| Engine | Standalone Docker containers | Protocols, authentication, metrics, capacity eviction |
| Full integration | kind; optionally k3d | Real Pods, PVCs, services, clients, lifecycle |
| Production adaptation | Test cluster close to the deployment target | CSI, CNI, ingress, node failure, recovery |

envtest starts an API server and etcd but has no kubelet or built-in workload controllers, so it cannot validate actual Pod execution or automatic ownerReference garbage collection [S7]. Manually setting readiness in tests is simulation, not successful real execution.

kind runs Kubernetes in container nodes; k3d runs K3s in Docker [S8, S9]. Both are optional integration environments; remote or managed clusters can also be used. Acceptance depends on protocols, resources, and lifecycle behavior rather than a particular local tool. Choose and pin the CI environment during implementation; local clusters do not automatically establish production CSI and network-isolation correctness.

If local resources are insufficient, run kind or a dedicated development cluster on a separate development server, with the Operator and management API running locally through kubeconfig for breakpoint debugging. Each development environment should run only one reconciliation version for a given resource scope; avoid local and in-cluster Operators of different versions rewriting the same instances.

Local images can be loaded into kind; remote clusters obtain images from a development registry. Access applications through port forwarding or development ingress. Development credentials authorize only development resources; do not reuse production cluster-administrator credentials.

Planned commands, not yet implemented:

```text
make dev          # Local console/API development; explicitly distinguish fixture and real-backend modes
make test         # Ordinary tests and envtest
make cluster-up   # Prepare a cluster through the selected development-environment adapter
make test-e2e     # Deploy instances and run lifecycle/protocol tests
```

## 14. Development sequence and acceptance

1. **Engine PoC**: validate bazel-remote first, pinning version, clients, runtime resources, authentication, metrics, eviction, and recovery behavior; complete both REAPI and Bazel HTTP paths. Then choose a WebDAV engine, explicitly blocking inadequate cleanup rather than substituting deployment success for validation.
2. **Minimal Operator workflow**: CRD, template validation, single-instance persistent volume, Service, probes, status, restart recovery, and Retain deletion; verify through kubectl first.
3. **Console workflow**: project mappings, permissions, asynchronous API, creation/connection guidance, credential configuration, events.
4. **Statistics and policies**: integrate template metrics, display applied versions, validate near-capacity behavior and concurrent cleanup.
5. **Delivery and operations**: installer, upgrade compatibility, prerequisite checks, fault diagnosis, retained-volume management.

Required validation: real-client reads/writes; rejection of unauthorized and cross-instance access; promised data behavior across Pod restarts/node failures; concurrent writes/cleanup; large files and gRPC through ingress; preserved failure reasons for configuration errors; resumed reconciliation after Operator restart; no duplicate creation on API retries; no accidental deletion of Retain volumes.

Increase instance counts progressively to measure per-instance idle overhead, startup-time distributions, API-server pressure, monitoring time-series counts, and PVC attachment limits. Do not assume that “thousands of instances” or “startup in seconds” is satisfied in the first release.

Evaluate multi-cluster support, upstream-proxy templates, object storage, native engine HA, complete GitOps workflows, and third-party template publishing in the next phase. Horizontal scaling must be qualified per engine rather than uniformly increasing replicas.

First demonstrable milestone: user creates a bazel-remote instance → receives connection configuration → Bazel uploads build results → another clean working directory hits the cache → console shows instance metrics → adjust capacity and verify policy → restart and verify recovery → delete the instance and check the Retain volume. Clear local client caches or use an independent client to prove a remote hit; do not record local hits as server success.

PoCs must determine the pinned bazel-remote version and image digest, WebDAV engine, compatible Kubernetes/CSI/CNI/ingress combinations, default resources, startup-time targets, metric definitions, and credential-rotation mechanisms. Until then, do not claim qualification or performance targets have been met.

## 15. Official references

- [S1: Kubernetes Operator pattern](https://kubernetes.io/docs/concepts/extend-kubernetes/operator/)
- [S2: Persistent Volumes, access modes, expansion, and reclaim policies](https://kubernetes.io/docs/concepts/storage/persistent-volumes/)
- [S3: Network Policies and network-plugin requirements](https://kubernetes.io/docs/concepts/services-networking/network-policies/)
- [S4: bazel-remote features, configuration, and deployment](https://github.com/buchgr/bazel-remote)
- [S5: bazel-remote Apache-2.0 license](https://github.com/buchgr/bazel-remote/blob/master/LICENSE)
- [S6: Buildbarn bb-storage](https://github.com/buildbarn/bb-storage)
- [S7: Kubebuilder envtest](https://book.kubebuilder.io/reference/envtest)
- [S8: kind Quick Start](https://kind.sigs.k8s.io/docs/user/quick-start/)
- [S9: k3d](https://k3d.io/stable/)

See the [implementation plan](implementation-plan.md) and [Go module guide](../../operator/README.md) for current implementation progress. Unverified images, engine capabilities, and cluster combinations are explicit gates in the implementation plan, not completed qualifications.

- [Prometheus query-history integration and validation boundaries](monitoring.md)

- [Project quotas and Kubernetes hard limits](quotas.md)
- [Read-only resource reconciliation for instances and storage volumes](inventory.md)

## Experimental client recipes

See [sccache and Pants configurations](client-profiles.md) for pinned client profiles, credential limits and the pending real-client acceptance gate.

The [experimental Maven Build Cache profile](maven-build-cache.md) reuses WebDAV and requires separate real-extension acceptance.
