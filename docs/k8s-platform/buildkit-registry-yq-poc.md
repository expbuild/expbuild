# BuildKit registry cache with a pinned yq workload

This isolated prototype exercises a writable CNCF Distribution Registry with
BuildKit's real registry cache exporter/importer. It does not add an expbuild
engine, CRD, template, SDK or production deployment. Cache and final image
references are separate: `registry:5000/yq-cache:baseline` and
`registry:5000/yq-output:<case>`.

## Fixed inputs and preparation

[yq v4.54.1](https://github.com/mikefarah/yq/tree/504fc38780cc46be8444ea1b72fb55919fc0bfb0)
is fixed to `504fc38780cc46be8444ea1b72fb55919fc0bfb0`.
[yq-pins.json](../../tools/benchmarks/yq-pins.json) pins Buildx 0.37.2,
BuildKit 0.33.1, Distribution 3.1.2, and the original upstream Go/Alpine image
digests. BuildKit and Registry use the official linux/arm64 child manifests;
Go and Alpine retain the upstream multi-platform index digest and select arm64.
The Go tag had moved when checked; its newer tag digest is deliberately unused.

The Buildx Darwin asset is checked against the SHA256 published in the official
[GitHub release asset metadata](https://github.com/docker/buildx/releases/tag/v0.37.2).
That release's `checksums.txt` omits Darwin assets. Linux arm64 has an entry in
the checksum file. The runner verifies the pinned binary hash before execution.
Source is extracted with `git archive`; `.git`, local reports and build outputs
are excluded. Preserve the upstream MIT license in extracted sources.
Top-level licenses were checked at the pinned revisions:
[Buildx](https://github.com/docker/buildx/blob/v0.37.2/LICENSE),
[BuildKit](https://github.com/moby/buildkit/blob/v0.33.1/LICENSE) and
[Distribution](https://github.com/distribution/distribution/blob/v3.1.2/LICENSE)
use Apache-2.0; [Go](https://github.com/golang/go/blob/go1.27.1/LICENSE) uses its
BSD license. Image packages and dependencies retain their own licenses. Upstream
source trees, tools and image binaries are not vendored or published by this change.

The experimental Dockerfile adaptation changes only its two `FROM` lines. The
Go base is extended in a separate preparation build with `go mod download all`
and `go mod verify`, then an empty, explicitly named compiler cache. It contains
no yq source build outputs. All measured builds use that same seed image digest,
`GOTOOLCHAIN=local`, `GOMAXPROCS=2`, `GOFLAGS=-p=2`, offline Go modules and
`--network=none`. The original `go build` and `scripts/acceptance.sh` instructions
remain intact. The other `FROM` change selects the image transport while keeping
the original Alpine digest.
The network restriction applies to Dockerfile `RUN` steps; BuildKit still imports
and exports Registry data through its own connection.

Each case gets a newly named builder and previously absent state volume.
Before timing, a separate Dockerfile downloads/unpacks the same dependency base
and Alpine layers and checks that the Go compiler cache is absent. It does not
copy yq or compile/test it. Builder state is removed after every case, without
`--keep-state`. Host filesystem/page caches are not flushed.

## Run and inspect

Requirements: Python 3.12+, Git, a native arm64 Docker daemon exposed by an
explicit local Unix socket, and a dedicated anonymous Docker CLI configuration
whose single `cliPluginsExtraDirs` directory contains the verified `docker-buildx`.
Do not use a configuration containing registry credentials or credential helpers.
No global Docker context/plugin settings are changed.

Download the official pinned images first. Docker Hub direct downloads failed
with connection resets/EOF on the test host; the same digest-pinned images were
successfully obtained from Google's [public Docker Hub cache](https://docs.cloud.google.com/artifact-registry/docs/pull-cached-dockerhub-images).
`--image-prefix mirror.gcr.io` records this transport choice without changing
the daemon's global registry configuration. Use `docker.io` when it is reachable.

```sh
python3 tools/benchmarks/run_yq.py \
  --source "$PINNED_YQ_CHECKOUT" \
  --work-dir "$NEW_TASK_EVIDENCE_DIRECTORY" \
  --docker-config "$TASK_ANONYMOUS_DOCKER_CONFIG" \
  --docker-host "$LOCAL_DOCKER_UNIX_SOCKET" \
  --image-prefix mirror.gcr.io
```

The runner uses one standard `docker-container` BuildKit builder at a time.
This driver starts a **privileged container inside the existing Docker VM**;
use only with authorization for that local test environment. It does not mount
the host Docker socket or host filesystem into the builder. The builder limit
is 2 CPU / 2 GiB with no extra swap; Registry is limited to 0.5 CPU / 256 MiB.
Registry's published port binds only `127.0.0.1`, on a task-specific network.
Its anonymous HTTP configuration is for this disposable local experiment only.

The six cases are:

| Case | Remote cache | Required behavior |
|---|---|---|
| disabled | none; `--no-cache` | Compile and acceptance execute |
| remote-cold | missing import, `mode=max` export | Compile and acceptance execute; publish cache |
| remote-warm | import baseline | Both named steps are `CACHED` in a fresh builder |
| mutated-disabled | none; `--no-cache` | Compile the fixed version-marker source edit |
| mutated-import | import original baseline | Both named steps execute; match changed disabled output |
| after-gc | deleted baseline import | Cache miss falls back to compilation and matches original output |

Every exported OCI blob is checked against its descriptor's SHA256 and size.
The comparator applies image layers/whiteouts and checks the complete root
filesystem's file contents, types, permissions, ownership and links. It separately
records image manifests/configs; file mtimes, image timestamps and history are
not treated as semantic artifact differences. The extracted yq binary must be
byte-identical between corresponding cases. The fixed mutation changes
`cmd/version.go`'s prerelease marker and must change the binary and version output.

After **every** measured build, a separate no-network container executes the
extracted binary against all 17 upstream acceptance scripts (175 tests), plus
explicit version, JSON/arithmetic/array, multi-document and raw NUL-byte checks. These tests
run outside cached build layers, including for the remote-warm case. The oracle
has a read-only root filesystem and uses its task work directory for shunit2's
executable temporary scripts; `/tmp` retains its default execution restriction.
The pinned Go image lacks `hd`: upstream `testBasicUsageRaw` otherwise compares
two empty command substitutions and reports a false pass. The independent oracle
exports an `hd` function backed by `od -An -v -tx1`, verifies the raw bytes
`foo\0bar\0` separately, and rejects any `command not found` in acceptance output.
The cached upstream acceptance layer remains unmodified; it is not the final
correctness gate. This adaptation only affects independent verification.

`build.log`, per-builder isolation records, OCI archives, `artifact.json`, oracle
logs, cache manifest, Registry logs and `state.json` are written outside the
repository. Raw evidence may contain local paths; review before publishing.
Timings cover the Buildx command (build, output push and OCI export, plus cache
export for the producer). Remote cache manifest/blob imports inside that command
are included. Initial official image/tool downloads, dependency preparation,
builder creation, base-image download/unpack warmup, OCI artifact verification,
the independent oracle and cleanup are excluded from that column. No `docker
load` or final-image deployment is performed. `timings.json` records builder
setup/cleanup, base warmup, artifact verification, independent oracle and total
case wall time separately; `state.json` records one-time setup duration. A fast
cached Buildx command is not an end-to-end CI duration or a general speedup claim.

## Cache deletion and boundaries

Only the task cache manifest is deleted through the Registry API. All builders
are stopped/removed, the Registry is stopped, and its official
`registry garbage-collect` command runs against the task data volume. The server
then restarts; the cache reference must return 404 while the dependency seed
and final image references remain readable. The fresh `after-gc` builder rebuilds
without that cache. [Distribution's offline mark/sweep GC](https://distribution.github.io/distribution/about/garbage-collection/)
is not LRU eviction, an online capacity policy or a tenant quota.

`cache-reference-delete.json` records the accepted manifest DELETE (202), the
missing tag (404), and the cache configuration blob still present on disk before
GC. `gc-result.json` separately records that blob's physical removal, storage
usage before/after GC, and successful digest/size verification of every retained
final-image blob. Registry restart refreshes the actual loopback port mapping:
Docker can reassign an automatically allocated published port after stop/start.
The isolated probe observed both old and new bindings successfully serving 200;
keeping the old URL caused earlier incomplete runs. Those runs are not full
GC/fallback qualification results.

The runner cleans up its exact labelled Registry, network and volume and its
recorded builders/ephemeral containers. It never prunes shared Docker resources.
Official downloaded image layers, verified tools and local evidence remain.
After a host crash/SIGKILL, inspect `state.json` and use the same arguments with
`--phase cleanup`; never remove unrelated resources. `--phase setup` and
`--phase cases` allow controlled preparation/measurement, but do not reuse a
failed run directory as a clean experiment.

No authentication, multi-tenant isolation, cross-host transfer, cross-platform
cache, corrupt-result recovery, concurrent upload/GC safety, capacity/soak or
production availability claim follows from this prototype. The full yq Go unit
suite is not run; the upstream Dockerfile itself runs acceptance only.

CI executes the lightweight evidence contracts and entry-point checks, not this
privileged Docker workload. Full measurements need the explicitly prepared local
environment above.

## Verified local results, 2026-10-02

[Machine-readable results and evidence hashes](buildkit-registry-yq-results.json)
record the completed `run-04` build/GC sequence and the subsequent corrected
independent oracle on each exact exported binary. The latter was rerun because
the first oracle had the upstream `hd` blind spot described above. The following
columns are separate observations in seconds, not one end-to-end speedup ratio:

| Case | Buildx command | Base warmup | Initial whole case | Corrected oracle followup |
|---|---:|---:|---:|---:|
| disabled | 17.265 | 8.578 | 43.773 | 16.025 |
| remote-cold | 20.660 | 7.798 | 46.323 | 16.096 |
| remote-warm | 0.384 | 7.792 | 28.334 | 16.397 |
| mutated-disabled | 18.036 | 7.772 | 46.573 | 16.140 |
| mutated-import | 21.092 | 8.926 | 55.349 | 16.226 |
| after-gc | 23.501 | 11.742 | 60.807 | 16.174 |

The initial whole-case column includes the original oracle and builder lifecycle;
the corrected oracle followup is **additional** and is not included in that
column. One-time setup took 54.720 seconds, excluding prior official tool/image
downloads. In particular, 0.384 seconds is only the cached Buildx command, which
includes its cache import and output transfers; it excludes the separately shown
base warmup and independent testing. Earlier 0.328-second observations belonged
to an incomplete GC run. No stable speedup, p95 or cross-host claim is made.

All six corrected oracles passed 175 upstream tests and four semantic checks.
All four unmodified-source cases have the same binary SHA256
`4c2992984c637b1ae09dc3222665c38cee91a36f7c21114484533a78647afbb8` and matching
520-entry root filesystems. The changed-source pair matches each other and has
binary SHA256 `38ede9fc0baea72fabe7661358421f7fd11ef0648b8dcb5e37d93db6e43709dd`.
Runtime image configuration also matches across all cases. Image manifests and
layer diff IDs differ where timestamps/history differ, so complete OCI archive
byte identity is not asserted. The 554-file inputs differ only at the intended
`cmd/version.go` mutation; all six base-warmup Dockerfiles are identical.

The cache manifest DELETE returned 202 and the tag returned 404 while its cache
configuration blob still existed on disk. Offline GC then removed that blob and
reduced allocated Registry storage from 414,576 to 367,836 KiB (46,740 KiB,
about 45.6 MiB). Every retained final-image blob passed its digest/size check.
The fresh post-GC builder reported the missing cache import, rebuilt successfully,
and produced the original binary/root filesystem. The missing-import message is
expected fallback behavior, not a failed build. Seven distinct builder/state
volumes were used including preparation; all were removed. Task Registry,
network, data volume and independent oracle containers were cleaned up.
