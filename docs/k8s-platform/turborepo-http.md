# Experimental Turborepo HTTP cache

`turborepo-http@0.1.0` is a separate, opt-in artifact engine, with a configuration profile pinned to **Turborepo 2.11.7**. HTTP protocol fixtures, deployment rendering and control-plane tests cover this implementation; real Turborepo cache acceptance has not run. Do not classify it as certified client support.

It implements the artifact protocol directly. WebDAV, Gradle HTTP and bazel-remote endpoints are not interchangeable with this endpoint. Artifacts remain opaque binary archives; the task key is not required to be a digest of the archive.

## Enable and connect

Build `images/turborepo-cache/Dockerfile` from this source and supply your administrator-approved digest in `images.turborepo`. The value defaults to empty, which keeps new Turborepo instance creation disabled. The existing image workflow builds and tests images with `push: false`; it does not publish them. Digest approval and durable image binding follow the same rules as other engines.

```yaml
images:
  turborepo: your-registry.example/expbuild/turborepo-cache@sha256:YOUR_APPROVED_DIGEST
```

Create an experimental Turborepo HTTP instance through the console or API after enabling the image. Choose a positive `cacheGiB` below `storageGiB`. The Operator creates one process, a separate retained PVC and a root HTTP endpoint. Gateway exposure uses the existing HTTPS route; it does not create a gRPC route.

Save the one-time **instance password** and use it as `TURBO_TOKEN`. This is an instance-specific Bearer credential, not a Vercel account token. Rotation uses the normal instance credential workflow. The database retains encrypted pending operation credentials only until reconciliation; the mounted Secret contains the bcrypt client password hash and separate probe credentials. Tokens are never embedded into generated recipes or saved to browser storage.

The connection panel generates a scoped Bash example only when the current instance generation is Ready. It requires an already-installed `turbo` executable reporting version `2.11.7`; the example does not install it. It sets:

- `TURBO_API` to the instance root URL **without a trailing slash or `/v8` suffix**.
- `TURBO_TEAMID` to `team_<instance UUID>` and `TURBO_TEAM` to an empty string to override a saved team slug.
- `TURBO_TOKEN` from an interactive password prompt inside a subshell.
- Client cache mode `local:rw,remote:r`, or `local:rw,remote:rw` when `CI=true`.

The instance token grants both reads and writes. A client-only read flag is not a server-enforced read-only credential. This release has no separate read-only token role. The health identity can query operational status but cannot access artifact routes. The server requires a single exact `teamId` query on client routes and rejects a wrong team, duplicate scope or an additional slug; the token alone does not select arbitrary teams. Instances retain separate credentials and PVCs. Do not expose plain HTTP outside a trusted network; Gateway clients must trust the HTTPS certificate.

## Wire contract

The current online OpenAPI lists paths without a version prefix, while the pinned 2.11.7 client constructs `/v8/artifacts/...`. This implementation follows the pinned client:

| Route | Behavior |
| --- | --- |
| `GET /v8/artifacts/status` | Authenticated cache availability, `status: enabled` |
| `PUT /v8/artifacts/{key}` | Bounded raw archive upload, required Content-Length and unsigned integer `x-artifact-duration` |
| `GET /v8/artifacts/{key}` | Original bytes, original length and retained duration/tag/source metadata |
| `HEAD /v8/artifacts/{key}` | Artifact length and metadata without a body |
| `POST /v8/artifacts` | Bounded batch metadata lookup, including null misses |
| `POST /v8/artifacts/events` | Bounded event ingestion acknowledged and discarded; no analytics/history claim |
| `OPTIONS` on those routes | Authenticated method/header discovery; not a browser cross-origin authentication API |
| `GET /status` | Basic health identity only; checks configured team and logical budget |

Client routes require `Authorization: Bearer <instance password>` and `?teamId=team_<instance UUID>`. Artifact identifiers are case-sensitive, 1–256 ASCII letters, digits, hyphens, underscores or dots, excluding `.` and `..`; protocol routes `status` and `events` are reserved. They are safely mapped to storage filenames, never interpreted as user-supplied filesystem paths.

Responses preserve `x-artifact-duration`, `x-artifact-tag`, `x-artifact-sha` and `x-artifact-dirty-hash`. Metadata headers are single-valued and bounded. A miss is 404, invalid credentials 401, wrong scope 403, malformed metadata/short upload 400, a missing length 411, an oversized archive 413, and an immutable conflicting upload 409. Storage/corruption errors fail closed with 503 rather than returning a successful incorrect hit.

## Atomicity, capacity and integrity

A single envelope stores metadata and archive together. Each completed upload is fsynced before atomic publication, then the containing directory is synced. Interrupted or length-mismatched uploads remain invisible and their temporary files are removed. A duplicate upload with the same bytes and signature tag returns 200 and retains the first writer's duration/source metadata. Different bytes or a different tag for an existing key return 409. Concurrent writers cannot splice one artifact's metadata into another's body.

The engine keeps a single-process LRU index and reconstructs it on restart. `cacheGiB` bounds logical retained envelope bytes, including 4096 bytes of envelope overhead per entry. One staged upload is allowed at a time. The rendered maximum body size is at most 256 MiB and is further reduced to fit the logical budget and reserved PVC upload headroom. This is not a hard filesystem quota: allocation blocks, inodes and directory metadata consume additional space. A full filesystem rejects an upload without publishing partial content.

A private SHA256 envelope checksum detects stored-byte corruption. It does not validate a client's build semantics or authenticate an uploader. Startup refuses corrupt, nonregular or unexpected files and requires operator diagnosis/repair; it does not silently delete damaged retained artifacts. Reads, including HEAD/batch validation, currently checksum files and serialize access while copying downloads, bounded by the server timeout. This conservative implementation is not a throughput or scale claim.

Turborepo's optional artifact signature is a separate client-side HMAC integrity mechanism. Enable `remoteCache.signature` in the project configuration and provide a separate `TURBO_REMOTE_CACHE_SIGNATURE_KEY` to trusted clients (at least 32 random bytes). The server round-trips `x-artifact-tag` without rewriting the archive or learning the signature secret. A valid tag does not replace Bearer authentication or team authorization. Changing the signature key requires a fresh cache instance or deliberately cleared cache; an existing immutable key cannot be silently retagged.

## Validation and remaining gate

Existing workflows exercise Go HTTP fixtures, restart/concurrency/corruption cases, template/CRD/Gateway rendering, protected credential creation, UI/Bash configuration, browser behavior and the built image through Python HTTP requests. These checks do not execute Turborepo itself. There is no advertised engine statistics/history/metrics integration in this initial template.

Before claiming real client compatibility, run a pinned Turbo 2.11.7 fixture in an isolated runner: a cold remote write, a repeat with empty local cache and removed outputs using `--cache=remote:r`, output comparison with an uncached baseline, source/flag/dependency changes, wrong token/team checks, signature verification and tag tampering, plus failure/partial upload cases. Record client version, server commit, Node version and fixture revision. Deployment-path and TLS acceptance remain separate from protocol mocks.

The smallest additional executable dependency is the official Linux x86_64 musl Turbo 2.11.7 archive. A dependency-free two-workspace fixture can reuse the existing runner's Node and Go, without npm packages, a new container runtime or production credentials. Download/execution approval is pending; no workflow in this change downloads or runs that client.

## Pinned upstream evidence

- [Turborepo 2.11.7 release](https://github.com/vercel/turborepo/releases/tag/v2.11.7)
- [Versioned HTTP client and artifact routes](https://github.com/vercel/turborepo/blob/v2.11.7/crates/turborepo-api-client/src/lib.rs)
- [Environment configuration](https://github.com/vercel/turborepo/blob/v2.11.7/crates/turborepo-config/src/env.rs)
- [Signature authentication](https://github.com/vercel/turborepo/blob/v2.11.7/crates/turborepo-cache/src/signature_authentication.rs)
