# bazel-remote engine validation record

Current candidate engine: [official bazel-remote v2.6.2](https://github.com/buchgr/bazel-remote/releases/tag/v2.6.2).
The official binary has been run on Linux amd64 after verification against its release digest, and real protocol tests have completed.
Native protocol tests and the isolated Kubernetes image validation below are recorded separately; neither implies production qualification.

## Reproduction entry point

```sh
python3 tools/download_bazel_remote.py /tmp/expbuild-bazel-remote
cd operator
BAZEL_REMOTE_BIN=/tmp/expbuild-bazel-remote go test ./internal/controller -run TestRealBazelRemoteContract -count=1 -v
```

The download tool pins the version and checks the official release asset SHA256; it does not automatically select latest.
Tests use the configuration rendered by the Operator, changing only the storage directory, credentials-file path, and listen addresses
to temporary directories and random local ports. The process stops when tests finish; no existing service or cluster is used.
The test explicitly skips if no binary is specified. This native-engine test has passed both locally and in [remote Kubernetes CI](https://github.com/expbuild/expbuild/actions/runs/36668365993); container and Gateway paths have separate acceptance checks.

## Behaviors verified

- Startup with the native configuration format; the configured 1 GiB cache budget matches authenticated probes.
- bcryptjs-generated htpasswd works for HTTP Basic and gRPC Basic authentication.
- Unauthenticated HTTP reads/writes and REAPI FindMissingBlobs are rejected.
- HTTP CAS uploads/downloads use SHA256 paths, and downloaded content matches the original data.
- FindMissingBlobs reports a digest before upload and no longer reports it missing afterward.
- After restart with a new credentials file, the old user is rejected and the new user can read previously stored data.

The FindMissingBlobs test uses the official [REAPI protobuf field definitions](https://github.com/bazelbuild/remote-apis/blob/main/build/bazel/remote/execution/v2/remote_execution.proto)
to construct wire messages directly. This verifies the RPC's real behavior, not complete Bazel-client acceptance.

## Kubernetes and TLS paths verified

[Real kind/Helm/Gateway CI](https://github.com/expbuild/expbuild/actions/runs/36669207282) passed with the pinned image
`buchgr/bazel-remote-cache:v2.6.2@sha256:8109f1f39eb17d898cf51e08b41e4eabaaaeb1f584c2f22c1be45b7568fcc512`.

- Instance creation through the management API; the Operator starts a StatefulSet with non-root UID/GID/fsGroup 1000, a read-only root filesystem, a real PVC, and separate temporary volumes.
- GetCapabilities, FindMissingBlobs, chunked 8 MiB ByteStream upload/download, and HTTPS CAS upload/download under trusted TLS/SNI.
- Anonymous access is rejected; after credential rotation through the management API and a rolling update, the old password is rejected and the new password reads existing data over gRPC/HTTP.
- HTTPRoute and GRPCRoute are cleaned up after instance deletion.

This validation uses Linux amd64, kind's default storage, and a pinned Envoy Gateway; it does not cover all architectures, production CSI, or real Bazel build clients.

## Outstanding work

- Multiple architectures, production PVC permissions, full disks, failure recovery, and single-writer boundaries.
- Real Bazel builds, compression, and FindMissing batch workloads through a TLS Gateway.
- Eviction-policy boundaries, storage-capacity changes, and consistency between metrics and platform statistics.
- Public DNS, multi-node network isolation, concurrent client behavior during rotation, and performance baselines.

Passing RPC tests is not extrapolated into a claim of complete performance or production availability.

## Native LRU budget measurements

With the same rendered configuration, default compressed storage, and a 1 GiB budget, the real v2.6.2 engine passed this test: upload two incompressible 400 MiB CAS blobs, A and B, in sequence; read A fully to update access order; then upload C of the same size. B subsequently returns 404, while A and C can be read fully with matching SHA256 hashes. Actual cache capacity stays within budget, with a final entry count of 2.

Data is generated with a reproducible AES-CTR stream; the client streams uploads, downloads, and verification without keeping complete large files in memory. The test uses a temporary directory and needs at least approximately 2 GiB of free disk space; it does not touch existing caches. Example:

```sh
BAZEL_REMOTE_BIN=/tmp/expbuild-bazel-remote BAZEL_LRU_TEST=1 go test ./internal/controller -run '^TestRealBazelRemoteContract$' -count=1 -v
```

Run from the operator directory. If the default temporary directory has limited disk space, point TMPDIR to a separate test directory. This check is included in CI and passed locally; it verifies native LRU for this budget and access sequence, not full-disk behavior, concurrent uploads, ordering after restart, or throughput benchmarks.

## Real Bazel build client

Local tests passed with the SHA256-pinned Bazel 8.8.1 Linux amd64 client, connecting to the actual engine above over HTTP and REAPI gRPC separately. The first build uploads ActionCache/CAS; the second uses a fresh output_base, correctly restores outputs, and does not re-execute the action. A third build uses another fresh directory with remote caching disabled and must trigger the action's exit code 42, ruling out local-cache effects or a false-positive test rule.

The rule's undeclared guard/marker is an intentional test probe: removing the guard after the first build makes repeated execution fail. It is not an example production build rule. Credentials are written to a temporary configuration with mode 0600, not passed as process arguments.

```sh
python3 tools/download_bazel_client.py /tmp/expbuild-bazel
# Run from the operator directory after downloading the engine as described above.
BAZEL_BIN=/tmp/expbuild-bazel BAZEL_REMOTE_BIN=/tmp/expbuild-bazel-remote go test ./internal/controller -run '^TestRealBazelRemoteContract$' -count=1 -v
```

Allow approximately 2 GiB of disk space for the temporary directory. This test uses loopback HTTP/gRPC and does not yet establish real Bazel operation through a TLS Gateway, compatibility across versions, compression negotiation, or remote execution. It is included in CI; remote results for the newly added client portion remain to be confirmed.
