// Pure recipes can be exercised with stub clients without a running cache.
// Keep versions aligned with the API profiles; no recipe is a certification.
type Endpoint = { protocol: string; url: string };
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
export function clientProfileExample(id: string, endpoint: Endpoint, version?: string): string | null {
  if (version !== undefined && version !== ({ pants: "2.33.1", sccache: "0.18.0", "maven-build-cache": "1.3.0" } as Record<string, string>)[id]) return null;
  let url: URL;
  try { url = new URL(endpoint.url); } catch { return null; }
  if (!url.hostname || url.username || url.password || url.search || url.hash ||
      /\s/.test(endpoint.url) || (url.pathname && url.pathname !== "/")) return null;
  const sccache = id === "sccache" && endpoint.protocol === "webdav" && ["http:", "https:"].includes(url.protocol);
  const pants = id === "pants" && endpoint.protocol === "reapi" && ["grpc:", "grpcs:"].includes(url.protocol);
  const maven = id === "maven-build-cache" && endpoint.protocol === "webdav" && ["http:", "https:"].includes(url.protocol);
  if (!sccache && !pants && !maven) return null;
  if (maven) return mavenExample(url);
  const credentials = [
    "read -r -p 'Cache username: ' CACHE_USER",
    "read -r -s -p 'Cache password: ' CACHE_PASSWORD",
    "printf '\\n'",
  ];
  if (sccache) return [
    "(",
    "set -euo pipefail",
    "# Experimental; requires sccache 0.18.0 with WebDAV and an unused local port.",
    "test \"$(sccache --version)\" = 'sccache 0.18.0'",
    ...credentials,
    `export SCCACHE_WEBDAV_ENDPOINT=${quote(endpoint.url)}`,
    "export SCCACHE_WEBDAV_KEY_PREFIX='sccache/'",
    'export SCCACHE_WEBDAV_USERNAME="$CACHE_USER" SCCACHE_WEBDAV_PASSWORD="$CACHE_PASSWORD"',
    "unset SCCACHE_WEBDAV_TOKEN SCCACHE_SERVER_UDS",
    "export SCCACHE_WEBDAV_RW_MODE=READ_ONLY",
    '# Local policy only; these instance credentials can still write.',
    'if [ "${CI:-}" = true ]; then export SCCACHE_WEBDAV_RW_MODE=READ_WRITE; fi',
    "export RUSTC_WRAPPER=sccache CARGO_INCREMENTAL=0",
    "# Use a dedicated daemon so an existing daemon cannot retain another backend.",
    "export SCCACHE_SERVER_PORT=4227",
    "sccache --start-server",
    "trap 'sccache --stop-server >/dev/null' EXIT",
    "cargo build --release",
    "sccache --show-stats",
    ")",
  ].join("\n");
  return [
    "(",
    "set -euo pipefail",
    "# Experimental; project pants.toml must pin pants_version = '2.33.1'.",
    "test \"$(pants --version)\" = '2.33.1'",
    ...credentials,
    'CACHE_AUTH="$(printf \'%s:%s\' "$CACHE_USER" "$CACHE_PASSWORD" | base64 | tr -d \'\\r\\n\')"',
    `export PANTS_REMOTE_STORE_ADDRESS=${quote(endpoint.url)}`,
    "export PANTS_REMOTE_STORE_HEADERS=\"{'authorization': 'Basic $CACHE_AUTH'}\"",
    "export PANTS_REMOTE_PROVIDER=reapi PANTS_REMOTE_EXECUTION=false",
    "export PANTS_REMOTE_CACHE_READ=true PANTS_REMOTE_CACHE_WRITE=false",
    '# Local policy only; these instance credentials can still write.',
    'if [ "${CI:-}" = true ]; then export PANTS_REMOTE_CACHE_WRITE=true; fi',
    "export PANTS_PANTSD=false",
    "pants test ::",
    "pants package ::",
    ")",
  ].join("\n");
}


function mavenExample(url: URL): string {
  const xml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
  const plugins = [
    ["maven-surefire-plugin", "test", ["skipTests", "skip", "skipExec"]],
    ["maven-failsafe-plugin", "integration-test", ["skipTests", "skipITs", "skip"]],
    ["maven-failsafe-plugin", "verify", ["skipTests", "skipITs", "skip"]],
    ["maven-compiler-plugin", "compile", ["source", "target", "release"]],
    ["maven-compiler-plugin", "testCompile", ["source", "target", "release", "testSource", "testTarget", "testRelease"]],
  ] as const;
  const config = `<?xml version="1.0" encoding="UTF-8"?>
<cache xmlns="http://maven.apache.org/BUILD-CACHE-CONFIG/1.4.0">
  <configuration>
    <enabled>true</enabled>
    <hashAlgorithm>SHA-256</hashAlgorithm>
    <remote enabled="true" saveToRemote="false" id="expbuild-maven">
      <url>${xml(url.origin + "/maven-build-cache")}</url>
    </remote>
  </configuration>
  <executionControl>
    <reconcile>
      <plugins>
${plugins.map(([artifact, goal, props]) => `        <plugin artifactId="${artifact}" goal="${goal}">
          <reconciles>
${props.map(prop => `            <reconcile propertyName="${prop}"/>`).join("\n")}
          </reconciles>
        </plugin>`).join("\n")}
      </plugins>
    </reconcile>
  </executionControl>
</cache>`;
  return [
    "(",
    "set -euo pipefail",
    "umask 077",
    "# Experimental: Maven 3.9.16 + Build Cache Extension 1.3.0, already provisioned.",
    "# Merge the pinned extension into .mvn/extensions.xml before using this example.",
    "# Existing settings.xml must define server expbuild-maven with username/password",
    "# referencing ${env.EXPBUILD_MAVEN_USER} and ${env.EXPBUILD_MAVEN_PASSWORD}.",
    "# Python 3 validates the existing XML; this does not install or run the extension.",
    "python3 - <<'EXPBUILD_CHECK_EXTENSION'",
    "import xml.etree.ElementTree as ET",
    "root = ET.parse('.mvn/extensions.xml').getroot()",
    "def field(element, name):",
    "    return next(((x.text or '').strip() for x in element if x.tag.rsplit('}', 1)[-1] == name), '')",
    "matches = [e for e in root if e.tag.rsplit('}', 1)[-1] == 'extension' and field(e, 'groupId') == 'org.apache.maven.extensions' and field(e, 'artifactId') == 'maven-build-cache-extension']",
    "if len(matches) != 1 or field(matches[0], 'version') != '1.3.0':",
    "    raise SystemExit('Configure exactly one Build Cache Extension 1.3.0 before using this recipe.')",
    "EXPBUILD_CHECK_EXTENSION",
    "# This starter configuration is only for a fresh fixture. Preserve project-specific rules.",
    "if [ -e .mvn/maven-build-cache-config.xml ]; then printf '%s\\n' 'Merge cache settings manually; existing project config found.' >&2; exit 1; fi",
    "case \"$(mvn -B -Dstyle.color=never --version)\" in 'Apache Maven 3.9.16'|'Apache Maven 3.9.16 ('*) ;; *) printf '%s\\n' 'Maven 3.9.16 required.' >&2; exit 1;; esac",
    "read -r -p 'Cache username: ' EXPBUILD_MAVEN_USER",
    "read -r -s -p 'Cache password: ' EXPBUILD_MAVEN_PASSWORD",
    "printf '\\n'",
    "export EXPBUILD_MAVEN_USER EXPBUILD_MAVEN_PASSWORD",
    "MAVEN_CACHE_TMP=\"$(mktemp -d)\"",
    "trap 'rm -rf -- \"$MAVEN_CACHE_TMP\"' EXIT",
    "cat >\"$MAVEN_CACHE_TMP/config.xml\" <<'EXPBUILD_MAVEN_CONFIG'",
    config,
    "EXPBUILD_MAVEN_CONFIG",
    "# Client-only no-push policy; WebDAV credentials can still write, overwrite and delete.",
    "mvn -B -Dmaven.resolver.transport=native -Daether.connector.http.supportWebDav=true \\",
    "  -Dmaven.build.cache.configPath=\"$MAVEN_CACHE_TMP/config.xml\" \\",
    "  -Dmaven.build.cache.location=\"$MAVEN_CACHE_TMP/local\" \\",
    "  -Dmaven.build.cache.remote.enabled=true -Dmaven.build.cache.remote.save.enabled=false \\",
    `  ${quote("-Dmaven.build.cache.remote.url=" + url.origin + "/maven-build-cache")} \\`,
    "  -Dmaven.build.cache.remote.server.id=expbuild-maven \\",
    "  clean verify",
    ")",
  ].join("\n");
}
