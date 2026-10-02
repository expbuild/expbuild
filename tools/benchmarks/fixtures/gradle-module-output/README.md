# Overlapping compiler-output fixture

A locally authored Java 8 class plus Java 9 module descriptor, using
org.beryx.jar **2.0.0**, Gradle **8.14** and JDK **11**. No RxJava, Bnd or
expbuild service is needed. Keep plugin dependencies in a prepared, disposable
`modules-2` snapshot; do not use a normal user's Gradle home.

From the repository root:

```sh
python3 tools/benchmarks/reproduce_module_output.py \
  --output "$NEW_REPRO_OUTPUT" --gradle "$GRADLE" --java-home "$JAVA_HOME" \
  --dependency-snapshot "$MODULES_2_SNAPSHOT"
```

This verifies native local-cache and read-only loopback HTTP-cache restoration,
then forces an uncached rebuild without `clean`. The original restored JAR has
`META-INF/versions/9/module-info.class`; rebuilding removes that entry while
ordinary class bytes remain unchanged. The uncached control and explicit
isolated-output adaptation preserve the complete JAR contents.

Exit zero confirms the expected defect **and** the adaptation's control results.
See [diagnosis and boundaries](../../../../docs/k8s-platform/rxjava-module-output-diagnosis.md).
