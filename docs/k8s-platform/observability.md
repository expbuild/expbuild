# Observability features and deployment integration

Initial release: 2026-10-01. Capability table updated: 2026-10-08, against `main` at `71d5134`. This document records implemented observability, integration requirements, and test boundaries. See the [feature support matrix](support-matrix.md) for template and client validation, the [observability plan](observability-plan.md) for the complete goals, and [monitoring](monitoring.md) for the Bazel history endpoint.

## User entry points

| Entry point | Implemented features | Permissions |
|---|---|---|
| Project / Observability | Background collection coverage, instance service/data states, content usage, last observation time | Project members |
| Instance / Metrics and diagnostics | Capacity, query effectiveness, request performance, resource history; conditions, operations, related Kubernetes events; runtime logs | Metrics and events: members; logs: maintainer/admin |
| Project / Alert center | Current alerts, original-instance diagnostics, one-hour silences, received alert history | View: members; silence: maintainer/admin |
| Platform / Platform health | Latest background-task successes/failures for the current API replica, database connection pool, unfinished-operation queue, data-source configuration | Platform administrators |

Platform administrators can access all projects. The API reauthorizes every query; history uses the original CR UID and filters by cluster and project. Browsers cannot submit PromQL, LogQL, arbitrary matchers, or backend URLs. After membership is revoked, existing sessions cannot continue requesting project observation data. English, Simplified Chinese, and local-time-zone display follow management-platform settings.

Service readiness and collection state are displayed separately. Unconfigured sources, query failures, absent samples, unsupported capabilities, stale data, and real zeros have different meanings. Charts preserve missing points; the “last returned timestamp” is a Prometheus query evaluation timestamp, not necessarily the original scrape time. Counters are aggregated after five-minute `rate` calculation; entry hit rates are calculated only when both hit and miss data exist and total queries exceed zero. Build-task hits and time savings are not inferred.

## Capabilities by template

| Template version | Capacity history | Query effectiveness | Performance and traffic | Eviction |
|---|---|---|---|---|
| bazel-remote 0.1.0 | `/status` snapshots exported to Prometheus | AC/CAS and get/contains counted separately | No qualified mapping on the new general page yet | No qualified mapping on the new general page yet |
| gradle-http 0.2.0 | `/status` snapshots; native `/metrics` also provides current values | GET entry hits, misses, hit rate | GET/PUT requests, 5xx, P95, read/write byte rates | Capacity-evicted entry and byte rates |
| gradle-http 0.1.0 | `/status` snapshots | Continuous native metrics are not claimed | Unsupported | Unsupported |
| webdav-apache 0.2.0 | Existing scan snapshots | Unsupported | Unsupported | Unsupported |
| webdav-apache 0.1.0 | Unsupported | Unsupported | Unsupported | Unsupported |
| turborepo-http 0.1.0 | Not exposed | Not exposed | Not exposed | Not exposed |
| nx-http 0.1.0 | Not exposed | Not exposed | Not exposed | Not exposed |
| go-cacheprog 0.1.0 | Not exposed | Not exposed | Not exposed | Not exposed |

Turbo, Nx and Go implement cache budgets and LRU, but currently declare `statistics: false` and `lookupHistory: false`. Their authenticated readiness/status probes do not provide a platform collection or history integration. Adding engine metrics is current backlog work. Kubernetes resource metrics, events and logs have separate collection requirements and must not be presented as cache hit/miss statistics.

The WebDAV engine and scanning method remain unchanged. New Gradle instances use 0.2.0; old instances continue under their original versions. The platform does not silently change template versions and does not yet provide a version-upgrade workflow. Publish a Gradle image containing the new metrics before enabling this version of the management API/Operator; retain release records linking all three versions.

Gradle `/metrics` uses the dedicated `health` identity and rejects anonymous access and the cache-client identity; `health` still cannot read/write cache entries. Scrapes do not generate cache hits or change access hotness. Counters reset on process restart, and history queries handle resets. Request metrics cover authenticated cache GET/PUT, excluding status/metrics probes; latency includes server-side transfer time, while write bytes include request-body bytes read before eventual rejection.

Resource pages query CPU, throttling, memory, limits, restarts, and actual volume capacity/usage available from CSI. Resource data depends on cluster collection; requested PVC size is not a substitute for actual volume usage. WebDAV's capacity reference is requested volume size, while Bazel/Gradle use the engine budget.

## Enabling deployment

The main chart integrates enterprise monitoring facilities; it does not install Prometheus, Loki, Alertmanager, kube-state-metrics, or node log collectors. Apply database migration `009_observability.sql` first, then release the API, Operator, frontend, and corresponding engine images. Helm's migration Job follows the existing upgrade workflow.

```yaml
monitoring:
  clusterId: production-eu1
  prometheusURL: https://metrics.example.test/prometheus
  queryBearerTokenSecret: expbuild-prometheus-query
  serviceMonitor:
    enabled: true
    namespace: monitoring
  platform:
    enabled: true
    tokenSecret: expbuild-platform-scrape
    serviceMonitor: true
    rules: true
  logs:
    url: https://logs.example.test
    tokenSecret: expbuild-loki-query
  alerts:
    url: https://alerts.example.test
    tokenSecret: expbuild-alertmanager-query
    webhookTokenSecret: expbuild-alert-webhook
```

The deployer creates these Secrets in the control-plane namespace in advance, using the field `bearer-token`. The chart references Secrets without storing plaintext in values. Query, platform-scrape, and inbound-alert credentials should be separate. Scrape/inbound credentials must contain at least 32 characters and no spaces/newlines; after updating Secrets exposed as environment variables, roll the API/Operator. Query Secrets may be omitted for backends with native unauthenticated HTTP, but the deployer must control network ingress.

`clusterId` must remain stable and be used consistently for platform metrics, instance metrics, cluster-resource metrics, logs, and alerts; changing it cuts existing history out of query scope. Adding this label does not turn the platform's current single-cluster control model into multi-cluster management.

Install Prometheus Operator's ServiceMonitor/PrometheusRule CRDs first. Its selectors must include the two Helm-managed platform ServiceMonitors and rules in the control-plane namespace, plus expbuild-managed instance ServiceMonitors in project namespaces. Do not select only `app.kubernetes.io/managed-by=expbuild`, which would omit Helm-managed platform monitoring objects. Instance-scraping Pods also need `cache.expbuild.io/monitoring=true` to satisfy project NetworkPolicies.

Without Prometheus Operator, disable ServiceMonitor/rule creation and scrape using standard Prometheus configuration:

- API Service `/internal/metrics`, Bearer authentication, port 9090.
- Operator Service `/metrics`, the same installation-level scrape credential, port 9090.
- Bazel/Gradle 0.2.0 instance `/metrics`, dedicated probe Basic credentials, port 8080.
- Disable redirects and honoring client timestamps for all targets, with approximately 30-second sampling. Set `expbuild_cluster_id`; platform targets also set `expbuild_component=api|operator`.
- Instance targets must overwrite `expbuild_project_id` and `expbuild_instance_uid` from trusted CR/Service bindings, not trust engine-reported identities. Multi-instance snapshot labels exported by the platform API come from both database and CR ownership checks and must not be rewritten into a single instance.

Resource collection requires the kube-state-metrics Pod/PVC label allowlist to include `cache.expbuild.io/instance-uid`. Queries use `label_cache_expbuild_io_instance_uid`; kube-state-metrics and kubelet/cAdvisor scrape targets also need consistent cluster labels. Queries associate Pods/PVCs at historical timestamps rather than using current Pod names as historical ownership. Without these resource metrics, pages show no samples.

## Log integration

The API emits structured logs by default and returns `X-Request-ID` in responses. By default, it does not log request bodies, complete URLs, Authorization, Cookie, or cache keys. Request metrics use route templates, and background tasks use fixed event codes; audits continue to record management actions separately.

The deployer installs node collectors, restricts collection scope, supplies trusted Kubernetes identity, and redacts logs before writing to Loki. Loki streams must include `expbuild_cluster_id`, `expbuild_project_id`, and `expbuild_instance_uid`, derived from Pod/CR ownership rather than log bodies. Request IDs and object paths must not become stream labels. The current query adapter does not expose Loki tenant headers to clients; multi-tenant Loki should use a deployer-configured query proxy with a fixed tenant.

The log API reads at most one hour, with the UI defaulting to the latest 15 minutes. Each request returns at most 500 lines and marks truncation, with an upstream-response limit of 1 MiB, a five-second timeout, and at most eight concurrent queries per backend per API replica. Optional level filters require collected JSON to use the strings `info/warn/error`. The API additionally redacts common secret fields; this does not replace preventing secret output at the source or collection-side redaction.

## Alert integration

The chart provides six rules: failed platform-target scraping, high API error rate, instance not ready, instance statistics unavailable, no active instance collector, and operations unfinished for too long. Scrape failure does not mean the cache is down; paused state suppresses corresponding instance rules. Low hit rate and proximity to capacity budgets do not trigger alerts by default. Thresholds currently ship with rules; per-project threshold editing remains future work. Users can already create instance/rule-scoped silences from 5 minutes to 24 hours, with a one-hour UI preset.

Enterprise notification channels remain managed by Alertmanager; the platform holds no email or chat-system credentials. Add the following receiver configuration to the existing instance-alert route, replacing the service address with the actual release name; do not overwrite existing enterprise notification routes.

```yaml
receivers:
  - name: expbuild-history
    webhook_configs:
      - url: http://RELEASE-expbuild-api.CONTROL_NAMESPACE.svc:80/internal/alerts
        send_resolved: true
        max_alerts: 50
        http_config:
          authorization:
            type: Bearer
            credentials_file: /etc/expbuild-webhook/bearer-token
```

Mount the separate webhook Secret at the above path in Alertmanager. The inbound endpoint accepts at most 64 KiB per request body; avoid lengthy annotations. Fifty is an item-count ceiling, not a guarantee that any 50 alerts will fit. Notifications with mismatched cluster/project/original UID are ignored. Reception is idempotent by project, UID, fingerprint, and startsAt; duplicate or out-of-order delivery cannot reopen an already resolved alert occurrence.

A background task performs bounded reconciliation of received, unresolved alerts every minute, with at most ten projects per batch. Disappearance from the current list is recorded only as “not in the active list at the latest check,” without inventing a resolution time; query failure preserves the previous check time. Alert history explicitly warns that reception outages can cause omissions and is not complete Alertmanager history. Silencing records an audit request before calling the backend; uncertain outcomes require refresh and inspection before retry.

## Retention and operating boundaries

Background instance collection handles at most 20 instances per batch, with at most four concurrent instances; it waits approximately 30 seconds after a complete polling cycle. A PostgreSQL session lock maintains one active collector. After database connection loss is detected, that replica stops exporting in-memory metrics, allowing another replica to take over. Do not run this session lock through a transaction-pooling database proxy; use direct connections or session pooling.

The database stores only the latest snapshot per instance. Prometheus scrapes timestamp, Ready, desired-running, statistics-availability, and capacity gauges to form history; stale snapshots stop being exported after 120 seconds without updates. Memory holds at most 10,000 instance snapshots, a protection limit rather than a validated scale commitment. Collection coverage and stale state expose instances without coverage.

Kubernetes events are associated only with CR, Pod, and PVC UIDs whose ownership can currently be confirmed. Each instance associates at most eight resources, with at most 100 events per resource and at most 100 returned; truncation and failure are reported separately. Only stable reasons, types, counts, and occurrence times are stored, not raw event bodies. Count changes update the same event record rather than inserting duplicates. Instance diagnostic events retain at most 1,000 entries or 30 days; cleanup runs in batches, so time retention does not promise deletion to the exact second. Kubernetes events that expired during collection outages cannot be recovered.

Resolved alert history is retained for 30 days; unresolved alerts remain for reconciliation. Enterprise backends configure metric/log retention; suggested starting points remain 15 days for metrics and 7 days for logs. The main chart promises neither retention nor durability on their behalf. Audit and business-operation records maintain separate policies.

Query-backend failures affect only observation results: they do not change cache Ready, pause caches, or restart engines. “Configured” on the API health page means only that configuration exists, while background-task status describes only the API replica serving the request. Actual Operator reconciliation, queue, and leader metrics come from the controller-runtime endpoint; the native platform-health page does not yet fully chart them.

## Validation and next steps

First-release validation includes real PostgreSQL permissions and historical deduplication, real Prometheus queries, real Loki logs, real Alertmanager silencing and resolution, rule replay, Go race detection, CRD/RBAC validation with Kubernetes API server/etcd, and Chromium management workflows. API compatibility tests pin [Alertmanager 0.28.1](https://github.com/prometheus/alertmanager/releases/tag/v0.28.1) and [Loki 3.5.0](https://github.com/grafana/loki/releases/tag/v3.5.0), with download tools checking pinned release digests. These are test baselines, not enterprise production-version recommendations.

```bash
npm run build
TEST_DATABASE_URL=... npm test
PROMETHEUS_BIN=... ALERTMANAGER_BIN=... LOKI_BIN=... npm test --workspace apps/admin-api
TEST_DATABASE_URL=... npm run test:browser
cd operator
go test -race ./internal/gradlecache ./internal/monitoring
KUBEBUILDER_ASSETS=... HELM_BIN=... go test ./...
```

Alert-rule replay: `python3 tools/test_observability_rules.py --helm /path/to/helm --promtool /path/to/promtool`, requiring PyYAML. CI includes pinned backends and rule validation. No manifests were applied to business clusters in this round. envtest does not run kubelet, CSI/CNI, or real collection Pods; full-path behavior, credential rotation, collector failures, and scale costs still need acceptance on the target cluster.

Further work includes per-project rule thresholds, complete Operator/dependency trends and per-stage lifecycle timing, compensating alert-history reception and absolute-time-window navigation, additional native Bazel metric mappings, a qualified node-collector deployment package, tracing, custom WebDAV/tiered-cache metrics, SLOs, and large-scale load baselines. None is claimed complete in this release.
