# Reproducible cache experiments

These tools test cache correctness on small, pinned public workloads. They are
not a general performance claim, a full upstream test run, or production
capacity/availability certification. All services bind to a fresh loopback port;
the scripts use new output directories and never install tools, deploy Kubernetes,
or modify the supplied source checkout. The source is extracted with `git archive`.

## Inputs and scope

| Workload | Source revision | Tools and measured scope |
|---|---|---|
| [Abseil 20250814.1](https://github.com/abseil/abseil-cpp/tree/d38452e1ee03523a208362186fd42248ff2609f6) | `d38452e1ee03523a208362186fd42248ff2609f6` | Bazel **8.4.2**; `ascii_test`, `str_cat_test`, `str_split_test`; bazel-remote 2.6.2 |
| [RxJava v3.1.12](https://github.com/ReactiveX/RxJava/tree/2e066505a104f3326bb31a960047b0c183b3d027) | `2e066505a104f3326bb31a960047b0c183b3d027` | Gradle **8.14**, JDK **11**; `jar` and `FlowableMapTest`; expbuild Gradle HTTP cache |

The benchmark binary and recorded results use Bazel 8.4.2. The repository's
separate native protocol fixture may use another pinned Bazel version; do not
mix those measurements.

Both upstream workloads and bazel-remote are Apache-2.0 licensed. Keep their
LICENSE/NOTICE files with extracted sources; their source trees and dependency
binaries are not vendored here. The module-output fixture is a small local test,
not copied RxJava code. Its external plugin is org.beryx.jar 2.0.0.

Use Python 3.12+, Git, existing verified tool binaries, and BSD `/usr/bin/time`
on macOS or GNU `/usr/bin/time` on Linux. Actual workload measurements below are
macOS 15.6.1/arm64; Linux argument handling/unit tests are not Linux performance
measurements. Record compiler/JDK identity and binary hashes from each run.
Bazel and Gradle/JDK versions are checked, and a changed toolchain requires a new
qualification. No automatic tool download is performed by the runners.

Prepare dependency downloads outside the timed run. Abseil needs a warmed
`--repository_cache` from the same source/targets. RxJava needs **only** the
`caches/modules-2` directory from a disposable Gradle home, with `*.lock` and
`gc.properties` excluded. Run the selected `jar test --tests
io.reactivex.rxjava3.internal.operators.flowable.FlowableMapTest` tasks once with
`--no-build-cache`, the pinned JDK, two workers, and automatic JDK downloads and
discovery disabled in that home's `gradle.properties`. Do not copy project
`.gradle`, build outputs, local build caches or user-wide Gradle init scripts.
The runner fingerprints the snapshot and rejects measured dependency downloads
or artifact changes. Gradle remote measurements cannot use `--offline`, which
also disables its remote build cache; independent oracles use offline mode.

## Run

Variables below point to verified tools, pinned checkouts and new disposable
output paths. The cache engine is either an existing verified bazel-remote binary
or `go build -o "$GRADLE_CACHE" ./cmd/gradle-cache` from `operator/`.
The `--htpasswd` file is a temporary **public test fixture** for `builder` / `secret`,
not a real account. Generate it outside the repository (for example with
`htpasswd -nbB builder secret`), restrict its permissions, and remove it in the
caller's cleanup. Do not use these tools or fixture credentials for shared services.

```sh
python3 tools/benchmarks/run_abseil.py \
  --source "$ABSEIL_SOURCE" --output "$NEW_ABSEIL_OUTPUT" \
  --bazel "$VERIFIED_BAZEL" --engine "$BAZEL_REMOTE" \
  --dependency-cache "$REPOSITORY_DOWNLOADS" --htpasswd "$TEMP_HTPASSWD" \
  --incremental

python3 tools/benchmarks/run_rxjava.py \
  --source "$RXJAVA_SOURCE" --output "$NEW_RXJAVA_OUTPUT" \
  --gradle "$GRADLE" --java-home "$JAVA_HOME" --engine "$GRADLE_CACHE" \
  --dependency-snapshot "$MODULES_2_SNAPSHOT" --htpasswd "$TEMP_HTPASSWD" \
  --reproducible-jar --isolated-module-output
```

RxJava's two flags are explicit experimental adaptations. `--reproducible-jar`
asks Bnd to omit its wall-clock manifest field **during construction**; the
comparator still checks the complete manifest. `--isolated-module-output` changes
the pinned plugin's overlapping compiler output layout in the disposable copy.
Without the latter, the original build passes the fresh oracle but fails the
required in-place rebuild gate. Without the former, unrelated manifest timing
can already fail the repeated baseline. See [diagnosis and reproduction](rxjava-module-output-diagnosis.md).
Neither flag patches the source checkout or changes production cache behavior.

Each runner executes two independent disabled baselines, remote-cold producer,
and a fresh-output remote-hot consumer. Abseil optionally adds paired incremental
cases with the same fixed source assertion and an unmeasured prewarm. RxJava does
not claim a source-edit incremental benchmark; its extra check is a forced
rebuild of the cache-restored workspace.

The gates check actual server request deltas, byte-equivalent outputs and the
requested tests. Abseil also proves the changed assertion is present and executed,
checks artifact paths stay inside the case output base, and forces uncached tests
after remote reuse. RxJava compares all decompressed JAR entries, requires exactly
one compiled module descriptor matching the JAR, rejects unexpected test skips,
and executes both a fresh-source and an in-place uncached `jar test` oracle.
Cached test XML is not counted as newly executed tests. The pinned suite has
28 cases: 27 pass and the upstream `RxJavaTest.announce` skip remains explicit.

Evidence includes identity, dependency manifests, commands, raw task/BEP events,
server counters, resource records and correctness results. Raw evidence can
contain local paths; review it before sharing. Secrets are not command arguments.
Resource output covers the measured command, not the whole host/cache server.
Timeouts and signals clean up owned process groups/private Gradle daemons; a
host crash or SIGKILL still requires checking the recorded owned-resource IDs.
The output path must not exist; never reuse a failed run's directory as a clean case.

## Measured boundaries

Three comparable Abseil rounds used Apple clang 17.0.0 and warm dependency
downloads, with fresh output bases and no disk action cache. Times are seconds:

| Case | Raw samples | Median |
|---|---|---:|
| disabled-a | 44.631, 45.224, 43.616 | 44.631 |
| disabled-b | 43.768, 43.158, 44.168 | 43.768 |
| remote-cold | 56.492, 56.411, 56.522 | 56.492 |
| remote-hot | 35.780, 33.675, 33.653 | 33.675 |

All three executable hashes matched between the disabled/cold/hot cases. The
hot cases each had 164 server-observed action-cache hits; forced test oracles
passed. The one paired source-edit sample was 8.159 seconds disabled versus
8.379 remote, with three action-cache misses and matching changed output bytes.
It did **not** show an incremental speedup. No p95 or cross-machine claim is made.

RxJava qualification used Temurin 11.0.32.1+1, two workers, 1536 MiB Gradle heap
and the upstream 1200 MiB test heap. One earlier four-case run measured
31.916 / 33.733 / 35.675 / 19.060 seconds, but it predates the mandatory in-place
rebuild gate and must not be presented as an accepted performance result.
The original output-layout defect is reproducible; with the explicit adaptation,
both fresh and in-place oracles preserve all 1,762 JAR entries and execute
27 tests plus the one known skip. No stable RxJava speedup is asserted.

Run evidence-contract tests with:

```sh
python3 -m unittest discover -s tools/benchmarks -p 'test_*.py'
```

CI runs these lightweight contracts; full workload measurements require the
prepared tools and dependency inputs above. Cache-unavailable/corrupt-result
fallback, remote hosts, concurrent tenants, eviction/soak tests and production
resource budgets remain separate validation work.
