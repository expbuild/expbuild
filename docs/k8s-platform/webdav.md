# WebDAV engine implementation progress

The second engine uses Apache HTTP Server's [mod_dav](https://httpd.apache.org/docs/2.4/mod/mod_dav.html)
and [mod_dav_fs](https://httpd.apache.org/docs/2.4/mod/mod_dav_fs.html). It is currently integrated with
the Operator, CRD, Helm image parameters, management API, management UI, and real protocol tests.

See the [custom WebDAV cache-service proposal](webdav-cache-plan.md) for future direction. That proposal is not yet implemented and does not change the Apache template's capabilities or validation boundaries recorded here.

## Resources and capabilities

- Template name: `webdav-apache`. New instances use `0.2.0`; existing `0.1.0` instances continue to be maintained according to their original version. Single-replica StatefulSet + separate PVC.
- Separate HTTP service using htpasswd; both reads and writes require authentication.
- Runs as UID/GID 1000 with fsGroup 1000, a read-only root filesystem, and no extra capabilities.
- Content lives in `/data/content`; the DAV lock database lives in `/data/locks` and is not exposed as content.
- Configuration uses a separate immutable ConfigMap; existing pause, credential-version, ownership-check, and Retain/Delete workflows are reused.
- Readiness requires the workload revision to be complete and a Depth=0 PROPFIND with probe credentials that validates a 207 DAV XML response.
- `enginePolicy: none`, `maxCacheGiB: 0`. The CRD rejects REAPI LRU/budget configuration for WebDAV. `0.2.0` adds a read-only content-scanning sidecar using `/webdav-stats` from the trusted Operator image; instance CPU/memory requests and limits are split between the two containers without changing the totals.

Apache has no native cache LRU or disk quota. This template's PVC capacity is the requested volume size and cannot be treated as
a hard quota effective with every CSI driver. Nor can concurrently scanning and deleting active DAV files stand in for eviction,
because file and lock state must be coordinated. `0.2.0` scans regular files in `/data/content` in batches every 30 seconds, with limits of 1 million directory entries, 128 directory levels, and 15 seconds. A scan that cannot complete returns unavailable, not zero. `/status` is exposed only on port 9093 of the internal Service, requires current probe credentials, and uses a read-only scan mount. These data are approximate snapshots of file counts and sizes; `capacityBytes` is the PVC's requested capacity, not a CSI hard quota, and the data do not represent hit rates. Reliable eviction and request metrics still require separate implementation.

## Development deployment entry point

Configure the Operator with `--webdav-image=registry@sha256:digest`; Helm uses `images.webdav`.
The 0.2.0 statistics container additionally uses a separately approved `--webdav-stats-image` / `images.webdavStats` digest;
it does not change automatically with the controller image. Follow the [instance image migration procedure](image-upgrade-risk.md) before upgrading.
Without configuration, WebDAV instances report InvalidConfiguration; the Operator does not guess or pull arbitrary images.
`images/webdav/Dockerfile` uses Apache 2.4.68 trixie with a pinned digest checked against the official Registry.
The former 2.4.66-bookworm tag was confirmed missing in remote CI and replaced. The native protocol tests below use
Ubuntu Apache 2.4.66 and do not establish runtime qualification of the newer container image.

`operator/examples/webdav.yaml` shows the CR format. Before applying it, create a managed project namespace,
StorageClass, and ownership-matched Secret containing htpasswd, probe-username, and probe-password.
Configuring `images.webdav` in Helm also sets `WEBDAV_ENABLED=true` for the API; only then does the template catalog return WebDAV.
When disabled, the API rejects creation. Manual deployments must configure both the API flag and Operator image. Disabling the flag still allows
management of existing instances so pause or deletion is not blocked; retain the Operator image configuration until all instances have exited.
Specify `template: webdav-apache` and `cacheGiB: 0` on API creation; other resource parameters match the existing template.
The template catalog declares no native LRU or cache budget. `0.2.0` declares live content-statistics capability; older `0.1.0` still does not support statistics. The console displays capabilities by exact version.
Updates must preserve the original template; switching engines is prohibited. The console fetches available templates from the API and offers WebDAV creation when enabled; editing fixes the original template and hides cache-budget and statistics requests.
External access still requires TLS ingress; the current service address is internal HTTP.

## Verified behavior

Ubuntu Apache 2.4.66 binaries and runtime libraries were unpacked locally without installing or starting the system Apache service.
Tests use temporary directories and random local ports and stop the entire test process group on exit.

```sh
cd operator
APACHE_BIN=/path/to/apache2 APACHE_MODULES=/path/to/apache2/modules \
  go test ./internal/webdav -run TestApacheWebDAVContract -count=1 -v
```

Real tests passed bcrypt authentication, rejection of anonymous writes, MKCOL, PUT/GET, PROPFIND, LOCK,
rejection of DELETE without a lock token, and DELETE with the correct resource lock condition. Configuration supports either built-in or dynamically loaded UnixD.
Additional tests cover the resource model, capability constraints/reconciliation in an isolated API server, and protocol probes.

Real PostgreSQL with mocked Kubernetes verified template enablement restrictions, rejection of invalid budgets, creation through readiness,
rejection of cross-engine updates, no collection when statistics are unsupported, and the ability to pause existing instances after creation is disabled.

Real-cluster and management API integration tests for the current statistics implementation have been added to CI; results remain to be confirmed. Request metrics, reliable eviction, long-term scanning overhead, production CSI, lock persistence, and failure recovery still require validation.
