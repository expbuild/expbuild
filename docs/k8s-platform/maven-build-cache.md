# Experimental Maven Build Cache Extension profile

The `maven-build-cache` profile targets **Apache Maven Build Cache Extension 1.3.0 on Maven 3.9.16** using existing `webdav-apache@0.1.0` and `@0.2.0` instances. The extension's release POM uses Maven 3.9.16 for its default tests. The installed Maven 3.9.5 on a developer machine is not evidence for this pinned combination. Real extension acceptance remains pending; this is an experimental configuration recipe.

This caches build outputs and build metadata. It is **not a Maven dependency mirror or repository proxy**. Dependencies, plugins and the extension still resolve through the project's normal repositories. No new engine, Operator template, image, credential type or storage capability is introduced.

## Prepare a dedicated validation fixture

Use a dedicated WebDAV instance and trusted HTTPS Gateway, or an internal endpoint reachable over the trusted cluster network. Preserve certificate verification. The API exposes the profile only for the two known WebDAV template versions; the UI displays its example only for the current Ready generation.

Provision Maven 3.9.16, Java, Python 3 and the extension before using the example. This change does not install or execute them. Merge the following entry into the fixture's `.mvn/extensions.xml`; do not overwrite other extensions:

```xml
<extensions xmlns="http://maven.apache.org/EXTENSIONS/1.1.0">
  <extension>
    <groupId>org.apache.maven.extensions</groupId>
    <artifactId>maven-build-cache-extension</artifactId>
    <version>1.3.0</version>
  </extension>
</extensions>
```

Add this server to the existing user `settings.xml`, preserving repositories, mirrors, proxies and other server entries. Never commit a plaintext password:

```xml
<server>
  <id>expbuild-maven</id>
  <username>${env.EXPBUILD_MAVEN_USER}</username>
  <password>${env.EXPBUILD_MAVEN_PASSWORD}</password>
</server>
```

The generated Bash example prompts for these environment variables inside a subshell. Its temporary XML contains only the endpoint, server ID and configuration. It does not replace user settings or write credentials into the project. Avoid shell tracing and debug dumps of environment variables.

The example verifies the extension XML using Python's standard library, checks the Maven version, and refuses to replace an existing `.mvn/maven-build-cache-config.xml`. For an established project, manually merge the remote section and reconciliation rules into that project's audited configuration; preserve custom includes, excludes, plugin rules and other settings. The starter is not a universal production configuration.

The generated configuration uses namespace `BUILD-CACHE-CONFIG/1.4.0`, SHA-256 input hashing, server ID `expbuild-maven`, and the instance origin plus `/maven-build-cache`. Its fresh temporary local cache prevents old local entries from masquerading as remote hits during validation. The directory is removed on either success or failure. Our tests parse the generated XML; they do not establish extension-side XSD validation. The pinned extension marks its `validateXml` option as unimplemented, so this profile does not rely on it.

Maven 3.9's native Resolver transport requires **`-Daether.connector.http.supportWebDav=true`** to create missing parent collections. The recipe selects native transport explicitly and runs `clean verify` with remote reads enabled and `-Dmaven.build.cache.remote.save.enabled=false`, even when `CI=true`. Maven 3.10 uses a differently named transport property; do not silently substitute versions or switch to Wagon.

## Storage and authorization

The pinned extension uses separate resources under:

```text
maven-build-cache/v1.2/<groupId>/<artifactId>/<input-checksum>/<filename>
```

The group ID remains dotted, not split into Maven repository directories. Resources include `buildinfo.xml`, artifact files and attached outputs. Build reports use a build UUID and `build-cache-report.xml`. The input checksum is an opaque path component, not a content-addressed archive key or an authorization scope.

Resolver performs HTTP requests with authentication selected from the matching settings server; broad mirror rules may redirect that repository and change which server ID supplies credentials. Audit mirrors and proxies before testing. Native HTTP uses WebDAV discovery and MKCOL for cold nested directories, then individual GET/PUT operations; HEAD is supported by the existing engine. A PROPFIND readiness check alone does not establish extension compatibility.

WebDAV credentials authorize reads, writes, overwrites and deletes within the instance. The `/maven-build-cache` prefix is organization, not tenant isolation. The client no-push flag and `maven.build.cache.remote.save.final` do **not** create a server-enforced read-only role or immutable records. Do not hand these credentials to untrusted pull requests or use a shared instance across different trust domains.

Use a single trusted writer during initial acceptance. Multi-file publication is not transactional: artifacts and build metadata can be partially uploaded or replaced independently. Readers can encounter incomplete or mixed records. Neither input SHA-256 hashing nor XML parsing proves the writer is trustworthy. Keep separate instances for distinct trust domains, rotate compromised credentials, and quarantine or replace poisoned data. WebDAV has no automatic LRU; monitor its PVC and apply controlled whole-record retention. Do not delete random referenced artifacts as though this were an independent-blob cache.

## Cache correctness

The starter strictly reconciles Surefire `test` flags `skipTests`, `skip` and `skipExec`; Failsafe `integration-test`/`verify` flags `skipTests`, `skipITs` and `skip`; and compiler `compile`/`testCompile` target/release parameters. It supplies no permissive `skipValue` exemptions. Goal names matter: a reconciliation rule for the wrong goal does not protect that execution.

Each project must audit all inputs and output-affecting plugin parameters, including source/resource/generated inputs, dependency changes, profiles, environment-derived values, compiler toolchains and test settings. Do not remove a mismatching parameter just to increase hits. Builds with tests skipped must not be accepted as proof that the requested test execution occurred. Input hashes, effective POM and runtime parameter reconciliation have different roles; source identity alone is insufficient.

A trusted seeding job may explicitly change `maven.build.cache.remote.save.enabled` to `true` after the fixture and writer trust are approved. Keep normal reads at `false` for upload permission. The server still permits any credential holder to override that client policy. For a clean uncached comparison, disable the extension cache with `-Dmaven.build.cache.enabled=false`; `skipCache=true` alone skips reads but can still save results.

## Evidence and pending acceptance

The batch tests configuration generation with a stub Maven command, real Bash, and Python XML parsing. Tests cover XML escaping, extension pin checks, no credential interpolation into XML, default no-push even in CI, cleanup after failed builds, and protection of existing configuration. API, UI and browser checks cover the profile and password handling. The existing Apache contract test now checks cold nested MKCOL, binary artifact and buildinfo GET/PUT/HEAD, authentication and mutable overwrite semantics. These are server/configuration tests, **not a real Maven extension run**.

After consolidated isolated-CI approval, provision the official Maven 3.9.16 distribution and `org.apache.maven.extensions:maven-build-cache-extension:1.3.0`, with the fixture's pinned plugins and dependencies from approved repositories. Record distribution checksums and resolved dependency versions before execution. Reuse the runner's Java where compatible; no new local installation or repository proxy is needed. No workflow in this change downloads or executes the extension.

Acceptance must record client/Java/engine versions and server SHA, then demonstrate:

1. A trusted cold writer creates parent collections, artifacts, build metadata and report; inspect server requests and logs, not just Maven exit status.
2. A clean checkout with removed outputs and a new local extension cache restores from remote, with output comparison against a cache-disabled build.
3. Changes to source, resources, dependency versions, compiler flags, profiles and test-skip flags trigger the correct miss, reconciliation or execution. Include reactor dependency changes and Surefire/Failsafe both directions.
4. Wrong credentials cannot read or write; client no-push performs no PUT/MKCOL, while the same credentials' direct write authority is documented.
5. Missing metadata, missing artifact, truncated/corrupt archive, malformed XML, interrupted upload, concurrent writers and unavailable server never produce silently accepted incorrect outputs. Observe whether the pinned client falls back or fails; do not assume all corruption is recoverable. Record partial restoration and cleanup.
6. Gateway DNS/TLS and cross-instance credentials are tested separately. Repeat after credential rotation and server restart.

## Official sources

- [Extension 1.3.0 release](https://github.com/apache/maven-build-cache-extension/releases/tag/maven-build-cache-extension-1.3.0)
- [Remote resource layout and Resolver authentication](https://github.com/apache/maven-build-cache-extension/blob/maven-build-cache-extension-1.3.0/src/main/java/org/apache/maven/buildcache/RemoteCacheRepositoryImpl.java)
- [Pinned WebDAV integration test](https://github.com/apache/maven-build-cache-extension/blob/maven-build-cache-extension-1.3.0/src/test/java/org/apache/maven/buildcache/its/RemoteCacheDavTest.java)
- [Pinned configuration template](https://github.com/apache/maven-build-cache-extension/blob/maven-build-cache-extension-1.3.0/src/site/resources/maven-build-cache-config.xml)
- [Remote cache setup](https://maven.apache.org/extensions/maven-build-cache-extension/remote-cache.html) and [parameters](https://maven.apache.org/extensions/maven-build-cache-extension/parameters.html)
- [Maven 3.9.16 release notes](https://maven.apache.org/docs/3.9.16/release-notes.html)
