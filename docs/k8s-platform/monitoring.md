# Query history (Prometheus integration)

The management API and UI support optional Prometheus history queries. The current implementation provides query adaptation and access control, plus optional automatic ServiceMonitor generation and credential-reference synchronization; it does not deploy Prometheus or Prometheus Operator. The deployer must supply an existing trusted collection system. Missing configuration returns 503; no collected data returns empty series, without fabricated zeros.

The first platform observability release is implemented; see [observability integration](observability.md) for configuration and the support matrix. This document preserves the compatibility contract of the existing Bazel query-history API; new general observation endpoints, Gradle metrics, logs, events, and alerts use the new entry points.

## Configuration and metric contracts

Set `monitoring.prometheusURL` in Helm, for example `http://prometheus.monitoring.svc:9090`, or `PROMETHEUS_URL` when starting the API directly. HTTP/HTTPS and path prefixes are allowed; credentials, query strings, and fragments in URLs are rejected, and redirects are not followed. Optionally configure `monitoring.queryBearerTokenSecret` to reference the `bearer-token` field of an existing Secret in the control-plane namespace. This credential is injected only into the management API, not the Operator, frontend, or instances, and is not supplied as plaintext in Helm values. For direct API execution, use `PROMETHEUS_BEARER_TOKEN`. A query URL must also be configured; the token must be nonempty, contain no spaces/newlines, and be at most 8192 characters.

Example query authentication (the deployer creates the Secret in advance):

```yaml
monitoring:
  prometheusURL: https://metrics.example.test/prometheus
  queryBearerTokenSecret: expbuild-metrics-query
```

This authentication sends a Bearer token from the API to the monitoring query endpoint, separate from instance Basic credentials used for engine-metric collection. The API does not follow redirects; query failure reports statistics unavailable without changing instance state. After updating the Secret, roll the management API to load the new token. Enterprise endpoints using a custom CA still require trusted CA configuration in the runtime environment; there is no option to skip TLS verification. Bearer query authentication is currently supported; other query-authentication methods are not yet adapted.

The collection target is bazel-remote's `/metrics`, using the instance's currently valid Basic credentials. Requests must satisfy existing network policies. Enabling the ServiceMonitor integration below generates an ingress policy requiring both the source namespace and Pod label to match; otherwise, the deployer maintains access.

The collection system must attach trusted labels to every sample:

| Metric label | Source |
| --- | --- |
| `expbuild_project_id` | CacheInstance's immutable project ID / Pod's `cache.expbuild.io/project-id` |
| `expbuild_instance_uid` | Cluster-assigned CR UID / Pod's `cache.expbuild.io/instance-uid` |

Do not substitute instance names or namespaces for UIDs, or data from deleted and recreated instances will mix. Shared monitoring across clusters must also ensure trusted ownership of these UID identities. Avoid summing duplicate scrapes of the same target; relabeling must not allow engine-provided labels to overwrite the ownership labels above.

This mapping is pinned to bazel-remote v2.6.2's `bazel_remote_incoming_requests_total`; see the official [counter definition](https://github.com/buchgr/bazel-remote/blob/v2.6.2/cache/disk/options.go) and [counting behavior](https://github.com/buchgr/bazel-remote/blob/v2.6.2/cache/disk/metrics.go):

- `kind=ac|cas` denotes action cache or content cache respectively.
- `method=get` denotes reads; `contains` denotes existence checks, with FindMissing counted per digest.
- `status=hit|miss` denotes the engine's actual lookup result. Errors are not automatically counted as misses.

The platform applies a five-minute `rate` and aggregates separately by these three labels. Queries per second differ from build hit rates. Reads and existence checks are not currently combined, and successful HTTP/gRPC status is not interpreted as a cache hit.

## Management API

`GET /v1/projects/{projectId}/instances/{instanceId}/statistics/history?window=1h`

Supported windows are `1h`, `6h`, and `24h`, with steps of 60, 120, and 300 seconds; the end time aligns to the step. The server reads the original CR UID from the authorized database binding; callers cannot submit PromQL or label selectors. Project members can read history, and deleted historical instances remain queried by their original UID. Retention currently depends on external Prometheus configuration.

The response contains `series`, each with kind, method, outcome, and points of `[Unix seconds, rate per second or null]`. Nonfinite values become null; empty series indicate no valid data. Upstream warnings, errors, oversized responses, duplicate series, and abnormal timestamps are rejected. Requests time out after 5 seconds; responses are limited to 1 MiB, 8 series, and at most 300 points per series. The API returns neither upstream query text nor addresses.

The UI loads history on demand without continuous polling. Users can select time range, cache type, and query type; monitoring failures appear as unavailable and missing samples remain gaps. Live capacity still comes from the engine status endpoint independently of history queries.

## Validation scope and follow-up work

Unit tests cover query ranges, label-injection rejection, time/response limits, and missing values. Real PostgreSQL tests cover bound UIDs, historical-record authorization, and cross-project denial; UI tests cover on-demand loading, filtering, and monitoring unavailability. Real authenticated collection and range-query tests with pinned Prometheus v3.15.0 passed locally: a controlled exporter supplies different counter rates for three project/UID combinations, verifying isolation by both project and UID, empty series for missing instances, and preservation of valid zeros. This validates real PromQL/HTTP behavior; the collection source is a contract fixture and does not yet cover automatic collection from real cache engines. Instance collection automation and credential rotation have separate real-kind acceptance checks at the end of this document; actual CNI isolation and long-term load still require validation. Resource metrics, latency, traffic, and WebDAV metrics are not yet integrated.


## Reproducing the real Prometheus test

```sh
python3 tools/download_prometheus.py /tmp/expbuild-prometheus
PROMETHEUS_BIN=/tmp/expbuild-prometheus npx tsx --test apps/admin-api/src/history-engine.test.ts
```

The downloader pins the [official v3.15.0 Linux amd64 release asset](https://github.com/prometheus/prometheus/releases/tag/v3.15.0) and SHA256, extracting only the specified regular binary from the verified archive. Tests create temporary configuration/TSDB, random local ports, and a separate process, then clean up on exit. Real samples must enter a minute-aligned query window, typically taking tens of seconds. Missing PROMETHEUS_BIN explicitly skips the test; CI downloads it and requires execution. No default or production Prometheus is contacted.

## Optional automated instance collection

The deployer first installs a compatible Prometheus Operator and ServiceMonitor CRD. The platform's CRD contract tests pin the official v0.94.1 CRD and SHA256; the full path from the Prometheus Operator container to real cache engines has passed the acceptance recorded below. Example enablement:

```yaml
monitoring:
  prometheusURL: http://prometheus.monitoring.svc:9090
  serviceMonitor:
    enabled: true
    namespace: monitoring
```

Prometheus itself must select ServiceMonitors labeled `app.kubernetes.io/managed-by=expbuild` in project namespaces, and collection Pods need `cache.expbuild.io/monitoring=true`. Prometheus Operator needs permission to read credential Secrets in those namespaces, and Prometheus needs appropriate service-discovery permissions. These belong to the monitoring system maintained by the deployer and are not automatically granted by the expbuild chart.

expbuild reconciles instance ServiceMonitors every ten seconds, fixing `/metrics`, the HTTP port, a 30-second scrape interval, and a 5-second timeout, without redirects. Credentials are passed as references to probe-username/probe-password in the current Secret, not plaintext in the ServiceMonitor. Rotation updates references, which Prometheus Operator reloads asynchronously; brief collection gaps may occur, and zero interruption is not promised.

Targets are selected by CR UID, project, and instance labels; service-name relabeling excludes the headless Service to prevent duplicate engine scrapes. Fixed relabeling rules write project/UID labels with honorLabels=false. The associated NetworkPolicy restricts both source namespace name and collection Pod label, opening only 8080; a policy-enforcing CNI is still required to demonstrate actual isolation.

`MonitoringConfigured=True/ResourcesApplied` means only that collection objects and policies were written successfully, not that samples exist. Monitoring errors are reported separately and do not mark a cache unavailable if it passed protocol probes. Optional monitoring APIs are not registered as informers at startup, so their unavailability does not block cache-controller startup.

Pause, deletion, or disabling integration cleans up precisely owned collection objects and network policies with UID/resourceVersion deletion preconditions; same-name objects owned by others are not adopted. Cleanup markers are added before resource writes, and cleanup permissions remain after the feature is disabled. The Operator gains only ServiceMonitor get/create/patch/delete permissions, not Prometheus creation permissions; the management API has no ServiceMonitor write permissions.

After disabling integration, wait for cleanup before uninstalling CRDs or revoking cleanup permissions. Missing monitoring APIs prevent cleanup confirmation and may leave instance-deletion finalizers; do not remove markers directly to conceal incomplete cleanup. Automatic native instance-metric collection currently supports bazel-remote 0.1.0 and gradle-http 0.2.0. WebDAV content snapshots are exported by the background collector, with no request/hit metric adapter yet.

## Isolated-cluster collection acceptance

The Gateway cluster job adds pinned Prometheus Operator v0.94.1 deployment-package SHA256 and image digests for Operator, config-reloader, and Prometheus v3.15.0. Installation occurs only in the temporary kind/context created by the script, using temporary monitoring data without modifying existing clusters. The script requires exactly one active target per instance, rejection of anonymous/old credentials at the metrics endpoint, and real CAS read rates for the current project/UID in management API history. After rotation, new successful samples and new history timestamps must appear; after deletion, the target must disappear. This full path passed [isolated-cluster CI](https://github.com/expbuild/expbuild/actions/runs/36672925904) at commit 6966aec. Actual logs separately confirm real CAS query history before and after rotation, a unique healthy target, a new post-rotation sample timestamp, and target removal after deletion.

Acceptance boundaries: this used single-replica Prometheus, temporary TSDB, and kind's default network. It did not verify actual NetworkPolicy blocking, persistent monitoring storage, high availability, long-term retention, or collection at scale. API queries and UI components passed separate tests; real-browser end-to-end acceptance has not yet been performed. WebDAV `0.2.0` read-only content scans provide only live capacity and entry snapshots, not Prometheus request metrics or inferred hit rates.
