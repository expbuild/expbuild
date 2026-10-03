# Platform containers

Build from the repository root:

```sh
docker build -f images/admin-api/Dockerfile -t registry.example.com/expbuild/admin-api:0.1.0 .
docker build -f images/admin-web/Dockerfile -t registry.example.com/expbuild/admin-web:0.1.0 .
docker build -f images/operator/Dockerfile -t registry.example.com/expbuild/operator:0.1.0 .
docker build -f images/webdav/Dockerfile -t registry.example.com/expbuild/webdav:0.1.0 .
docker build -f images/gradle-cache/Dockerfile -t registry.example.com/expbuild/gradle-cache:0.1.0 .
```

Platform images use multi-stage builds. The API image contains compiled code, production dependencies, and SQL migrations,
and is also used for migration and bootstrap Jobs. The Web image serves static files with non-root Nginx; the Operator uses a static Go
binary and a non-root distroless image. The chart mounts a size-limited `/tmp` for writable temporary files.

The image build pipeline does not publish automatically. After publishing to your enterprise container registry, update deployment
values with the digests returned by the registry. Digest references are also recommended for all three platform images in production.
Base images currently use version tags; enterprises can pin their digests after verifying the supply chain. Cache-engine images are managed separately and must use digests.

The local environment has no Docker/Podman. The four images at commit d90d0a7 were successfully built in
[GitHub Actions](https://github.com/expbuild/expbuild/actions/runs/36662004310) but were not published.
WebDAV is based on digest-pinned Apache 2.4.68 trixie; the Operator mounts its configuration, authentication file, and data volume at runtime.
The Gradle HTTP engine image is connected to the Operator through the optional digest-pinned `images.gradle` setting; see the [engine record](../docs/k8s-platform/gradle-http.md) for actual cluster qualification progress.
The [container runtime checks](https://github.com/expbuild/expbuild/actions/runs/36662736536) at commit 69a520f
also passed. API checks cover migrations, bootstrap, and login against temporary PostgreSQL; Web checks cover HTTP pages and health endpoints;
WebDAV checks cover authenticated reads and writes in a temporary data directory; Operator checks cover only the executable entry point.
Full-cluster behavior, PVC permissions, persistence, and network access still require acceptance testing.

After building local test tags, run `python3 tools/container_smoke.py <component>` from the repository root,
where the component is admin-api, admin-web, operator, webdav, or gradle-cache. The script requires Docker; API checks pull
postgres:18 and create a temporary database container and network, which are automatically cleaned up on exit.

The opt-in experimental Turborepo artifact engine is built from `images/turborepo-cache/Dockerfile`. Configure its approved digest in `images.turborepo`; the CI build does not publish it. See [its protocol and validation limits](../docs/k8s-platform/turborepo-http.md).
