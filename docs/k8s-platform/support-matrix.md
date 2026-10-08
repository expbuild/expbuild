# Feature support and validation matrix

Updated: 2026-10-08. Implementation baseline: [`main` at `71d5134`](https://github.com/expbuild/expbuild/tree/71d5134f5ae3f327167db3d918624d111c5b8bcd).

expbuild manages independent cache services in one Kubernetes cluster. Each instance has one replica, a dedicated PVC and credentials. The tables below distinguish implemented capabilities, tested paths, experimental integrations and future work. No template currently carries production compatibility, high availability or scale qualification.

## Support levels

| Level | Meaning |
| --- | --- |
| Selected paths validated | Implemented, with real engine/client and disposable-cluster evidence for the paths listed below; other clients and deployment environments need separate acceptance |
| Experimental template | Operator, API, UI and image integration exist; protocol fixtures and platform tests pass, but real-client and template-specific cluster acceptance remain pending |
| Experimental recipe | Configuration for an existing engine; it does not add a new engine or certify that client |
| Historical version | Existing instances remain manageable; the management catalog does not offer this version for new instances |
| Prototype or planned | Not available as an expbuild template; any standalone experiment has only its recorded scope |

An enabled template is not necessarily a validated client integration. Optional engines require an administrator-configured immutable image digest. All templates use PVC storage; object storage, TTL policies and multiple replicas per instance are not currently exposed.

## Cache engine templates

| Template | Purpose and connection | Budget and cleanup | Engine statistics in the platform | Support level |
| --- | --- | --- | --- | --- |
| `bazel-remote@0.1.0` | Bazel HTTP and REAPI Action Cache/CAS | Cache budget and LRU | Capacity snapshots; separate AC/CAS get/contains history | Selected paths validated |
| `gradle-http@0.2.0` | Gradle task-output cache over HTTP | Cache budget and LRU | Capacity, GET hits/misses, requests, latency, traffic and eviction | Selected paths validated |
| `webdav-apache@0.2.0` | Authenticated file and directory access | PVC only; no native cache budget or automatic eviction | Approximate bytes/file count from a bounded scan; no hit rate | Selected paths validated |
| `turborepo-http@0.1.0` | Independent Turborepo artifact protocol | Cache budget and LRU | Not exposed | Experimental template |
| `nx-http@0.1.0` | Independent Nx artifact protocol | Cache budget and LRU | Not exposed | Experimental template |
| `go-cacheprog@0.1.0` | Go build outputs through cacheprog HTTP | Cache budget and LRU | Not exposed | Experimental template |
| `gradle-http@0.1.0` | Historical Gradle HTTP template | Cache budget and LRU | Status snapshots and process counters; no continuous native performance metrics | Historical version |
| `webdav-apache@0.1.0` | Historical WebDAV template | PVC only; no native cache budget or automatic eviction | Not exposed | Historical version |

Budget configuration and authenticated readiness probes do not establish statistics support: Turbo, Nx and Go expose a budget to the Operator but currently declare `statistics: false` in the API catalog. Generic resource metrics, events and logs have separate backend dependencies; see [observability](observability.md).

Budget changes use restart-based policy application. Logical engine budgets are not physical filesystem quotas; PVC requests and actual volume usage are separate values.

REAPI supports caching only, without remote execution. Historical instances retain their template version and image binding; no instance engine/template upgrade workflow exists. The Apache WebDAV engine remains unchanged pending a replacement decision.

## Client and cluster acceptance

| Template | Real client or engine evidence | Actual Kubernetes coverage | Remaining acceptance |
| --- | --- | --- | --- |
| bazel-remote | Native Bazel 8.8.1 HTTP/REAPI builds and uncached controls against bazel-remote 2.6.2 in platform CI | Selected Helm/Gateway paths, REAPI TLS, credential rotation, and Cilium isolation | Target CSI/CNI/Gateway, multinode recovery, scale and additional clients |
| Gradle HTTP | Native Gradle 8.14.3 cold upload, fresh local-cache restore and uncached control in platform CI | PVC persistence, pause/resume, credentials, Retain/Delete; Helm/API statistics and Gateway HTTPS | Gradle-specific Cilium isolation, production storage, high load and broader client versions |
| Apache WebDAV | Real Apache authentication, MKCOL, PUT/GET, PROPFIND and locking contracts | PVC/lifecycle, Helm/API, Gateway HTTPS, Cilium isolation and bounded content snapshots | Compiler/build-tool recipes below; target storage and scale |
| Turborepo HTTP | HTTP fixtures and built-image smoke checks; real Turbo not executed | Rendering/admission and platform contracts; no deployed-template lifecycle acceptance | Real Turbo, PVC/lifecycle, HTTPS, isolation and performance |
| Nx HTTP | HTTP fixtures and built-image smoke checks; real Nx not executed | Rendering/admission and platform contracts; no deployed-template lifecycle acceptance | Real Nx, PVC/lifecycle, HTTPS, isolation and performance |
| Go cacheprog | HTTP fixtures and built-image smoke checks; real cacheprog not executed | Rendering/admission and platform contracts; no deployed-template lifecycle acceptance | Real Go/cacheprog, PVC/lifecycle, HTTPS, read-only policy and performance |

The current [cluster workflow](../../.github/workflows/cluster.yml) deploys the base engines, not Turbo, Nx or Go. The Cilium job covers REAPI/WebDAV; it does not extend Gradle or experimental-template acceptance by association. Real-client builds, protocol clients, browser tests and Kubernetes lifecycle tests are separate evidence layers; see [testing](testing.md).

### Experimental client profiles

All profiles below are implemented and still marked experimental. Real-client acceptance is pending for every row; a recipe test uses stub executables and does not run these clients.

| Client version | Template | Integration scope and details |
| --- | --- | --- |
| Turborepo 2.11.7 | `turborepo-http@0.1.0` | Separate engine; [artifact protocol and instance scope](turborepo-http.md) |
| Nx 22.7.12 | `nx-http@0.1.0` | Separate engine; [native HTTP cache](nx-http.md) |
| cacheprog 1.3.0 with Go 1.27.1 | `go-cacheprog@0.1.0` | Separate engine; [Go build outputs](go-cacheprog.md), not Go module downloads |
| sccache 0.18.0 | `webdav-apache@0.1.0` or `@0.2.0` | Existing engine; [WebDAV compiler-cache recipe](client-profiles.md#sccache) |
| Pants 2.33.1 | `bazel-remote@0.1.0` | Existing engine; [REAPI recipe](client-profiles.md#pants), no execution service |
| moonrepo 2.5.6 | `bazel-remote@0.1.0` | Existing engine; [REAPI recipe](moonrepo.md) |
| Maven Build Cache Extension 1.3.0 with Maven 3.9.16 | `webdav-apache@0.1.0` or `@0.2.0` | Existing engine; [build-output recipe](maven-build-cache.md), not a Maven dependency proxy |

Client flags that disable writes do not restrict the token's server-side authority. Go supports an instance-wide read-only policy, defaulting to true in the API/console; direct CR authors must set it explicitly. There are no separate reader/writer token roles. Other engines' instance client credentials allow reads and writes; health credentials are separate where provided. Use dedicated instances for different trust domains.

## Platform capabilities

| Area | Implemented | Remaining boundary |
| --- | --- | --- |
| Projects and access | Local users/sessions, project membership and roles, audit records | OIDC and SaaS identity/billing are not implemented |
| Instance lifecycle | Create/configure/pause/resume/delete, asynchronous operations and credential rotation | Failure recovery is qualified per scenario; no blanket recovery guarantee |
| Resources | Instance CPU/memory/storage, project reservations and Kubernetes hard quotas | One replica per instance; no autoscaling or transparent wake-on-request |
| Inventory and volumes | Read-only CR/PVC reconciliation, retained-volume reclaim and explicit cleanup | Full Pod/Secret/route inventory and general repair workflows remain pending |
| Networking | Internal endpoints, optional per-instance Gateway HTTPS/gRPC TLS, project NetworkPolicy | Requires suitable Gateway, DNS/certificates and enforcing CNI; user-defined domains pending |
| Image safety | Persistent immutable image bindings and trusted retained-volume recovery records | Not an engine upgrade mechanism; production A/B migration and backup recovery need qualification |
| Observability | First-release metrics, diagnostics, logs, alerts/silences/history and platform health | Backend/collector setup required; coverage varies by template; project thresholds and deeper trends pending |
| Console | English and Simplified Chinese, project navigation, instance operations and diagnostics | New capabilities must maintain both languages |
| Delivery | Container build/smoke workflows and Helm installation | CI does not publish images; versioned release delivery, offline installation and production upgrade drills pending |
| Extension model | Compiled adapters with exact template versions | No dynamic extension SDK, shared content index, multicluster or GitOps management mode |

## Prototypes and future integrations

| Capability | Current state | Next gate |
| --- | --- | --- |
| BuildKit Registry cache | [Standalone yq proof of concept](buildkit-registry-yq-poc.md): native ARM64 reuse, invalidation, OCI checks and offline GC recovery | Engine selection and complete expbuild template integration; no platform template yet |
| Docker/OCI pull-through cache | Research only | Upstream authentication, digest preservation, client configuration, retention and GC acceptance |
| General CI cache and artifacts | Research only | Define rebuildable cache versus retained artifacts, select clients and storage |
| npm, Python, Go Modules and Maven dependency proxies | Research only | Select and qualify each dedicated engine; build-output recipes do not implement dependency proxying |
| Object storage, multicluster, GitOps and extension SDK | Planned directions | Separate design and implementation |

See the [expansion plan](cache-expansion-plan.md) for candidates and the [current backlog](progress.md#current-outstanding-work) for priority. Broader open-source workload evidence and its limitations remain in the [benchmark records](open-source-benchmark.md).

## Evidence and maintenance

The [current CI snapshot](progress.md#current-validation) records results for the baseline above. Green workflows establish only their executed coverage; experimental clients and production environments remain pending.

When changing a template or profile, update this matrix, both homepages, observability capabilities and the relevant integration guide together. Check declarations against [template-catalog.ts](../../apps/admin-api/src/template-catalog.ts), [client-profiles.ts](../../apps/admin-api/src/client-profiles.ts), the [Operator registry](../../operator/internal/templates), and the actual workflow/test paths. Record exact client/engine versions, evidence links and unvalidated paths before promoting a support level. A template registration, recipe or upstream compatibility statement alone is not acceptance.
