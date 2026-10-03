# Test layers and reproduction

Each layer has a different validation scope. See [implementation status](progress.md) for the latest actual results. Passing tests does not mean every product capability is complete.

| Layer | Validation scope | Not covered |
| --- | --- | --- |
| Go unit tests, fake client | Configuration rendering, ownership checks, reconciliation state machine, failure branches | Real API, scheduling, container execution |
| envtest | Isolated API server/etcd, CRDs, RBAC, generation/status, resource reconciliation | kubelet, PVC provisioning, networking |
| API/PostgreSQL | Real database transactions, authorization, idempotency, worker recovery; mocked Kubernetes | Actual cluster permissions and workloads |
| React component tests | Permission-aware UI, forms, confirmations, errors, one-time credentials | Complete real-browser interaction |
| Native engine and container checks | Actual protocols, authentication, image entry points, non-root/read-only root filesystem | Complete Kubernetes lifecycle |
| Isolated kind Operator tests | StatefulSet/PVC, recreation, pause/resume, credentials, leader election, Retain/Delete | Management API, Helm, production CSI |
| Isolated kind Helm/API tests | Chart installation/migration/bootstrap/upgrade/uninstallation; public API through to real instances | TLS ingress, network isolation, REAPI clients, browsers |

## Isolated-cluster tests

The corresponding workflow is `.github/workflows/cluster.yml`. Each test creates a uniquely named kind cluster and always explicitly uses a temporary kubeconfig/context. On normal completion or failure, only that test cluster is deleted. The default kubeconfig is never read, and images are not published.

Local reproduction requires Docker, Python 3, kind v0.27.0, and kubectl v1.32.2; Helm tests also require Helm v3.17.3. Scripts pin the kind node image digest; WebDAV uses a digest-pinned Apache image and actual Operator-rendered configuration.

Run from the repository root:

```sh
docker build -f images/operator/Dockerfile -t expbuild/operator:test .
python3 tools/cluster_lifecycle.py
```

Full control-plane tests also require local builds of the other two images:

```sh
docker build -f images/admin-api/Dockerfile -t expbuild/admin-api:test .
docker build -f images/admin-web/Dockerfile -t expbuild/admin-web:test .
python3 tools/helm_lifecycle.py
```

Helm tests start separate PostgreSQL inside the temporary cluster and do not use an external database. They use the real chart's migration and administrator bootstrap Jobs, call project and instance APIs through login/session/CSRF, wait for asynchronous operations to complete, then verify reads/writes, pause/resume, and password rotation. After upgrade, they check that data remains readable, delete instances through the API, and check PVC and credential cleanup. A separate Retain instance is also created; after instance deletion, the retained PVC is queried and deletion confirmed through the dedicated cleanup endpoint, before the Helm release is finally uninstalled.

Test credentials are used only in disposable clusters. On request failure, output includes only the operation path, status, or error code, never plaintext passwords from creation or rotation responses. Diagnostics include workload status, events, and service logs, but do not print Secret data.

Default internal mode accesses services through port forwarding and does not prove Ingress, DNS, or TLS availability; Gateway mode below separately validates a real TLS proxy. kind's default network does not provide isolation acceptance for this project's network policies; that gate must be validated separately with a policy-enforcing CNI. The test database uses temporary storage and does not demonstrate database backup, recovery, or high availability. Tests delete cache instances before uninstalling; this must not be taken to mean that Helm uninstallation automatically cleans up all project workloads.

## Real Gateway data-plane tests

Gateway mode additionally requires Go and OpenSSL. `python3 tools/helm_lifecycle.py --gateway` installs Envoy Gateway v1.8.5 in the same isolated cluster, verifies the chart archive SHA256, and pins image digests for both the controller and Envoy v1.38.4 proxy. The script generates a short-lived test CA and wildcard leaf certificate. It accesses a real TLS listener through local port forwarding to the Gateway Service; clients still validate the actual hostname/SNI and certificate trust, without options that skip certificate verification.

WebDAV checks cover anonymous rejection, rejection of incorrect hostnames/untrusted CAs, 16 MiB PUT/GET, PROPFIND, LOCK and lock-constrained DELETE, pause/resume, credential rotation, and ingress revocation after instance deletion. Deliberately rejected TLS tests use separate port-forwarding sessions so kubectl exiting after a connection reset does not affect subsequent tests.

The same job then creates a digest-pinned bazel-remote v2.6.2 instance. A Go contract client uses trusted TLS and gRPC authority to verify capabilities, FindMissingBlobs, chunked 8 MiB ByteStream upload/download, rejection of anonymous access and old passwords, and reads of original data after rolling credential updates. It constructs wire messages from standard protobuf fields; this does not qualify a complete Bazel build client, ActionCache, or compression protocol. Credentials are handed over in temporary files with mode 0600, removed after use, and never appear in command-line arguments or logs.

This test has no public DNS, external load balancer, or NetworkPolicy-enforcing CNI, so it does not demonstrate those facilities. See [implementation status](progress.md) for actual passes and failure records.

## Isolated cluster with NetworkPolicy enforcement

`python3 tools/helm_lifecycle.py --gateway --isolation` creates a separate kind cluster with the default CNI disabled, installs Cilium 1.19.7 with a pinned chart SHA256, and verifies that all rendered component images use digest references. The version follows the [official v1.19.7 compatibility matrix](https://github.com/cilium/cilium/blob/v1.19.7/Documentation/network/kubernetes/compatibility.rst), which includes Kubernetes 1.32 used by the current tests. Tests retain kube-proxy, use Kubernetes IPAM, and do not enable Cilium Gateway or extra L7 proxies.

CI adds isolation mode, including the existing Gateway/TLS, automatic Prometheus collection, and rotation paths, plus new TCP connections directly from test Pods. It does not use port forwarding to judge NetworkPolicy. Both Service IP and Pod IP targets are covered:

- Cache ports 8080/9092 are reachable only when namespace authorization and client=true are both present.
- Pods with only namespace authorization, only the Pod label, authorization for another project, or no authorization within the same project cannot connect.
- Forged Gateway/monitoring Pod labels cannot bypass namespace restrictions.
- Appropriately labeled Pods in the designated Gateway namespace can access both ports; appropriately labeled Pods in the monitoring namespace can access only 8080.
- Removing namespace authorization or the client Pod label blocks new connections; restoring labels restores connectivity.

Negative assertions require TCP timeouts; DNS errors, connection refusal, or process errors do not count as policy enforcement. Positive checks verify service reachability before and after revocation. Existing connections, multi-node cross-node traffic, IPv6, other CNIs, and production networking are outside this scope. The new job is implemented; actual passing status is determined by implementation records and CI.

## Real-browser management workflows

`npm run test:browser` uses pinned Playwright/Chromium, a built admin-web, the actual Fastify API, and PostgreSQL. The launcher creates a dedicated randomly named database and applies all migrations, deleting only its own database on exit. It does not reuse running services, read a business kubeconfig, or install a Kubernetes client/worker. Projects remain pending after creation, so these tests must not be recorded as successful cache-instance deployments.

Set `TEST_DATABASE_URL` to dedicated test PostgreSQL (the account needs permission to create test databases), then run from the repository root:

```sh
npm ci
npm run build
npx playwright install --with-deps chromium --only-shell
npm run test:browser
```

Local execution requires a free 127.0.0.1:4173. Browser and database connections use real network requests; API responses are neither intercepted nor fabricated. Tests create only public test accounts and temporary data. Coverage includes login/logout, HttpOnly sessions, project creation, quota saving and persistence after refresh, rejection of missing CSRF, cross-project access denial, and stale-version quota-write conflicts after a new tab inherits a session. Screenshots and traces are retained only on failure in local `test-results/browser`; automatic upload is not configured.

Management API CI now includes browser installation and execution steps. Current coverage does not include creating real cache instances from the browser, file reads/writes, real domains, or production ingress; these still need integration with the isolated Kubernetes path. Component-test results cannot substitute for a failed browser run.
