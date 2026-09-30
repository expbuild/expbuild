# expbuild Kubernetes Operator

Implementation of the [platform plan](../docs/k8s-platform/implementation-plan.md).

## Implemented

- CacheInstance API, generated structural CRD and deepcopy methods.
- Multi-project controller-runtime manager with leader election and namespace ownership checks; optional single-namespace scope.
- Validated, digest-pinned bazel-remote rendering and idempotent reconciliation.
- Exact CR UID ownership checks; foreign resources are never adopted.
- Instance/project-bound auth Secret validation and credential revision rollouts.
- Immutable ConfigMaps, separate retained PVC, Services and StatefulSet.
- Running/Suspended desired state; finalizer removes access, stops Pods and
  performs explicit Retain/Delete volume handling.
- Readiness requires the current workload revision, bound storage, authenticated
  HTTP status with the requested budget, and an authenticated REAPI capabilities
  call. Failed probes do not report applied configuration.

## Tests and build

```sh
go test ./...
go vet ./...
make build
```

Real API server tests require envtest assets:

```sh
go install sigs.k8s.io/controller-runtime/tools/setup-envtest@v0.0.0-20250517180713-32e5e9e948a5
export KUBEBUILDER_ASSETS="$(setup-envtest use 1.32.0 -p path)"
go test ./internal/controller -run TestAPIServerContract -count=1
```

Generate committed schema/type files using controller-gen v0.17.2:

```sh
make generate
```

## Development deployment

Apply `config/crd/cache.expbuild.io_cacheinstances.yaml` with cluster bootstrap
permissions. Create the `expbuild-system` namespace and apply `config/rbac.yaml`.
Label the control plane namespace `cache.expbuild.io/control-plane=true` so
the project NetworkPolicy permits protocol probes. Each project namespace must
have `app.kubernetes.io/managed-by=expbuild` and `cache.expbuild.io/project-id`
matching its instances. The management API provisions these project labels.
Run the operator with its ServiceAccount (or an equivalently scoped development
identity):

```sh
go run ./cmd/operator \
  --leader-election-namespace expbuild-system \
  --bazel-remote-image "$APPROVED_BAZEL_REMOTE_IMAGE"
```

The image must be a verified SHA256-pinned image. The controller watches all
namespaces but checks project ownership before any reconciliation or cleanup.
Use `--namespace expbuild-demo` to restrict watches during debugging. For the
example CR, label that project namespace with `cache.expbuild.io/project-id=demo`.
Removing project ownership labels blocks reconciliation, including deletion;
restore the correct labels to resume managed cleanup.
Protocol probing needs network and DNS access to cluster Services. Local debugging
without that access can reconcile resources, but cannot report protocol readiness.

Before applying `examples/cacheinstance.yaml`, prepare its StorageClass and a
Secret named `cache-demo-auth` in `expbuild-demo` with labels:

```yaml
cache.expbuild.io/instance-id: demo-001
cache.expbuild.io/project-id: demo
```

The Secret needs `htpasswd`, `probe-username` and `probe-password` data keys.
The probe username/password must match a user in the htpasswd file. Provision
actual secrets separately; never commit them. Changes to the Secret trigger
reconciliation within the periodic refresh and roll the workload to reload auth.

The independent offline renderer is still available:

```sh
go run ./cmd/render -f examples/bazel-remote.yaml
```

Its example uses an intentionally nonexistent digest and prints YAML only; it is
an internal renderer contract, distinct from the CacheInstance CRD.

## Remaining delivery gates

This is not yet a production installation. Engine image/client certification,
non-root permissions, storage fencing, NetworkPolicy, TLS ingress, public domains,
metrics access controls, management API/UI, WebDAV and Helm delivery remain.
ReadWriteOnce plus one replica does not itself guarantee cross-node single writing.
Real API server tests do not run kubelet or a StatefulSet controller and therefore
do not prove actual engine startup, volume mounting or garbage collection.

Unreferenced immutable ConfigMaps are removed after a verified rollout or
suspension. Cleanup preserves the current workload template and every observed
Pod reference, validates exact controller ownership, and stops if the instance or
workload version changes. Manual cluster mutations racing with the snapshot are
outside the managed API contract. Retained-volume adoption UI remains pending.
The management API provisions and rotates versioned immutable credential Secrets. Deletion intentionally blocks on ownership conflicts rather than
risking another instance's data.

## Real cache engine contract

`BAZEL_REMOTE_BIN` enables `TestRealBazelRemoteContract`, which runs a verified
bazel-remote v2.6.2 release binary with renderer-generated configuration. The test
covers HTTP CAS, authenticated REAPI FindMissingBlobs, denied anonymous access,
and persisted data after restarting with a different credential. It uses only
local temporary files and ports. Download it with `tools/download_bazel_remote.py`
from the repository root; see [engine validation](../docs/k8s-platform/engine-validation.md).
This test does not certify the container image, PVC or complete Bazel clients.
