// Pure recipes can be exercised with stub clients without a running cache.
// Keep versions aligned with the API profiles; no recipe is a certification.
type Endpoint = { protocol: string; url: string };
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
export function clientProfileExample(id: string, endpoint: Endpoint, version?: string, instanceId?: string): string | null {
  if (version !== undefined && version !== ({ pants: "2.33.1", sccache: "0.18.0", turborepo: "2.11.7", nx: "22.7.12", "maven-build-cache": "1.3.0", moonrepo: "2.5.6", "go-cacheprog": "1.3.0" } as Record<string, string>)[id]) return null;
  let url: URL;
  try { url = new URL(endpoint.url); } catch { return null; }
  if (!url.hostname || url.username || url.password || url.search || url.hash ||
      /\s/.test(endpoint.url) || (url.pathname && url.pathname !== "/")) return null;
  const sccache = id === "sccache" && endpoint.protocol === "webdav" && ["http:", "https:"].includes(url.protocol);
  const pants = id === "pants" && endpoint.protocol === "reapi" && ["grpc:", "grpcs:"].includes(url.protocol);
  const turborepo = id === "turborepo" && endpoint.protocol === "turborepo-http" && ["http:", "https:"].includes(url.protocol);
  const nx = id === "nx" && endpoint.protocol === "nx-http" && ["http:", "https:"].includes(url.protocol);
  const maven = id === "maven-build-cache" && endpoint.protocol === "webdav" && ["http:", "https:"].includes(url.protocol);
  const moon = id === "moonrepo" && endpoint.protocol === "reapi" && ["grpc:", "grpcs:"].includes(url.protocol);
  const goCache = id === "go-cacheprog" && endpoint.protocol === "go-cacheprog" && ["http:", "https:"].includes(url.protocol);
  if (!goCache && !sccache && !pants && !turborepo && !nx && !maven && !moon) return null;
  if (goCache) return goCacheRecipe(url.origin);
  if (turborepo) {
    if (!instanceId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(instanceId)) return null;
    return [
      "(",
      "set -euo pipefail",
      "# Experimental; requires an already installed Turborepo 2.11.7.",
      "test \"$(turbo --version)\" = '2.11.7'",
      "# Enter the instance password as the Bearer token, not a Vercel token.",
      "read -r -s -p 'Instance cache token: ' TURBO_TOKEN",
      "printf '\\n'",
      "export TURBO_TOKEN",
      `export TURBO_API=${quote(url.origin)}`,
      `export TURBO_TEAMID=${quote("team_" + instanceId)}`,
      "# Empty slug overrides any saved team slug; the server binds this team ID.",
      "export TURBO_TEAM=''",
      "CACHE_MODE='local:rw,remote:r'",
      "# Client-only read mode; the instance token still has read/write authority.",
      'if [ "${CI:-}" = true ]; then CACHE_MODE=local:rw,remote:rw; fi',
      'turbo run build --cache="$CACHE_MODE"',
      ")",
    ].join("\n");
  }
  if (nx) {
    return [
      "(",
      "set -euo pipefail",
      "# Experimental; requires Nx 22.7.12 already installed in this workspace.",
      "# Only use the read/write instance token in trusted build environments.",
      "read -r -s -p 'Instance cache token: ' NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN",
      "printf '\\n'",
      "export NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN",
      `export NX_SELF_HOSTED_REMOTE_CACHE_SERVER=${quote(url.origin)}`,
      "export NX_DAEMON=false NX_NO_CLOUD=true",
      "# Ensure nx.json has no other remote-cache provider configured.",
      "test \"$(node -p \"require('./node_modules/nx/package.json').version\")\" = '22.7.12'",
      "./node_modules/.bin/nx run-many -t build",
      ")",
    ].join("\n");
  }
  if (maven) return mavenExample(url);
  const credentials = [
    "read -r -p 'Cache username: ' CACHE_USER",
    "read -r -s -p 'Cache password: ' CACHE_PASSWORD",
    "printf '\\n'",
  ];
  if (moon) return moonRecipe(endpoint.url);
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

// Deliberately limited to the documented, dedicated JSON acceptance workspace.
// Validate before prompting; never rewrite an existing project configuration.
function moonRecipe(endpoint: string): string {
  return [
    "(",
    "set +x",
    "set -euo pipefail",
    "# Experimental moon 2.5.6; prepare the JSON workspace in docs/k8s-platform/moonrepo.md.",
    "# Requires Python 3 for a read-only configuration preflight. No installer is invoked.",
    "python3 - <<'MOON_PREFLIGHT'",
    "import json, os, pathlib, sys",
    "def require(ok, message):",
    "    if not ok: sys.exit(message)",
    "require(not any(k.startswith(('MOON_', 'STARBASE_', 'WARPGATE_')) for k in os.environ), 'Use a clean environment without moon overrides or tracing.')",
    "require(not pathlib.Path('.config/moon').exists(), 'Use only .moon/workspace.json.')",
    "directory = pathlib.Path('.moon')",
    "path = directory / 'workspace.json'",
    "require(not directory.is_symlink() and not path.is_symlink(), 'Symlinked workspace configuration is unsupported.')",
    "require(path.is_file() and sorted(p.name for p in directory.glob('workspace.*')) == ['workspace.json'], 'Use only .moon/workspace.json; alternative formats are unsupported.')",
    "require(not pathlib.Path('node_modules/@moonrepo/cli').exists(), 'A local moon package can override the pinned binary; use a dedicated system-only workspace.')",
    "config = json.loads(path.read_text())",
    "require(config.get('versionConstraint') == '=2.5.6', 'Pin versionConstraint to =2.5.6.')",
    "require('extends' not in config, 'Extended workspace configuration is unsupported by this recipe.')",
    "expected = {'api': 'grpc', 'auth': {'headers': {'authorization': '${EXPBUILD_MOON_AUTHORIZATION}'}}, 'cache': {'compression': 'none', 'instanceName': 'moon-outputs', 'localReadOnly': True, 'verifyIntegrity': True}}",
    "require(config.get('remote') == expected, 'Use the exact remote configuration from docs/k8s-platform/moonrepo.md.')",
    "require(config.get('pipeline') == {'installDependencies': False, 'syncProjects': False, 'syncWorkspace': False}, 'Disable automatic install and sync in this acceptance workspace.')",
    "MOON_PREFLIGHT",
    "export MOON_DAEMON=false MOON_TELEMETRY=false MOON_CACHE=read",
    "# Global read mode also blocks remote writes in CI, including CI=false.",
    'case "${EXPBUILD_MOON_WRITE:-false}" in',
    '  false) ;;',
    '  true) test "${CI:-}" = true; export MOON_CACHE=read-write ;;',
    "  *) printf '%s\\n' 'EXPBUILD_MOON_WRITE must be false or true.' >&2; exit 1 ;;",
    "esac",
    "test \"$(moon --version)\" = 'moon 2.5.6'",
    "read -r -p 'Cache username: ' CACHE_USER",
    "read -r -s -p 'Cache password: ' CACHE_PASSWORD",
    "printf '\\n'",
    'CACHE_AUTH="$(printf \'%s:%s\' "$CACHE_USER" "$CACHE_PASSWORD" | base64 | tr -d \'\\r\\n\')"',
    'export EXPBUILD_MOON_AUTHORIZATION="Basic $CACHE_AUTH"',
    "unset CACHE_USER CACHE_PASSWORD CACHE_AUTH",
    `export MOON_REMOTE_HOST=${quote(endpoint)}`,
    '# app:build must be a reviewed system-only task; do not dump env/config or enable tracing.',
    'moon --log warn --cache "$MOON_CACHE" run app:build',
    ")",
  ].join("\n");
}

function goCacheRecipe(origin: string): string {
 return [
  "(",
  "set -euo pipefail",
  "# Experimental: already installed Go 1.27.1 and platacard/cacheprog v1.3.0 required.",
  "export GOTOOLCHAIN=local",
  "test \"$(go env GOVERSION)\" = 'go1.27.1'",
  "EXPBUILD_CACHEPROG_BIN=\"$(command -v cacheprog)\"",
  "case \"$EXPBUILD_CACHEPROG_BIN\" in /*) ;; *) echo 'cacheprog must resolve to an absolute executable path' >&2; exit 1;; esac",
  "case \"$EXPBUILD_CACHEPROG_BIN\" in *[!a-zA-Z0-9_./-]*) echo 'Use a cacheprog path without spaces or shell metacharacters' >&2; exit 1;; esac",
  "\"$EXPBUILD_CACHEPROG_BIN\" --version | grep -Eq '^cacheprog version v?1\\.3\\.0( |$)'",
  "# Clear inherited cacheprog storage, auth and reset settings before choosing this instance.",
  "for EXPBUILD_ENV in ${!CACHEPROG_@}; do unset \"$EXPBUILD_ENV\"; done",
  "read -r -s -p 'Instance cache token: ' EXPBUILD_CACHE_TOKEN",
  "printf '\\n'",
  "case \"$EXPBUILD_CACHE_TOKEN\" in ''|*[!a-zA-Z0-9_-]*) echo 'Expected the generated instance password' >&2; exit 1;; esac",
  "export CACHEPROG_REMOTE_STORAGE_TYPE=http",
  `export CACHEPROG_HTTP_STORAGE_BASE_URL=${quote(origin)}`,
  "export CACHEPROG_HTTP_STORAGE_EXTRA_HEADERS=\"Authorization:Bearer $EXPBUILD_CACHE_TOKEN\"",
  "unset EXPBUILD_CACHE_TOKEN",
  "EXPBUILD_GO_ROOT=\"$(mktemp -d \"${TMPDIR:-/tmp}/expbuild-go.XXXXXX\")\"",
  "EXPBUILD_GO_ROOT=\"$(cd \"$EXPBUILD_GO_ROOT\" && pwd -P)\"",
  "trap 'rm -rf -- \"$EXPBUILD_GO_ROOT\"' EXIT",
  "export CACHEPROG_ROOT_DIRECTORY=\"$EXPBUILD_GO_ROOT/helper\"",
  "export GOCACHE=\"$EXPBUILD_GO_ROOT/go-local\"",
  "export GOCACHEPROG=\"$EXPBUILD_CACHEPROG_BIN direct\"",
  "export CACHEPROG_DISABLE_PUT=true",
  "# Server readOnly remains authoritative. Enable uploads only to a writable trusted instance.",
  "if [ \"${EXPBUILD_GO_WRITE:-false}\" = true ]; then",
  "  test \"${CI:-}\" = true || { echo 'Writes require trusted CI=true' >&2; exit 1; }",
  "  export CACHEPROG_DISABLE_PUT=false",
  "fi",
  "# The helper returns local DiskPath files; keep both directories until Go exits.",
  "go build ./...",
  ")"
 ].join("\n");
}
