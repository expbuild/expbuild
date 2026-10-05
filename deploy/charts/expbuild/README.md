# expbuild Helm Chart

This chart installs the management API, static management UI, Operator, console HTTPS ingress, and migration jobs.
The deployer manages enterprise PostgreSQL, storage drivers, the Ingress Controller, TLS certificates, and Secrets.
Cache instances currently provide in-cluster access only; the Ingress here is for the management console, not cache domains.

## Prerequisites

1. Kubernetes 1.32+, an available dynamic StorageClass, and a CNI that supports NetworkPolicy.
2. Build and upload the three platform images; see `images/README.md` in the repository.
3. Verify compatibility between the bazel-remote image and clients, and obtain its SHA256 digest. All images in
   `ci-values.yaml` are non-deployable examples used only for template tests.
4. Prepare a PostgreSQL database and an existing control-plane namespace. One expbuild control plane per cluster
   is recommended; the current Operator watches all managed projects, so release names cannot isolate two control planes.
5. Label the control-plane namespace with `cache.expbuild.io/control-plane=true`.
   Control-plane access rules allow this source, and Operator protocol probes depend on it. Build clients use the separate authorization rules below.
6. Create the following existing Secrets in the control-plane namespace. Supply real values through your enterprise credential system;
   do not place Secret contents in Helm values or Git:

| Setting | Secret data keys | Purpose |
|---|---|---|
| `secrets.database` | `DATABASE_URL` | Database connection for the API and workers |
| `secrets.migrationDatabase` (optional) | `DATABASE_URL` | Migration account with DDL permissions; defaults to database when omitted |
| `secrets.operationEncryption` | `OPERATION_ENCRYPTION_KEY` | 32 random bytes represented as 64 hexadecimal characters |
| `secrets.bootstrap` (optional) | `ADMIN_EMAIL`, `ADMIN_PASSWORD` | Initial administrator bootstrap; password must be at least 12 characters |
| `ingress.tlsSecret` | `tls.crt`, `tls.key` | Console TLS; type kubernetes.io/tls |

Database migrations and administrator bootstrap must connect to the same database. Keep the operation-encryption key
secure when backing up the database; replacing it while operations are pending makes credential handoffs impossible to decrypt.

## Configuration and installation

Copy `values.yaml` into your deployment system and set real images, StorageClass, Secret names,
`appOrigin`, and `ingress.host`. The origin must be `https://` followed by a domain, with no trailing path.
Configure `imagePullSecrets` for private images. If a bootstrap Secret already exists, set
`bootstrap.enabled=true` for the initial installation. Bootstrap does not overwrite existing accounts; duplicate accounts cause the job to fail.

```sh
helm lint deploy/charts/expbuild -f /secure/path/production-values.yaml --strict
helm template expbuild deploy/charts/expbuild \
  --namespace expbuild-system -f /secure/path/production-values.yaml --include-crds
helm upgrade --install expbuild deploy/charts/expbuild \
  --namespace expbuild-system -f /secure/path/production-values.yaml --wait --timeout 10m
```

The namespace and Secrets must already exist. Installation requires permission to manage cluster-scoped CRDs/RBAC.
The chart assigns separate ServiceAccounts to the API and Operator; Web, migration, and bootstrap
jobs do not mount Kubernetes tokens. The API can create project namespaces, authentication Secrets,
NetworkPolicies, and CacheInstances; for retained-volume cleanup, it can also read/delete PVCs and list Pods to check volume references. The Operator manages instance resources and reads Secrets.

ClusterRole permissions apply cluster-wide; project ownership labels and UID checks are enforced by the application,
not by namespace restrictions in Kubernetes RBAC. The Operator cannot modify Secrets or delete PVs;
the API cannot delete PVs, update instance status, create StatefulSets, or grant RBAC permissions. Leader-election permissions apply only in the control-plane
namespace. The management UI's ServiceAccount has no resource permissions and does not mount a token.
Tests verify allow/deny boundaries for standalone and Helm manifests in a temporary API server;
they do not install into the deployer's actual cluster.
The application also checks resource ownership, but cluster administrators should treat the control plane as trusted infrastructure.

Ingress routes `/v1` to the API and other requests to Web, preserving same-origin cookies and CSRF behavior.
When ingress is disabled, provide your own same-origin reverse proxy; forwarding only the Web service is insufficient for API access.
If protection against password brute force is required, add shared rate limiting at the enterprise entry point; the API currently provides only process-local login rate limiting.

## Upgrades and rollback

For the image-binding release, apply the new CRD before updating the control plane. Existing instances are adopted only when their complete current image set
matches administrator-approved digests; after binding, installation values affect only new instances. WebDAV requires a separately approved digest for
`images.webdavStats`; do not reuse the controller tag. Older Operators do not understand bindings,
so a direct rollback to an older version is not supported. See [initial migration and recovery procedures](../../../docs/k8s-platform/image-upgrade-risk.md).

- The `pre-install,pre-upgrade` migration Job runs before new workloads start. Failure aborts the Helm
  operation. Migrations use transactions, locking, and checksums; they do not run automatically on every API Pod startup.
- Helm does not automatically upgrade existing CRDs in `crds/`. Review the new schema and back up existing CRs before upgrading,
  then have an authorized administrator apply the new CRD. `make generate` synchronizes both CRD copies, and CI checks their consistency.
- Database rollback is not part of Helm rollback. Back up PostgreSQL, keys, and Kubernetes resources before upgrading,
  and confirm that old images are compatible with the new database. There is currently no automatic downgrade SQL.
- Image qualification, rolling upgrades in a real cluster, and failure recovery remain delivery acceptance requirements; passing template tests is not a substitute.

## Uninstallation and retained data

Delete instances through the management API and wait for operations to complete before uninstalling the control plane. Retain instances keep their PVCs;
Delete instances are removed through controlled deletion by the running Operator. Uninstallation does not delete project namespaces, instance
CRs, PVCs, external Secrets, the database, or CRDs. Uninstalling directly leaves running caches and finalizers that cannot execute;
reinstall the control plane with the original keys, database, and correct configuration to resume processing.

## Validation boundaries

Chart linting, rendering, and resource validation with an isolated API server run locally/in CI. Image startup and Helm/API/WebDAV PVC lifecycles have passed isolated kind-cluster tests; TLS, production CSI, and cross-version upgrades still require acceptance testing. Container CI builds images and runs checks but does not publish images. See [implementation status](../../../docs/k8s-platform/progress.md) for detailed records.

## In-cluster build-client access

Project initialization creates two NetworkPolicies: `expbuild-isolation` and `expbuild-client-access`.
The former isolates inbound traffic to the project namespace while allowing the control plane; the latter allows only authorized clients to access cache Pods labeled
as managed by expbuild in the project, on TCP ports 8080 (HTTP/WebDAV) and 9092 (REAPI).

A cluster administrator labels the namespace that runs build jobs (replace `<project-id>` with the actual project UUID):

```sh
kubectl label namespace build-runners 'cache.expbuild.io/access-<project-id>=true'
```

Build Pods must also carry this label:

```yaml
metadata:
  labels:
    cache.expbuild.io/client: "true"
```

For a Deployment/Job, place the label in `spec.template.metadata.labels`.
Both namespace authorization and the Pod label are required. Each project uses a separate namespace label key;
an administrator can grant the same build namespace access to multiple projects. Network authorization does not replace instance credentials;
clients must still provide the instance username and password. Regular users should not have permission to change namespace authorization labels.

To revoke a namespace's network access to a project:

```sh
kubectl label namespace build-runners 'cache.expbuild.io/access-<project-id>-'
```

When revocation affects existing connections depends on the CNI; rotate the instance password as well if credentials must be revoked immediately.
These policies do not grant client egress access. If the client's namespace restricts egress, it must still allow the destination cache ports
and DNS resolution. Optional Gateway mode supports TLS and per-instance domains; the deployer supplies DNS, certificates, and a shared entry point. See [Gateway configuration](../../../docs/k8s-platform/gateway.md).

Projects created before the upgrade receive the client policies the next time an instance is created. For projects with only existing instances and no new creation,
the deployer must install the corresponding policies separately (use a newly generated project's policies to check fields, but do not copy its project identity).
Initialization checks do not overwrite client policies with the same name that belong to another owner or have been modified; they report a conflict. Policies are not continuously reconciled,
and additional NetworkPolicies may broaden access, so manage them together with cluster-wide policies.

The SDK's actual request format, repeated initialization, and conflict rejection have been verified. Real-client connectivity, cross-project denial, and
revocation effects still require acceptance testing with a NetworkPolicy-enforcing CNI.

## Retained-volume cleanup

After Retain deletion completes, view the actual retained volume in instance details; an administrator confirms cleanup by entering the volume name. The API queues the deletion asynchronously and records an audit event, checking the project, original instance UID, PVC UID, ownerReferences, whether the CR still exists, and all Pod volume references. Deletion uses PVC UID and resourceVersion preconditions to avoid removing a replacement volume with the same name. The operation completes only after PVC absence is confirmed.

This deletes the PVC claim; it does not directly delete the PV or guarantee erasure of underlying data. Actual reclamation follows the StorageClass/PV policy. Do not bypass the workflow by manually mounting a volume awaiting cleanup. External controllers with cluster write permissions may change resources concurrently, and PVC protection may keep cleanup waiting until references are removed. After a failure, resolve the cause, query again, and confirm again.

Instance details allow a new instance of the same template to be created using the original PVC; the platform first binds the new CR UID, then lets the Operator transfer the verified PVC's ownership labels. When upgrading an existing installation to use this capability, update the CacheInstance CRD first as described in “Upgrades and rollback”; Helm does not automatically upgrade the new fields. See [retained-volume reclaim](../../../docs/k8s-platform/retained-volume-reclaim.md) for operations, failure recovery, and CSI limitations.

## Per-instance domains

The optional `gateway.enabled` setting connects instance routes to an existing Gateway API HTTPS listener supplied by the deployer. It requires complete gateway configuration, DNS, certificates, and data-plane Pods with authorization labels; it is disabled by default. The Operator can manage instance HTTPRoutes/GRPCRoutes/ingress NetworkPolicies and has read-only access to Gateways; it cannot modify Gateways or certificates. Cleanup permissions remain when the feature is disabled so existing instance routes can still be revoked. See [ingress configuration and outstanding qualification](../../../docs/k8s-platform/gateway.md).

### Experimental Turborepo image

`images.turborepo` defaults to empty. Set an administrator-approved image digest to enable `turborepo-http@0.1.0` creation. Existing cache engines and defaults remain separate. See [Turborepo HTTP](../../../docs/k8s-platform/turborepo-http.md) for Bearer token scope, capacity limits and pending real-client acceptance.

### Experimental Nx image

`images.nx` defaults to empty. Set an administrator-approved image digest to enable `nx-http@0.1.0` creation. Existing cache engines and defaults remain separate. See [Nx HTTP](../../../docs/k8s-platform/nx-http.md) for Bearer token scope, capacity limits and pending real-client acceptance.

### Experimental Go cacheprog image

`images.goCache` defaults to empty. Configure an administrator-approved image digest to enable `go-cacheprog@0.1.0`; API and console creation default to server read-only. See [Go cacheprog](../../../docs/k8s-platform/go-cacheprog.md) for credential scope, configuration and pending real-client acceptance.
