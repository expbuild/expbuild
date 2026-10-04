# Experimental client configurations

The management API and connection panel provide **experimental configuration recipes**, not certified support, for sccache 0.18.0, Pants 2.33.1, Maven Build Cache Extension 1.3.0 and moonrepo 2.5.6. Real-client cache acceptance is still pending. Existing Bazel, Gradle and WebDAV examples remain available.

| Client | Existing template | Transport | Configuration status |
| --- | --- | --- | --- |
| sccache 0.18.0, compiled with WebDAV | `webdav-apache@0.1.0` or `@0.2.0` | HTTP(S) WebDAV, Basic authentication | Experimental; unvalidated with real compiler workloads |
| Pants 2.33.1 | `bazel-remote@0.1.0` | REAPI over `grpc://` or `grpcs://`, Basic authorization metadata | Experimental; unvalidated with real Pants workloads |
| Maven Build Cache Extension 1.3.0 / Maven 3.9.16 | `webdav-apache@0.1.0` or `@0.2.0` | Native Resolver HTTP/WebDAV, Basic | Experimental; real extension acceptance pending |
| moonrepo 2.5.6 | `bazel-remote@0.1.0` | REAPI over gRPC(S), Basic authorization metadata | Experimental; dedicated JSON workspace, real-client acceptance pending |

No new storage engine or custom client fork is required for these recipes. The API returns `clientProfiles` separately from engine `capabilities`, on both template catalog entries and instance details. Each profile has `id`, `protocol`, pinned `version` and `status: experimental`. Unknown template versions expose no profiles. The UI offers matching recipes only after the current generation is Ready, using validated root endpoints. This metadata does not change the CacheInstance spec, storage layout or approved image binding.

## Credentials, isolation and TLS

Use a dedicated instance for each acceptance workload. Current instance credentials can read and write. The sccache/Pants samples default to client-side reads and enable writes only for `CI=true`; the moonrepo recipe additionally requires explicit `EXPBUILD_MOON_WRITE=true`; the Maven example always disables remote uploads; a user holding those credentials can change that setting. This is not a server-enforced read-only role. Adding a true read-only role requires separate credentials and engine authorization, with write-denial tests, before advertising it.

The existing instance, credentials and PVC are the isolation boundary. WebDAV prefixes, moon `instanceName`, Pants `remote_instance_name`, and `process_execution_cache_namespace` are not tenant security boundaries. bazel-remote does not isolate CAS by instance name; action-key instance mangling is not currently enabled. Do not share an instance between untrusted tenants or claim cross-tool cache reuse.

Gateway clients must resolve their instance domain and trust the gateway certificate. Internal plain HTTP/gRPC endpoints require a trusted network path. Recipes never disable certificate verification. Do not put credentials into repository files, URLs or shell history; the examples prompt for them and limit their environment to a subshell. Avoid shell tracing and verify that other inherited backend/authentication settings are absent in the dedicated test environment.

## sccache

Select the sccache configuration under a WebDAV instance's connection instructions. It uses `SCCACHE_WEBDAV_ENDPOINT`, `SCCACHE_WEBDAV_KEY_PREFIX`, and the Basic username/password pair. The pinned release does not expose the later `SCCACHE_WEBDAV_DISABLE_CREATE_DIR` option. Keep Apache DAV directory operations available.

The example starts a dedicated local sccache daemon on port 4227, fails if it cannot start, and stops that daemon after the build. Choose an unused port if necessary. Do not reuse a previously running daemon: it may retain another backend or credentials. Use a clean environment without an existing storage configuration. The Rust example uses `RUSTC_WRAPPER=sccache` and `CARGO_INCREMENTAL=0`; it does not promise every compilation is cacheable.

Apache must retain opaque cache keys, nested directories and archive bytes. Do not redirect this profile to the bazel-remote CAS: compiler keys need not be hashes of the archive contents. Readiness PROPFIND alone is not sccache compatibility evidence. Acceptance must include directory creation, the client's `.sccache_check` access, upload/download and compiler statistics.

Versioned sources: [sccache WebDAV configuration](https://github.com/mozilla/sccache/blob/v0.18.0/docs/Webdav.md), [backend implementation](https://github.com/mozilla/sccache/blob/v0.18.0/src/cache/webdav.rs), [release](https://github.com/mozilla/sccache/releases/tag/v0.18.0).

## Pants

Pin `pants_version = "2.33.1"` in the test project's `pants.toml` and use the official Pants launcher. Its bootstrap interpreter is distinct from the workload interpreter. A Python fixture may constrain its workload to Python 3.12, but an existing Python 3.12 executable alone does not establish a working Pants installation.

The recipe selects REAPI explicitly, configures Basic `authorization` via `PANTS_REMOTE_STORE_HEADERS`, disables remote execution, and executes `test ::` and `package ::`. Use `grpcs://` for TLS; the Bazel HTTP endpoint is not appropriate. The example disables pantsd so an existing daemon cannot silently retain the connection environment. Check project configuration for conflicting auth plugins, Bearer tokens or remote execution settings before use.

Keep bazel-remote's default ActionCache dependency validation enabled. The official compatibility list includes bazel-remote, but this project's pinned client/engine combination still needs acceptance. If an ActionCache request fails, collect the status and referenced CAS/tree evidence before proposing a server configuration change.

Sources: [Pants 2.33.1 release](https://github.com/pantsbuild/pants/releases/tag/release_2.33.1), [remote cache setup](https://www.pantsbuild.org/stable/docs/using-pants/remote-caching-and-execution/remote-caching), [server compatibility](https://www.pantsbuild.org/stable/docs/using-pants/remote-caching-and-execution#server-compatibility), [global option reference](https://www.pantsbuild.org/stable/reference/global-options).

## moonrepo

See the [moonrepo 2.5.6 recipe](moonrepo.md) for the required JSON workspace, Basic header substitution, TLS behavior and explicit write opt-in. It reuses REAPI without remote execution, retains CAS dependency checks and defaults to global read mode even in CI. No new client is downloaded or executed by the configuration tests.

## Acceptance gate

Configuration tests run with `npm run test:client-profiles` on Node 24, with stub clients and real Bash argument/environment handling. API, schema and React tests remain part of the management workflow. These tests do not count as real-client cache acceptance.

The real-client gate must record exact client, engine, compiler/interpreter, fixture revision and dependency versions. An isolated GitHub Actions runner can build the existing Apache image without publishing it, run bazel-remote 2.6.2, and use temporary credentials and localhost endpoints; it does not require installing a container runtime on a developer Mac or obtaining a production instance.

Required evidence before changing the profile status:

1. Cold build uploads remotely; a second build with an empty local cache/store and fresh output directory reads remotely and records hits. Disable local process-result reuse as appropriate, rather than measuring a local-cache hit.
2. Artifacts and test results match an uncached baseline. Use a representative Rust project such as ripgrep and a pinned Pants example-python project, in addition to small deterministic fixtures.
3. Source, dependency, compiler/interpreter and relevant flag changes invalidate affected cache entries.
4. Wrong credentials and credentials from another isolated instance cannot access entries; unauthenticated reads are denied. Client-only read mode produces no cache writes, but is not an authorization test.
5. Corrupted and interrupted uploads never become successful incorrect hits. Record errors/fallback behavior rather than assuming that HTTP success proves archive integrity.
6. Exercise TLS with a trusted test CA, plus rejection of an untrusted certificate, and both supported endpoint exposure paths as separate integration coverage.

No new client downloader or real-client workflow is enabled by this configuration change. Downloading/executing the pinned clients, launcher bootstrap and fixture dependencies remains a separate acceptance step. Full platform Kubernetes lifecycle tests are not required merely to test configuration rendering.

## Turborepo artifact engine

[Turborepo 2.11.7](turborepo-http.md) now has a separate experimental engine and configuration profile. It does not reuse the WebDAV or REAPI wire protocol. Real-client acceptance remains pending.

## Nx artifact engine

[Nx 22.7.12](nx-http.md) now has a separate experimental engine and configuration profile. It does not reuse the WebDAV or REAPI wire protocol. Real-client acceptance remains pending.

## Maven Build Cache Extension

See the [Maven profile](maven-build-cache.md) for prerequisites, nested WebDAV layout, strict test-parameter reconciliation and the pending acceptance gate. Its upload flag remains false even in CI. This caches build outputs, not dependency downloads.
