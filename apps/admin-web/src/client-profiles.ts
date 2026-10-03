// Pure recipes can be exercised with stub clients without a running cache.
// Keep versions aligned with the API profiles; no recipe is a certification.
type Endpoint = { protocol: string; url: string };
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
export function clientProfileExample(id: string, endpoint: Endpoint, version?: string): string | null {
  if (version !== undefined && version !== ({ pants: "2.33.1", sccache: "0.18.0", moonrepo: "2.5.6" } as Record<string, string>)[id]) return null;
  let url: URL;
  try { url = new URL(endpoint.url); } catch { return null; }
  if (!url.hostname || url.username || url.password || url.search || url.hash ||
      /\s/.test(endpoint.url) || (url.pathname && url.pathname !== "/")) return null;
  const sccache = id === "sccache" && endpoint.protocol === "webdav" && ["http:", "https:"].includes(url.protocol);
  const pants = id === "pants" && endpoint.protocol === "reapi" && ["grpc:", "grpcs:"].includes(url.protocol);
  const moon = id === "moonrepo" && endpoint.protocol === "reapi" && ["grpc:", "grpcs:"].includes(url.protocol);
  if (!sccache && !pants && !moon) return null;
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
