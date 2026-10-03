# expbuild Platform Observability Plan

Date: 2026-10-01. Status: the first release implements basic collection, native observability pages, and log and alert integrations. This document retains the full target scope; see the [Implementation and Integration Guide](observability.md) for specific deliverables and remaining deeper work.

The goal is to help platform administrators and project users answer four questions: Is the platform healthy? Is caching effective? Are resources sufficient? Where is the problem? Observability covers the management platform, cache instances, and the collection system itself, with a diagnostic path from alerts to metrics, events, and logs in the management UI.

## Pre-Implementation Baseline and Target Boundaries

| Scope | Implementation at baseline | Additions in this plan |
|---|---|---|
| Bazel instances | Optional ServiceMonitor, AC/CAS query history, authorization by project and CR UID | Request performance, resources, capacity trends, eviction, and alerts; verify engine capabilities individually |
| Gradle instances | Live capacity, entry count, read/write counters for the current process | Native metrics endpoint, continuous collection, and historical trends |
| Apache WebDAV | Content capacity and entry snapshots from bounded scans | Optional snapshot history and Kubernetes resource observation; request hits and reliable eviction metrics deferred to a later engine |
| Management platform | Operation records, audits, instance conditions, and health endpoints | Runtime observation of the management API, background tasks, Operator, and database dependencies |
| Logs and traces | Operator logs available; management API explicitly disables Fastify logging | Structured logs, correlation identifiers, log queries; tracing added later |

Before this plan, the Operator metrics endpoint was disabled and history queries covered only Bazel. The first release has since added protected API/Operator metrics, background snapshot collection, native Gradle 0.2.0 metrics, resource trends, events, and Loki and Alertmanager integration. The table above records the original baseline; [observability.md](observability.md) is authoritative for the actual support matrix and validation boundaries.

## Architecture and Component Choices

Use shared collection and storage, with each cache instance exposing only the necessary metrics and runtime logs. Prefer existing enterprise infrastructure; expbuild provides metric contracts, engine adapters, collection configuration, rules, and an authorized query UI.

```text
Management API / Worker / Operator / cache engines / Kubernetes metrics
                         ↓ collection
                 Prometheus-compatible backend → rule evaluation → Alertmanager

Container stdout → node log collector → log backend
Application traces → OpenTelemetry Collector → tracing backend

Operation records / audits / status changes / alert history → platform database

These data sources → management API authorization and query adapters → expbuild management UI
```

| Capability | Suggested choice | Deployment approach |
|---|---|---|
| Metrics | Prometheus-compatible collection and queries | Continue the existing integration; use ServiceMonitor with Prometheus Operator, otherwise provide standard scrape configuration |
| Alerts | Prometheus rules and Alertmanager | Integrate with existing systems; the platform maintains built-in rules, instance ownership, and UI |
| Resource state | kube-state-metrics, kubelet container and volume metrics | Reuse cluster collection infrastructure to avoid duplicate collection |
| Logs | OpenTelemetry Collector; consider Loki for the first query adapter | Reuse existing collectors directly; use a DaemonSet for new node collection |
| Traces | OpenTelemetry; consider Tempo for the first query adapter | Optional shared Collector; enable in a later phase |
| Business events and audits | PostgreSQL | Continue the operation and audit model; add events and alert history with bounded retention |

Prometheus rules evaluate alerts, while Alertmanager handles grouping, inhibition, silencing, and notifications; the platform does not build another rule execution engine. [Official responsibility overview](https://prometheus.io/docs/alerting/latest/overview/)

Node log collection can use the OpenTelemetry Filelog Receiver; cluster event collection uses a separate single-active collector or explicit sharding to prevent every node from collecting the same event. [Kubernetes collection components](https://opentelemetry.io/docs/platforms/kubernetes/collector/components/)

Loki supports OTLP log ingestion, and Tempo can serve as a tracing backend; the first release certifies only explicit adapter combinations. OTLP ingestion compatibility does not imply a unified query interface across all log and tracing backends. [Loki integration](https://grafana.com/docs/loki/latest/send-data/otel/), [Tempo overview](https://grafana.com/docs/tempo/latest/introduction/)

The main platform Chart continues to configure integrations without automatically installing a full monitoring stack. Provide an optional validation-environment installation package and enterprise integration documentation separately; operators may use Grafana, while expbuild's own UI remains the primary entry point for project users.

## Metric Coverage and Statistical Definitions

### Platform Runtime

| Object | Question to answer | Initial metrics |
|---|---|---|
| Management API | Are requests failing or slowing down? | Requests, server errors, latency, and in-flight requests by route template; runtime memory and event-loop delay |
| Background tasks | Are operations backlogged or stalled? | Pending count, oldest task wait time, execution duration, retries and failures, most recent successful processing time |
| Operator | Is the desired configuration consistently applied? | Reconciliation errors and duration, queue depth, active leader, differences between desired and observed instance versions |
| Instance lifecycle | Where is creation or update stuck? | Time from API acceptance to protocol readiness, plus time in resource creation, volume binding, Pod startup, and configuration application |
| Platform dependencies | Does the failure originate in the database or Kubernetes? | Connection-pool wait, connection failures, Kubernetes request errors and latency; detailed database metrics come from deployment-provided exporters |

Distinguish background task types: instance operations, quota coordination, and resource inventory. Count the final outcome of a business operation separately from individual retry attempts to avoid mistaking retry counts for failed operation counts. Put operation IDs in logs and events, not metric labels.

### Cache Instances

Shared views provide server errors, request volume, read/write traffic, latency, entries and capacity, eviction, and resources; templates declare only verified metrics. Standardize units and presentation without forcing different protocols into the same business semantics.

| Statistic | Definition and boundaries |
|---|---|
| Entry hit rate | hit / (hit + miss) across valid queries, with failures counted separately; no hit rate when there are zero queries |
| REAPI queries | Show AC and CAS, reads and existence checks separately; count FindMissing digest queries separately from RPC calls |
| HTTP and WebDAV | Distinguish entry reads, HEAD probes, and directory operations; not every 2xx is an entry hit |
| Local acceleration hits | Whether memory or a local copy served the data; show only for tiered engines where it can be measured |
| Build benefit | Task hits and build time saved require client data; do not infer them from service requests in the initial release |
| Capacity | Show logical entry usage, engine budget, local disk usage, PVC request, and actual volume capacity separately; distinguish scanned values from native values |
| Eviction | Count entries and bytes by reasons such as capacity, expiration, and manual deletion; show reclamation duration, failures, and pending reclamation separately |
| Latency | Break down by protocol operation and bounded object-size ranges; distinguish server processing from ingress observations, without claiming client end-to-end latency |

Calculate counter rates before aggregation and handle resets on process restart. Cross-instance hit rates aggregate only numerators and denominators with matching definitions, never average percentages. Use aggregatable histograms for latency, not averages of per-instance P95 values; estimate the time-series count from bucket and protocol-operation combinations before implementation. [Prometheus histogram guidance](https://prometheus.io/docs/practices/histograms/)

Resource views add CPU usage and throttling, memory usage and limits, OOM, Pod restarts, scheduling failures, PVC binding, and available volume-space metrics. Object state comes from kube-state-metrics, while actual usage comes from sources such as kubelet; mark volume metrics unsupported when the CSI does not provide them, rather than substituting requested PVC capacity for actual disk usage. [Kubernetes object-state metrics](https://kubernetes.io/docs/concepts/cluster-administration/kube-state-metrics/)

### Identity and Data Quality

Continue using trusted `expbuild_project_id` and `expbuild_instance_uid`, and add a stable `expbuild_cluster_id` configured by the deployment owner. Recreated instances receive new UIDs; their history must not mix with a new instance of the same name. Correlate Pods, PVCs, and metrics through trusted ownership and UIDs, retaining necessary historical mappings.

Template versions declare metric sources, counting units, support scope, sampling frequency, and semantic versions. Map upstream native metrics through template adapters or versioned recording rules; instrument internally developed engines directly against the contract. Engines offering only `/status` can initially be read by a shared collection component with bounded concurrency, without relying on users opening a page or adding a sidecar to every instance by default.

Metric labels use bounded operation names, outcomes, and ownership. Full paths, cache keys, user email addresses, request IDs, and raw error text must not become metric labels; descriptive details such as template versions may go in separate information metrics. [Metric cardinality guidance](https://prometheus.io/docs/practices/instrumentation/)

Query results include source, unit, sample time, query interval, and data status. Distinguish at least healthy, no data, stale, unsupported, not configured, and query failure; preserve chart gaps as missing values rather than filling with zero. Project summaries also show the proportion of instances with data and must not present partial observations as complete statistics when some instances are unreachable.

## Logs, Events, and Traces

Enable structured logging in the management API first, then standardize Go and TypeScript fields: time, level, component, stable event code, request ID, operation ID, and project, instance UID, and configuration version where determinable. Errors include classification and actionable reasons, with bounded stack traces. Do not log request bodies, Authorization, Cookie, Secret, full cache paths, or object contents by default.

Adapt third-party engine logs through templates; collectors enrich identity from Pod ownership and redact content rather than trusting project identity claimed in log bodies. Ordinary successful access logs may be sampled, while error logs are rate-limited; metrics are not affected by log sampling. Keep few stable dimensions in the Loki index, placing request IDs, trace IDs, Pod UIDs, and similar fields in structured metadata to avoid index growth.

The instance diagnostic timeline merges operation results, CR condition changes, related Pod/PVC/ingress events, and alert changes, with correlation by operation ID and instance UID. Deduplicate Kubernetes events by event UID, resource UID, and count updates, and record collection gaps; events are diagnostic evidence, not a substitute for audit. Redact event bodies before storage and bound event counts and retention periods.

Auditing continues to record who performed which management action on what and when. Retain it independently, without dropping it due to runtime log sampling or monitoring failures. The platform database stores business records and necessary associations, not full runtime logs or high-frequency metrics.

Tracing is deferred to a later phase: first cover management API calls to the database, Kubernetes, and monitoring queries, then indexing, storage, and upstream fetches in internally developed engines. Correlate background tasks through operation IDs and span links; asynchronous Operator reconciliation must not be represented as one continuous HTTP call. Show explicit boundaries for uninstrumented third-party engines without promising complete build traces. Start with bounded sampling; error tail sampling requires additional validation of Collector buffering and capacity.

## Alerts and Troubleshooting

Every alert must identify its responsibility scope, duration, impact, and troubleshooting entry point. The times below are initial rule suggestions only and must be calibrated against template startup times and real workloads.

| Scenario | Initial condition | Notification scope |
|---|---|---|
| Platform API unavailable | Independent probes fail continuously for about 2 minutes | Platform administrators |
| Stalled operation | Exceeds the deadline for that operation type with no stage progress | Platform administrators and the affected project |
| Instance unavailable | Desired state is running, startup grace period has elapsed, and protocol probes keep failing | That project |
| Capacity cannot be reclaimed | Actual space is insufficient and reclamation fails or writes are continuously rejected | That project |
| Server errors or high latency | Sustained breach of configured thresholds with sufficient request volume | That project; aggregate shared causes for platform administrators |
| Monitoring data interrupted | An expected collection target has no new samples for a sustained period, or the query backend is unreachable | Platform administrators; projects show degraded observation |
| Collection system overloaded | Queue backlog, data drops, rule evaluation failures, insufficient storage | Platform administrators |

`up=0` means only that scraping failed; alone it cannot establish that a cache service is down. Rule evaluation accounts for instance suspension, deletion, and maintenance windows; a low hit rate is an analytical hint by default, and capacity near the budget may be normal cache behavior, so neither should directly become a critical incident.

Active probes use dedicated credentials and defined protocol operations, avoiding test-data writes into user caches by default. Verify per template whether probes affect hit statistics, access frequency, or quotas; explicitly label any effects that cannot be ruled out. Write validation uses isolated test instances or dedicated storage areas, without unconditionally modifying user data in the background.

Alertmanager groups and inhibits alerts by cluster, project, instance, and cause; the platform exposes only preset threshold configuration and time-limited silences through restricted APIs, with changes requiring project management permissions and auditing. Represent acknowledgment, silencing, and recovery separately. Initially reuse deployment-provided notification channels; later support administrator-configured email or webhooks.

Read active alerts from Alertmanager; record alert-history state changes separately through an authenticated receiver, processing idempotently by instance UID and alert fingerprint and periodically reconciling active state. If reception is interrupted, record that history may be incomplete; the current Alertmanager list is not a complete history. Deployment-provided independent health checks or heartbeat paths detect total monitoring-system failure.

Initially establish baselines for availability, operation completion time, and data freshness before setting SLOs. Cache misses are normal business outcomes and do not count as service unavailability; HTTP/gRPC status codes alone cannot evaluate every protocol. Do not promise availability or latency figures before measurement.

## Management UI and Query Permissions

| Entry point | Main information |
|---|---|
| Platform health | Platform administrators only: API, background tasks, Operator, dependencies, and collection-system health |
| Project overview | Abnormal instances, active alerts, resources and capacity, traffic and hit trends grouped by protocol |
| Instance overview | Service status, configuration application, collection status, capacity, and recent alerts |
| Instance metrics | Traffic, errors, latency, hits, capacity, eviction, resources; show only supported metrics |
| Instance diagnostics | Events, operations, and access-controlled logs correlated by time; traces linked later |
| Alert center | Impact scope, start time, status, troubleshooting guidance, and silence management |

Preserve the incident time window when navigating from an alert to an instance, then correlate metrics, logs, and operations from that period. Continue English and Chinese internationalization, with stable status codes translated by the UI; transmit times in UTC and display them in the user's timezone, with explicit units and data update times. Do not automatically translate raw logs.

Extend the management API's existing `/statistics` and `/statistics/history` while preserving compatibility with published interfaces; add typed interfaces for metric groups, logs, events, and alerts. The frontend submits preset views, bounded time ranges, and filters, and the server constructs queries. Ordinary users do not receive arbitrary PromQL, LogQL, or data-source-address access.

The suggested policy allows project members to view aggregate metrics and redacted status events; detailed logs and diagnostics are visible only to maintainers/admins, and internal platform logs only to platform administrators. Check permissions and the original instance binding before querying; history after deletion retains the original UID and project permissions. Cached query results must also include the authorization scope, and revoked members must not retain access to cached results.

Log, alert, and trace ID queries all require fresh authorization; only platform administrators can view cross-project control-plane traces, while project pages provide diagnostics limited to their scope. Collection infrastructure overwrites identity labels or generates them from trusted bindings; the browser cannot specify the tenant. Shared Prometheus itself is not a project authorization boundary. [Prometheus security model](https://prometheus.io/docs/operating/security/)

Existing history queries retain `1h/6h/24h`; expand to longer periods after confirming backend retention capabilities. Initial log-query limits are suggested at 1,000 entries or 1 MiB per request, with bounded time windows, query duration, and concurrency; return a truncation marker and cursor when limits are reached. The server controls every limit; aggregate queries have project-size budgets and short-lived caching to avoid separate large queries per instance on overview pages.

## Retention, Cost, and Failure Isolation

Initial deployment suggestions are 15 days for metrics, 7 days for runtime logs, 30 days for diagnostic events and alert history, and 3 days for traces; configure audit retention separately under enterprise policy. These are deployment parameters awaiting validation, not existing retention commitments; data remains in enterprise-designated backends.

Metrics retain an approximately 30-second scrape interval. Estimate costs from instance count, time series per instance, histogram bucket count, and retention; estimate log costs from daily ingestion volume. Limit samples per target, field lengths, log rates, and query concurrency. Longer-term aggregation may add recording rules, but raw-data costs decrease only when downsampling or deletion policies are actually configured.

Runtime logs and traces use asynchronous bounded queues so backend failures do not block cache reads/writes; drops on overflow must be countable. Critical collection nodes may use persistent queues, but still need disk and retry-deadline monitoring; do not claim data can never be lost. [Collector resiliency mechanisms](https://opentelemetry.io/docs/collector/resiliency/)

Monitoring integration failures affect only observability status, without changing cache Ready or forcing instance restarts. Record rule evaluations, collection success times, data drops, and query failures; test that the cache data plane remains functional when monitoring is unavailable. Assign separate resource budgets to alerting, log backends, and platform components.

## Implementation Sequence and Acceptance

| Phase | Delivery scope | Acceptance criteria |
|---|---|---|
| Phase 1: Basic observation | Structured management API logs, Operator/API/Worker metrics, unified identity and capability contracts, resource and capacity history, continuous Gradle collection | Correct permission isolation, counter resets, instance recreation, missing-data versus zero handling, template capabilities, and sample freshness |
| Phase 2: Diagnostics and alerts | Platform and instance pages, event timelines, log queries, built-in alerts and history, enterprise notification-channel integration | Correct alert firing and recovery, silence ownership, history deduplication, log redaction, cross-project denial, and fault localization |
| Phase 3: Deeper capabilities | Traces, internally developed WebDAV metrics, tiered-cache analysis, SLOs, and large-scale optimization | Correct asynchronous operation correlation, no fabricated unknown trace segments, and performance and monitoring costs meeting defined targets under real workloads |

Validation continues through unit tests, contracts against real Prometheus/log backends, and isolated Kubernetes integration testing. Focus on credential rotation, Pod recreation, data-source interruptions, full queues, member revocation, duplicate collection, and alert behavior after suspension/deletion; test rules using replayable samples and verify English/Chinese, timezones, gaps, and alert navigation in the browser.

Implementation locations: add instrumentation and restricted query adapters in `apps/admin-api`; expose Operator metrics and extend template collection contracts in `operator`; add metrics to internally developed cache processes; add observability and diagnostic pages in `apps/admin-web`; and add optional integration parameters and rule delivery in `deploy/charts`. Pin and validate specific library versions, metric names, and thresholds before implementing each phase.
