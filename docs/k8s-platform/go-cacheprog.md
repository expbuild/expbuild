# Experimental Go build cache via cacheprog

`go-cacheprog@0.1.0` is a separate, opt-in HTTP engine for **platacard/cacheprog v1.3.0**, pinned to commit `9264c952cadd9299405c477de68bd6d4b2b2de1a`. The connection recipe pins the existing CI toolchain, **Go 1.27.1**, and never installs software. Go supports stable `GOCACHEPROG` from 1.24; compiling this client release requires Go 1.25 or newer.

**Real-client acceptance is pending.** Protocol fixtures, stubbed recipes and platform tests do not certify cacheprog compatibility. This caches Go build outputs, not Go module downloads, dependency mirrors or remote execution. WebDAV and REAPI endpoints are not compatible with this wire protocol.

## Enable and configure

Build `images/go-cache/Dockerfile` and configure `images.goCache` with an administrator-approved immutable SHA256 image digest. The default is empty, so creation is disabled. The existing image workflow builds and smoke-tests with `push: false`; it does not publish an image. This engine follows the platform's durable image-binding rules.

```yaml
images:
  goCache: your-registry.example/expbuild/go-cache@sha256:YOUR_APPROVED_DIGEST
```

Create a `go-cacheprog` instance with positive `cacheGiB` strictly below `storageGiB`. Each instance has one process, a dedicated retained PVC and its own credential Secret. The root endpoint advertises `go-cacheprog`; Gateway exposure uses HTTPS only, without a gRPC route. Internal HTTP is for trusted cluster networks. Preserve TLS certificate validation.

The API and creation form default **`readOnly: true`**. The API maps this to `spec.access.readOnly`; the Operator passes `--read-only` and includes it in the rollout hash. An authenticated status probe verifies the applied policy and cache budget before readiness. API PATCH is a full configuration replacement: include the desired `readOnly` value. A direct Kubernetes spec that omits this optional boolean has the Go zero value, false; set it explicitly. The standalone binary defaults to read-only.

Uncheck **Server read-only (Go cache)** or send `readOnly: false` only for trusted writers. This policy applies to the entire instance, not individual tokens. `true` rejects every authenticated PUT with 403 while retaining authenticated GET access. Read-only still allows local access-time bookkeeping and startup eviction. Wait for the updated generation to become Ready before relying on a policy change. Before turning a previously shared read-only instance writable, rotate credentials and remove them from former readers. There are no separate reader/writer tokens in this release. Use separate instances for different trust domains; never give writable credentials to untrusted jobs.

## Use the connection recipe

On a Ready instance, the console exposes the pinned experimental profile. It requires an already installed `cacheprog` executable at an absolute path without spaces or shell metacharacters, and Go 1.27.1. It sets `GOTOOLCHAIN=local` to prevent automatic toolchain downloads, checks versions, prompts privately for the generated instance password, and scopes all settings to a subshell.

The recipe clears inherited `CACHEPROG_*` settings, selects `CACHEPROG_REMOTE_STORAGE_TYPE=http`, sets `CACHEPROG_HTTP_STORAGE_BASE_URL` to the instance origin, and passes the token using `CACHEPROG_HTTP_STORAGE_EXTRA_HEADERS="Authorization:Bearer TOKEN"`. It never puts credentials in a URL or generated file. It accepts the platform's generated base64url password alphabet to prevent extra-header injection. The service never redirects. Treat the process environment as sensitive on shared runners.

`GOCACHEPROG` invokes `cacheprog direct`. A private temporary root contains both `GOCACHE` and **`CACHEPROG_ROOT_DIRECTORY`**. The latter is the actual v1.3.0 source setting; an upstream README mentions a different name. The helper must return real local `DiskPath` files readable by the Go process; a remote hit does not remove this local filesystem requirement. The root survives until `go build ./...` exits and is then removed. Do not share it across unrelated jobs or delete it while Go is running; upstream provides no local garbage collection. A forced termination can leave temporary files for runner cleanup.

Uploads default off via `CACHEPROG_DISABLE_PUT=true`. To seed a **writable, trusted** instance, explicitly set `EXPBUILD_GO_WRITE=true` and `CI=true` before running the recipe. This changes only client behavior. The upstream `--disable-put` flag suppresses an advertised helper capability; neither it nor an environment variable grants or revokes server authority. Cache misses on read-only instances are expected until a trusted writer has populated the same cache.

## Wire and storage contract

| Request | Behavior |
| --- | --- |
| GET `/cache/{actionID}` | 200 with complete bytes and metadata, or 404 miss |
| PUT `/cache/{actionID}` | Exactly 200 after publication; complete atomic replacement of existing mapping |
| Authenticated PUT to read-only instance | 403 without staging or modifying the artifact |
| GET `/status` | Health Basic credentials only; namespace, budget, entries, applied read-only policy |

ActionID and OutputID are canonical lowercase 32-byte hex Go identifiers. OutputID is an opaque identifier, not a checksum of the compressed payload. PUT requires exactly one each of `X-Cacheprog-OutputID`, `X-Cacheprog-MD5Sum`, `X-Cacheprog-Sha256Sum`, `X-Cacheprog-CompressionAlgorithm` and `X-Cacheprog-UncompressedSize`. Empty compression means raw bytes and requires the declared size to equal the body length; `zstd` means opaque compressed bytes. GET preserves OutputID, compression and uncompressed size, with a known Content-Length and valid HTTP-date Last-Modified. Do not set Content-Encoding to zstd.

MD5 and SHA256 headers hash the **wire bytes**. Both are checked before publication; MD5 is protocol compatibility, not a security primitive. A single file stores a fixed 4 KiB metadata envelope followed by bytes. Atomic rename replaces metadata and body together. Failed or incomplete uploads leave the previous mapping readable. GET and restart verify persisted SHA256 and envelope metadata; corruption fails closed. Filesystem names derive from action IDs, never caller paths. Encoded paths and queries are rejected, and credentials cannot select another instance's namespace.

Both wire length and declared uncompressed size are bounded by the smaller of 256 MiB, the cache budget minus envelope overhead, and available PVC staging headroom. Unknown Content-Length returns 411, oversized objects 413, invalid metadata/checksums 400, and unavailable storage or full admission 503. The budget includes metadata; one staged upload additionally consumes at most one entry plus envelope. LRU eviction and a 10,000-entry cap bound retained data and in-memory indexing. There is no TTL or archive extraction. One upload stages at a time, at most 16 upload requests are admitted, and 64 total handlers can be active. The binary sets finite header, read and write deadlines.

GET holds the storage lock while copying to preserve exact accounting for open files; this deliberately serializes reads and commits and limits throughput. Benchmark before production use. Opaque zstd storage avoids an additional decompression dependency but cannot verify declared decompressed size or detect compressed bombs. Only trusted writers may supply cached results. Digests detect transport/storage corruption, not malicious or incorrect build outputs. Cacheprog can treat errors as build failures; no automatic fallback guarantee is made.

## Validation and remaining acceptance

The added tests cover raw, empty and opaque-compressed metadata roundtrips, replacement and failed replacement, credentials and rotation, read-only enforcement, malformed and duplicate headers, body/checksum limits, namespaces, corruption, recovery, eviction, concurrency and bounded admission. Platform checks cover rendering and rollout, applied-policy probing, CRD admission, approved images, API credential lifecycle, connection recipes and browser flow. Container smoke uses Python's standard library against our own built image. No workflow downloads or executes cacheprog.

A separately authorized real-client run should use the pinned release, the existing Go toolchain and a standard-library-only fixture. Minimum Linux AMD64 asset:

- `cacheprog_v1.3.0_linux_amd64.tar.gz`
- Release API SHA256: `b5942a1b65a97535dfd980d8c53fd54097505f036bc3210daaec58fe170ecf3a`

Acceptance must demonstrate a cold build, warm build with a fresh local root, source invalidation, artifact equivalence, raw/empty/zstd objects, local DiskPath lifetime, authenticated read-only hits and rejected writes, cross-instance rejection, and trusted/untrusted TLS behavior. Do not claim measured performance or real-client compatibility until those runs complete.

## Pinned evidence and licensing

The adapter independently implements the wire contract; it does not vendor or import cacheprog. Upstream is Apache-2.0, with no NOTICE in this release. Preserve upstream licensing if distributing its binary separately.

- [Release v1.3.0](https://github.com/platacard/cacheprog/releases/tag/v1.3.0)
- [Pinned HTTP contract](https://github.com/platacard/cacheprog/blob/9264c952cadd9299405c477de68bd6d4b2b2de1a/internal/infra/storage/http_contract.go)
- [Pinned CLI settings](https://github.com/platacard/cacheprog/blob/9264c952cadd9299405c477de68bd6d4b2b2de1a/internal/app/app_cacheprog.go)
- [Pinned module requirements](https://github.com/platacard/cacheprog/blob/9264c952cadd9299405c477de68bd6d4b2b2de1a/go.mod)
- [Pinned license](https://github.com/platacard/cacheprog/blob/9264c952cadd9299405c477de68bd6d4b2b2de1a/LICENSE)
