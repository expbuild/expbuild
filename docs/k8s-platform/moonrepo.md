# moonrepo remote cache (experimental)

The `moonrepo` profile pins **moon 2.5.6** and reuses `bazel-remote@0.1.0` through REAPI ActionCache, CAS and ByteStream. It adds a configuration recipe, not another engine or remote execution. Real moon cache acceptance is pending. Existing sccache and Pants profiles remain available.

Use a dedicated instance and a disposable, reviewed workspace. This deliberately narrow recipe accepts only `.moon/workspace.json`; it is not a drop-in migration for an existing YAML workspace. It reads configuration without modifying it, rejects alternate workspace formats, `.config/moon`, symlinked configuration and `extends`, and checks the exact remote settings before prompting for credentials. Install nothing as part of copying the recipe. Run it only after the pinned client and fixture dependencies have been approved and provisioned.

## Workspace preparation

Create `.moon/workspace.json` in the dedicated acceptance workspace with the following configuration. Keep existing production workspace files untouched. The project `app` and its `app:build` task must already exist and be reviewed; this configuration alone does not create them.

```json
{
  "versionConstraint": "=2.5.6",
  "projects": { "app": "app" },
  "daemon": false,
  "telemetry": false,
  "pipeline": {
    "installDependencies": false,
    "syncProjects": false,
    "syncWorkspace": false
  },
  "remote": {
    "api": "grpc",
    "auth": {
      "headers": { "authorization": "${EXPBUILD_MOON_AUTHORIZATION}" }
    },
    "cache": {
      "compression": "none",
      "instanceName": "moon-outputs",
      "localReadOnly": true,
      "verifyIntegrity": true
    }
  }
}
```

The project task must use only already provisioned system commands, with declared inputs and outputs. Do not add toolchain plugins, proto installers, package-manager installs, env-file loading or commands that print environment variables. Disabling pipeline install/sync does not certify that arbitrary task or plugin code cannot download tools. Review that code before execution. The launcher runs `app:build`; changes to fixture inputs, outputs, dependencies or task options need corresponding cache-invalidation checks.

Open a Ready bazel-remote instance in the console and select **moonrepo 2.5.6 — experimental**. Run its Bash recipe from the workspace root. It requires Python 3 for a JSON preflight and an already installed `moon` whose `--version` is exactly `moon 2.5.6`. The recipe does not bootstrap moon, proto or npm. It requires the exact workspace version constraint and rejects a root `node_modules/@moonrepo/cli` package, because a global moon binary could otherwise delegate to a different local version after the version check. It rejects inherited `MOON_*`, `STARBASE_*` and `WARPGATE_*` overrides, disables the daemon and telemetry, and passes both `MOON_CACHE` and `--cache` explicitly.

Default mode is `read`, including in CI. It also disables writing local task artifact caches, although moon can still write state files. Remote misses still execute the reviewed task. For a trusted CI seeding run only, set `EXPBUILD_MOON_WRITE=true` and `CI=true` before invoking the recipe; it then selects `read-write`. Invalid opt-in values or a writer without `CI=true` fail before credentials are read. Do not remove the global cache-mode setting: moon 2.5.6 treats **any nonempty** `CI`, `CI_NAME` or `AZURE_PIPELINES` value (even `CI=false`) as CI, so `localReadOnly: true` alone still allows writes there.

This is client policy, not server authorization. Instance credentials retain read/write access. A user who possesses them can change the client settings. Use a separate instance for untrusted workloads.

## Authentication, transport and storage

The launcher prompts for the instance username/password, constructs Basic authorization metadata in memory and exports `EXPBUILD_MOON_AUTHORIZATION` only inside its subshell. moon substitutes this variable in `auth.headers.authorization`. Do not add `auth.token`: that option names an environment variable for **Bearer** authentication and can override the Basic header. The remote endpoint comes from `MOON_REMOTE_HOST`, not a URL containing credentials. Base64 is reversible; neither it nor passwords belong in files, command history or committed configuration.

Keep shell tracing, debug output, configuration dumps and environment dumps disabled. Upstream custom header values are not marked sensitive in the same way as its Bearer token path. The recipe uses `set +x` and `--log warn`; tasks also inherit the authorization variable and must be trusted.

Use the matching `reapi` endpoint, `grpc://` only on a trusted internal network or `grpcs://` through the TLS gateway. For `grpcs://`, moon 2.5.6 installs native certificate roots and verifies the server certificate. Do not disable verification. The strict recipe accepts no custom `tls` or `mtls` block: private CA/mTLS configuration requires separate review and acceptance. No claim of tested moon gateway TLS is made here.

The profile selects identity compression (`none`) and SHA-256 REAPI digests; it does not use the Bazel HTTP endpoint. Keep bazel-remote's default ActionCache CAS-dependency validation enabled. moon's manifest references its manifest source, outputs and stdout/stderr CAS blobs. Collect the actual failed RPC and missing digest evidence if a request is rejected; do not bypass dependency checks to make a test pass.

`instanceName: moon-outputs` is an RPC/resource namespace convention, **not a tenant security boundary**. The existing engine does not isolate CAS by instance name, and ActionCache instance-key mangling is not enabled. Instance credentials, workload and PVC provide the existing isolation boundary. Shared REAPI transport does not imply cache-key equivalence or artifact reuse across moon, Pants and Bazel.

## Validation and pending acceptance

`npm run test:client-profiles` checks Bash argument/environment handling with a stub moon client, real Python JSON validation and opaque test credentials. API catalog/detail tests, React rendering and browser tests cover profile discovery and Ready gating. They do not execute moon or establish remote cache compatibility.

Before changing the experimental status, record exact client, engine and fixture revisions and perform the [client acceptance gate](client-profiles.md#acceptance-gate):

- Seed a cold cache in explicit writer mode; then use a fresh workspace/local cache and output directory to prove a remote hit and byte-identical output against an uncached baseline.
- Change source, declared dependencies and task options to demonstrate invalidation. Verify default read mode produces no remote writes, including with `CI=false`, `CI=true`, `CI_NAME` and `AZURE_PIPELINES` set.
- Test wrong credentials, unauthenticated access and cross-instance denial. Do not treat different `instanceName` values as an isolation test.
- Corrupt or interrupt CAS uploads/downloads and remove ActionCache dependencies. `verifyIntegrity: true` requests verification; actual error/fallback behavior and absence of incorrect hydration must be measured, not assumed.
- Exercise gateway TLS with a trusted CA and rejection of an untrusted certificate. Retain engine CAS validation defaults in every run.

The minimal future Linux x86-64 client artifact is the official [v2.5.6 musl archive](https://github.com/moonrepo/moon/releases/download/v2.5.6/moon_cli-x86_64-unknown-linux-musl.tar.xz), SHA-256 `b96dc5dcee17ed032ea240069cbae3289001ee290983b15d91a2559f758b4668`. Use it with a dependency-free system task and already available shell tools; no proto/npm installation is needed for that fixture. The archive was identified from release metadata, not downloaded or executed during this change. Isolated real-client execution remains a separate approval step; no downloader or new workflow is added here.

## Source references

Behavior is grounded in the pinned [v2.5.6 release](https://github.com/moonrepo/moon/releases/tag/v2.5.6), not an unversioned feature claim:

- [Remote configuration fields and environment overrides](https://github.com/moonrepo/moon/blob/v2.5.6/crates/config/src/workspace/remote_config.rs), [header substitution and Bearer precedence](https://github.com/moonrepo/moon/blob/v2.5.6/crates/cache-remote/src/headers.rs).
- [gRPC remote storage](https://github.com/moonrepo/moon/blob/v2.5.6/crates/cache-remote/src/grpc_remote_storage.rs), [TLS roots and certificates](https://github.com/moonrepo/moon/blob/v2.5.6/crates/cache-remote/src/grpc_tls.rs).
- [Cache-mode semantics](https://github.com/moonrepo/moon/blob/v2.5.6/crates/cache-item/src/cache_mode.rs), [task-runner cache gates](https://github.com/moonrepo/moon/blob/v2.5.6/crates/task-runner/src/run_state.rs), [CI detection](https://github.com/moonrepo/moon/blob/v2.5.6/crates/common/src/env.rs).
- [Configuration discovery](https://github.com/moonrepo/moon/blob/v2.5.6/crates/config-loader/src/config_finder.rs), [configuration loading](https://github.com/moonrepo/moon/blob/v2.5.6/crates/config-loader/src/config_loader.rs).

The official [remote-cache guide](https://moonrepo.dev/docs/guides/remote-cache) and [workspace reference](https://moonrepo.dev/docs/config/workspace) provide broader configuration context; review against the pinned source before adopting additional options.
