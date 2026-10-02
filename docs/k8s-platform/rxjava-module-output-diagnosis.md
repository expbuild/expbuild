# Module loss after Gradle cache restore

For RxJava v3.1.12 (`2e066505a104f3326bb31a960047b0c183b3d027`), Gradle 8.14,
Temurin 11.0.32.1+1 and org.beryx.jar 2.0.0, a cache-restored workspace can lose
`META-INF/versions/9/module-info.class` during a subsequent
`--no-build-cache --rerun-tasks jar test`. The build exits zero and ordinary
classpath tests still pass. Fresh-source equivalence alone is insufficient.

## Isolated cause and controls

The plugin's [pinned Java 8 branch](https://github.com/beryx/badass-jar-plugin/blob/3de652b77cd2807e5f98ad600ead4a3539db94ee/src/main/groovy/org/beryx/jar/JarTaskConfigurer.groovy)
places the Java 9 module task `compileJava` in
`build/classes/java/main/META-INF/versions/9`, inside `compileNonJpms`'s output
`build/classes/java/main`. The latter depends on the former. Gradle reports that
it cannot cache the overlapping ordinary compiler output.

A one-class/one-module fixture reproduces the loss without RxJava, Bnd, expbuild
or measurement listeners. Before/after observations locate the deletion during
`compileNonJpms`. This narrows the fault to the pinned output-layout/cache-restore
interaction, not every Gradle/JDK release or one conclusively identified Gradle
internal method. Remote archive bytes were downloaded twice and matched the
stored SHA256; the archive contained the descriptor. Its path relative to the
compiler output root is expected, not evidence of a server path rewrite.

| Pinned build | Disabled initial → forced rebuild | Cache restore → forced rebuild |
|---|---|---|
| Minimal fixture, original layout | Descriptor retained | Descriptor lost with native local and standard-library HTTP cache |
| RxJava, original layout | Descriptor retained (Bnd timestamp may differ) | Descriptor lost; classpath tests still pass |
| Explicit isolated-output adaptation | Complete entries retained | Complete entries retained |

Earlier repeated local/expbuild experiments ran two samples for each case with
all Gradle invocations exiting zero. The committed self-contained reproduction
now checks ten builds: disabled control, original local restore, original HTTP
restore, and adapted local restore, including producer and rebuild steps. It
fails if the expected defect does not occur on the pinned tools; it does not
silently treat a changed upstream behavior as confirmation.

## Run the reproduction

Use existing verified Gradle 8.14/JDK 11 and a prepared plugin dependency
`modules-2` snapshot. It requires a new output directory and only opens its own
loopback HTTP reader; it never starts expbuild or a registry.

```sh
python3 tools/benchmarks/reproduce_module_output.py \
  --output "$NEW_REPRO_OUTPUT" --gradle "$GRADLE" --java-home "$JAVA_HOME" \
  --dependency-snapshot "$MODULES_2_SNAPSHOT"
```

The script asserts actual `compileJava FROM-CACHE`, an initial descriptor,
unchanged ordinary entry bytes, exact descriptor loss for original consumers,
and complete entry preservation for the adaptation. It saves initial/rebuilt
JARs, compiled descriptor hashes and HTTP request counts. Exit zero means the
**expected defect and the adapted behavior were both verified**, not that the
original build is safe. See the [fixture](../../tools/benchmarks/fixtures/gradle-module-output/README.md).

## Explicit adaptation and acceptance gate

`gradle-rxjava-module-output.init.gradle` moves the module output to an independent
root while retaining the final `META-INF/versions/9` relative path, Java 9 compiler
validation, module version and task dependency. JAR input includes that root.
This preserves RxJava's root `exclude("module-info.class")` behavior; mapping a
bare descriptor with `into` was insufficient because exclusion happens earlier.
The script verifies the expected plugin and original layout and refuses a changed
layout. It is an opt-in benchmark adaptation, not a published upstream fix or an
expbuild server feature.

`run_rxjava.py` always requires a descriptor in both compiled output and JAR,
compares every decompressed entry including the full manifest, and retains the
measured JAR before running two uncached oracles. Both oracles must actually
execute the pinned 28-case suite (27 passes, only upstream `announce` skipped).
The original layout passes the fresh oracle but is rejected by the in-place gate.
With `--reproducible-jar --isolated-module-output`, both oracles preserve all
1,762 entry names and bytes. The independently observed entry-manifest digest is
`830eb44de26c949a2f8edc094835b317be4ae560f6f91b1b3455fa642f2c82b9`.
ZIP container timestamps/compression are excluded; content is not normalized away.

Do not silently enable this script in users' builds. Tool upgrades, other module
plugins, full RxJava suites, release signing, alternate platforms and production
rollout require their own checks. These correctness results do not establish a
universal cache performance benefit.
