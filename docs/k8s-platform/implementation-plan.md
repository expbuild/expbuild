# expbuild Kubernetes Platform Implementation Plan

Date: 2026-09-29. Status: original implementation baseline, not a statement of current completion; see [Implementation Status](progress.md#current-outstanding-work) for the one-time cluster acceptance results and current outstanding work. Companion document: [Architecture and Product Overview](README.md).

See [Implementation Status](progress.md) for current progress. `feat/k8s-cache-platform` already has an [Operator](../../operator/README.md), [Management API](../../apps/admin-api/README.md), and management UI. The phase sequence and initial scope here remain as design background; Implementation Status takes precedence for subsequent acceptance results and the user's decision not to expand WebDAV for now.

## 1. Delivery Goals and Decisions

Implement an enterprise self-hosted cache service management platform: users select an engine template in the console, create an independent instance, obtain its access address and client configuration, view instance statistics, adjust cache policies, and manage suspension, resumption, upgrades, and deletion.

The original initial-release baseline included bazel-remote (REAPI and Bazel HTTP) and WebDAV. Gradle HTTP has now been integrated; the existing WebDAV implementation remains unchanged, with a replacement service to be selected by the user later. HTTP upstream proxies and additional REAPI engines remain future extensions. See [Current Outstanding Work](progress.md#current-outstanding-work) for specific completion status and delivery gates.

| Decision | Implementation baseline |
|---|---|
| Repository | Single repository; management UI, API, and Operator as separate components |
| Management UI | React + TypeScript; migrate useful UI and restructure around projects and instances |
| Management API | TypeScript, Kubernetes SDK, OpenAPI contract |
| Management data | PostgreSQL with versioned migrations |
| Instance reconciliation | Go + controller-runtime, CacheInstance CRD |
| Workloads | Single-replica StatefulSet initially, with a dedicated PVC per instance |
| Templates | Versioned descriptions, schemas, and compiled-in adapters shipped with the platform |
| Statistics | Prometheus-compatible queries; separate business and resource metrics |
| Ingress | Shared TLS ingress and stable per-instance domains; certify only one ingress adapter implementation initially |
| Delivery | Helm installation package, pinned image inventory, enterprise registry mapping |
| Extension boundary | Add new engines through template adapters without changing the base user/project/API model |

A single cluster and single replicas define the initial scope; there is no promise that all engines can run directly with multiple replicas. Development machines, operating systems, K3s, kind, and cloud providers are not constraints. The old unified CacheCatalog, cross-engine deduplication, and remote execution designs are outside the current implementation.

## 2. Module Responsibilities and Call Relationships

```text
admin-web → admin-api → PostgreSQL (identity, ownership, operations, and audit)
                    → Kubernetes API (CacheInstance, credentials)
                    → Prometheus API (authorized, constrained queries)

operator → Kubernetes API (watch CRs, maintain workloads/volumes/ingress, write status)

Build tools → instance domain → shared ingress → cache engine → PVC
```

The management API does not execute shell/kubectl for routine management or assemble arbitrary Kubernetes objects from user input. The Operator does not handle user login, project membership, or cache file contents. Running cache instances should continue serving when management components fail, provided their native credentials and storage remain valid.

The management API encapsulates its Kubernetes and metrics clients separately and converts errors to stable business error codes. Operator template adapters accept validated configuration and output deterministic resource descriptions and status evaluation rules; business state does not depend on controller process memory.

## 3. Management Data and Instance Ownership

The initial permission model is “user → project membership → project → instance”; instances are not permanently owned by individuals. `created_by` is for auditing only. Reserve organization boundaries, but do not implement SaaS billing or cross-organization sharing.

| Table | Minimum fields / constraints |
|---|---|
| users | id, login identifier, credential verification information or external identity reference, status |
| projects | id, name, cluster_id, namespace, status; unique cluster-to-namespace mapping |
| project_members | project_id, user_id, role; composite uniqueness |
| instance_bindings | id, project_id, cluster_id, namespace, resource_name, kubernetes_uid, created_by, lifecycle; unique resource location |
| operations | id, project_id, instance_id, kind, idempotency_key, request_hash, target_generation, state, error, timestamps |
| audit_events | actor, project_id, instance_id, operation_id, action, redacted change summary, result, time |
| instance_credentials | id, instance_id, name, Secret reference, version, active/revoked status; no directly readable plaintext credentials |

Do not store a separately editable business copy of the instance spec. Operation requests may retain redacted target configuration briefly for retries, but it is not the authoritative source of instance configuration. Frequently refreshed runtime status caches carry an update time and must not appear freshly confirmed when Kubernetes is unreachable.

`instance_bindings.id` is a stable random ID generated by the platform, and Kubernetes resource names use that ID; the user-editable display name is stored separately as instance presentation information. Once the CR UID is recorded, every change/deletion checks the UID to prevent accidental operations after a same-named resource is recreated.

Permission roles:

| Role | Permissions |
|---|---|
| Platform administrator | Platform configuration, project and template management, failure recovery |
| Project administrator | Project members, instance creation/modification/deletion, credentials, statistics |
| Project maintainer | Instance creation, configuration, suspension/resumption, and statistics; no membership, credential, or destructive clear/delete management |
| Project viewer | Non-sensitive instance information, statistics, and redacted events |

The initial release provides local accounts, server-side sessions, and password hashing; every request rechecks the active user and project permissions, and browser state changes have CSRF protection. OIDC is a later login adapter, not a prerequisite for basic operation in the initial release.

Platform credential management is separate from cache data access: expose only credential capabilities verified for the engine. Generated secret values are returned only on creation, never in routine GET responses; files required by the engine are written to a Secret in the same namespace as the instance. Revocation/rotation is asynchronous and is reported complete only after the engine is confirmed to have applied it; a Secret update is not immediate revocation.

## 4. Project and Kubernetes Boundaries

When a platform administrator creates a project, the API uses dedicated, restricted cluster bootstrap permissions to create its namespace and required RBAC/quotas/base network policies, or binds a verified dedicated namespace; instance creation is allowed only after initialization completes. Ordinary members cannot choose arbitrary project namespaces. Routine instance operations use restricted permissions and do not require cluster-admin.

The management API writes CacheInstance spec and controlled credentials; the Operator writes CacheInstance status, finalizers, and managed resources. They use separate ServiceAccounts. CRD installation and cluster permission bootstrapping belong to the installation process; routine reconciliation does not create arbitrary cluster-scoped resources.

Instances within a namespace cannot communicate with each other by default; allow ingress, monitoring, DNS, and other traffic as needed. Enforcement depends on CNI acceptance testing. Images, StorageClasses, ingress configuration, and Secret references are constrained by platform allowlists and instance ownership checks. Permission to “edit a CR” must not become permission to execute arbitrary images, mounts, or service accounts.

Administrators editing CRs outside the API must still pass CRD validation and Operator capability checks; these operations appear as external changes. Unbound CRs require explicit import by a platform administrator; labels alone cannot automatically grant ownership. The initial release does not automatically delete unbound resources.

## 5. CacheInstance and Template Contract

The resource schema builds on the example in the architecture overview, with these additional rules:

- Record immutable platform instance and project IDs in metadata; spec defines the template reference, resources, storage, access, and eviction configuration. Enforce immutable ownership through validation during implementation.
- Initially, `desiredState` supports only Running and Suspended. In-place template changes across engines are not allowed.
- Capacity expansion must pass storage capability checks; volume shrinking is prohibited. Changing StorageClass or migrating data is not an ordinary PATCH.
- Credential references must point to Secrets created by the platform and bound to that instance, never secrets belonging to other instances in the same namespace.
- All updates carry version preconditions. The API accepts If-Match corresponding to the resource version and does not unconditionally overwrite concurrent configuration changes.
- status stores `observedGeneration`, `appliedTemplateVersion`, `appliedConfigHash`, `credentialRevision`, `endpoints[]`, and conditions. Each condition is associated with the observed version.
- Endpoints distinguish protocol, URL, and readiness; overall Ready must correspond to the current configuration and required endpoints. During updates, the old service may be shown as still available, but the new policy must not be claimed to be active.

Minimum template adapter operations:

| Operation | Inputs and outputs |
|---|---|
| Validate | Configuration + platform capabilities → acceptance or explicit error |
| Render | Instance + pinned template → workload, configuration, service, and monitoring descriptions |
| Observe | Current resources and required probe results → conditions and actual versions |
| PlanUpdate | Old and new configuration → update allowed, restart required, or rejection with reason |
| PlanMaintenance | Supported operation → maintenance plan, mutual-exclusion conditions, and completion criteria |
| ConnectionInfo | Endpoints + authentication method → client examples without secret values |

Version the schema, default configuration, capability matrix, image pins, and metric mappings together. The template API shows support for TTL, LRU, online changes, clearing, credential rotation, and so on; reject unsupported input directly. Administrators cannot extend templates by uploading arbitrary executable code through the frontend.

API validation provides prompt feedback, and the Operator validates again; test both against contract fixtures for the same template version to prevent the UI accepting something the reconciler cannot execute.

## 6. Asynchronous Operations, Idempotency, and Failure Recovery

### Creation

1. Validate user permissions, template, and project status; create a stable instance ID, pending binding, operation, and audit intent in a database transaction.
2. The API returns 202 and an operation ID. A background operation worker handles pending operations through expiring claims that permit takeover after a crash; the initial release does not depend on an additional message queue.
3. The worker idempotently creates credentials and the CR; fixed resource names and request fingerprints verify retries. If an existing object differs, mark a conflict rather than overwriting it.
4. Write back the CR UID and target generation. The Operator reconciles actual resources.
5. The operation tracks the target version's status. Complete when the required conditions are ready; report a timeout past the operation deadline without automatically deleting storage already created.

Idempotency keys are unique within the project and action scope; the same key with the same request returns the same operation, while a different request returns a conflict. Recheck permissions and operation ownership before retrying; historical operations must not provide access to someone else's information. The worker retries Kubernetes request failures after database commit; when Kubernetes succeeds but the database write-back fails, reconcile by resource ID/fingerprint/UID.

### Updates and Operation Queuing

Initially, allow only one active change operation per instance; new changes return a conflict and the current operation ID. The database serializes platform requests, while Kubernetes resourceVersion also protects against external changes. An expired operation claim does not allow a second configuration change to bypass an unconfirmed first operation; takeover continues the same operation.

Suggested states are `pending → applying → reconciling → succeeded/failed`, with `superseded` recorded when an external newer version replaces the target. A timeout may end the user-visible wait, but reconciliation may still finish later; the page displays the operation result separately from the latest instance status and must not interpret a timeout as a resource rollback.

### Suspension, Deletion, and Retention

Suspension stops the workload from serving and retains its PVC; resumption starts it again. Deletion uses a UID precondition, revokes routing and access first, waits for the workload to stop, and then handles storage according to storage.deletionPolicy.

Retain PVCs are not garbage-collected with the CR; the database retains ownership and detached status, with administrator inspection, explicit cleanup, and controlled reclamation operations. Deleting an instance does not delete its project; initially, reject direct project deletion while instances or retained volumes remain and require those resources to be handled first.

The Operator advances deletion finalizers through retryable steps. A management API timeout does not remove finalizers; recovery records the actual resources at every step, and manual forced handling is an audited administrator action.

### Control Plane Unavailability

When the Kubernetes API is unavailable, queries return the last observation time and unreachable status, and change operations remain pending retry or fail explicitly. Reject new management writes when the database is unavailable. Monitoring unavailability only marks statistics unavailable. None of these cases should fabricate “instance does not exist” or “metrics are zero,” or trigger clearing.

## 7. Dedicated Domains and Access Configuration

Administrators configure baseDomain, the shared ingress adapter, and a TLS Secret; DNS points wildcard subdomains at the ingress. The initial release does not call DNS provider APIs or require public access; internal domains are also supported.

The default is `cache-<instance-id>.<base-domain>`. If the first ingress cannot reliably route gRPC and HTTP separately on the same hostname, use `grpc-<id>` and `http-<id>` as two domains, each targeting the corresponding Service port of the same instance. “A web page opens” is not evidence of successful protocol routing.

TLS terminates at the shared ingress; initially, validate the full client → ingress → engine authentication chain. Native engine authentication information must be forwarded correctly. If mTLS must terminate at the ingress or engine, the template must explicitly support that termination point; client certificate passthrough is not a default capability.

The Operator maintains only the current instance's routes, not shared DNS/certificates. EndpointReady checks include route acceptance, backend readiness, and executable protocol probes; external DNS/TLS reachability is a separate diagnostic, and successful in-cluster requests must not be reported as reachability from every external network.

Domains and endpoint displays are bound to the instance ID and do not change with the display name. Instance deletion revokes routing; IDs are not reused, reducing confusion from old addresses pointing to new instances.

## 8. Statistics, Eviction, and Maintenance

See the [Platform Observability Plan](observability-plan.md) for phased observability design. The first release implements basic collection, project/instance pages, and log and alert integrations; see the [Observability Integration Guide](observability.md) for the support matrix and remaining deeper work. See the [Monitoring Guide](monitoring.md) for the older Prometheus history interface.

Prometheus stores time series; the API constructs constrained queries according to project permissions. Basic dashboards cover request volume, error rate, latency, read/write traffic, resources, and capacity; REAPI AC/CAS, HTTP, and WebDAV define business statistics separately without forcing a uniform hit rate.

Each metric mapping records the engine name, source metric, unit, counter/histogram type, query window, and unavailability conditions. Metric labels bind to the instance UID, allowing authorized queries of retained historical data after instance deletion. GET 2xx or gRPC OK does not automatically mean a cache hit.

Eviction is primarily performed by the engine. Initially, bazel-remote exposes its capacity budget and native LRU; WebDAV must verify capacity/cleanup behavior before publishing its support list. Without evidence for online configuration updates, explicitly state that changes take effect after restart. PolicyApplied requires a verifiable condition showing that the running process has applied the target configuration.

Maintenance Jobs are used only for operations explicitly supported by the template and carry operation IDs and mutual exclusion. Cleanup requiring downtime first stops the engine and confirms there are no active writes, then resumes it after maintenance; a generic cleaner and engine must not concurrently manipulate unknown internal file formats. On failure, retain maintenance status and the reason rather than returning to running by default.

## 9. Installation, Upgrades, and Repository Migration

Target directories in the main repository: `apps/admin-web`, `apps/admin-api`, `operator`, `templates`, `images`, `deploy/charts/expbuild`, `tests/e2e`, and `docs`; optional `dev` supports development. Migrating the management application is an implementation task; writing this plan does not directly move source code.

Helm installs platform components and permissions; the Operator reconciles instances. External PostgreSQL, metrics services, StorageClass, and ingress are explicit deployment configuration; a demo dependency package may be provided, but enterprises need not redeploy existing infrastructure.

Validate CRDs, Kubernetes version, storage, ingress, and image reachability before installation. CRD upgrades use explicit, versioned steps; do not assume a normal Helm upgrade automatically upgrades the crds directory. A single migration job/deployment step runs database migrations; multiple API replicas do not race to run them independently.

Upgrades first check the API/Operator compatibility ranges for templates and CR schemas; existing instances pin images and templates, and engine versions do not automatically change with platform upgrades. Rollback must check database schema and engine data format compatibility, not merely roll back image tags.

The uninstall runbook handles cache instances and retained volumes before removing the Operator; if administrators only suspend or remove the control plane, clearly state that Helm will not automatically clean up all cache workloads. Do not blindly delete the CRD while CRs remain, which would lose management records.

## 10. Implementation Milestones and Acceptance

| Phase | Main deliverables | Completion criteria |
|---|---|---|
| M0 Contracts and engine validation | Pinned bazel-remote version, WebDAV candidate conclusions, ingress/storage baseline, template capability inventory | Real-client and cleanup/recovery validation records; unsupported capabilities explicitly disabled |
| M1 Platform skeleton | Single-repository layout, API/frontend skeletons, PG migrations, CRD, Operator, CI | Validatable contracts, buildable images, passing basic reconciliation tests |
| M2 First complete instance workflow | bazel-remote creation/access/update/suspension/resumption/deletion | Actual remote hits, authentication rejection, restart recovery, and Retain behavior pass |
| M3 Management and governance | Project roles, asynchronous operations, credentials, domains, statistics, policy UI | Cross-project access denied; correct retry idempotency, concurrency conflicts, and operation status |
| M4 Second engine | WebDAV template, protocol metrics, and certified cleanup capabilities | Integration without changing the base permission/instance model; real-client and concurrent-cleanup tests pass |
| M5 Enterprise delivery | Helm, image mapping, installation/upgrade/recovery/uninstall documentation | Installation and upgrades pass on target cluster combinations without unintended data cleanup |

Phases represent dependencies and delivery sequence, not calendar commitments. M0 sets a short PoC for each decision: if it fails, replace the candidate or explicitly block the corresponding template rather than extending platform abstraction design indefinitely.

Suggested implementation tasks:

| ID | Task | Dependencies |
|---|---|---|
| K01 | Migration boundaries, directories, and component build configuration | This plan |
| K02 | bazel-remote version/protocol/metrics/eviction validation | None |
| K03 | WebDAV engine, cleanup semantics, and license validation | None |
| K04 | CRD, template schema, shared contract fixtures | K02, incorporating K03 conclusions |
| K05 | Operator resource reconciliation, status, finalizers | K04 |
| K06 | PG model, identity, projects, and RBAC | K01 |
| K07 | Operation worker, Kubernetes client, instance API | K04, K06 |
| K08 | Ingress adapter, domains, credentials, and protocol access | K02, K05, K07 |
| K09 | Console project/instance/operation pages | K06, K07 |
| K10 | Metric mappings, query API, policy and statistics pages | K02, K05, K09 |
| K11 | WebDAV adapter and full acceptance | K03, K05, K08, K10 |
| K12 | Helm, image inventory, upgrade/uninstall, and full-workflow tests | K08–K11 |

Required acceptance scenarios:

- Users in two projects cannot access each other's instance information, metrics, events, or credentials, or use Secret references to access another instance.
- Duplicate creation with the same idempotency key, an API crash after Kubernetes succeeds, expired worker claims, and Operator restarts all recover without duplicate instances or lost storage ownership.
- UID checks reject erroneous updates/deletions when an external actor recreates a same-named resource; concurrent PATCH requests produce explicit conflicts.
- Real clients perform REAPI/Bazel HTTP/WebDAV reads and writes, and independent clients demonstrate remote hits; local caches must not mask server-side problems.
- Near-capacity behavior, eviction, and concurrent uploads/downloads; invalid configuration never reports PolicyApplied; credential rotation completes only after confirmed application.
- Suspension/resumption, Pod recreation, interrupted deletion, Retain volume reclamation and cleanup, platform component failures, and cluster API disconnection.
- gRPC, WebDAV methods, large files, domain routing, TLS, production storage, and network policies are all validated in certified combinations.

Measure performance with real-client workloads: time spent in instance creation stages, idle resource overhead, protocol latency/throughput, restart scan time, and reconciliation/metrics overhead as instance counts grow. Determine specific SLOs through baseline testing; do not claim second-scale startup or a particular cluster size before measurement.

## 11. Bounded Decisions Still Requiring Validation

| Item | Decision owner and deadline | Default approach |
|---|---|---|
| bazel-remote image version/digest and client versions | Engine adapter owner; pin on K02 completion | Do not use floating latest |
| WebDAV engine and safe cleanup capabilities | Engine adapter owner; pin on K03 completion | Do not label a generic file server a complete cache engine |
| Ingress implementation and multiprotocol routing | Platform owner; finish PoC before K08 | One certified adapter, with separate protocol subdomains if necessary |
| Kubernetes/storage/CNI version combinations | Platform owner; establish compatibility matrix from M0 | At least one fully certified combination; mark others unverified |
| Resource defaults and performance SLOs | After protocol end-to-end validation, before M5 | Do not treat template example values as capacity commitments |

These are prerequisite implementation validation tasks. They do not require the user to answer unrelated technology-selection questions or turn earlier learning-oriented questions into constraints.
