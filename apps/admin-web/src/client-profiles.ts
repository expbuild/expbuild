// Pure recipes can be exercised with stub clients without a running cache.
// Keep versions aligned with the API profiles; no recipe is a certification.
type Endpoint = { protocol: string; url: string };
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
export function clientProfileExample(id: string, endpoint: Endpoint, version?: string): string | null {
  if (version !== undefined && version !== ({ pants: "2.33.1", sccache: "0.18.0", nx: "22.7.12" } as Record<string, string>)[id]) return null;
  let url: URL;
  try { url = new URL(endpoint.url); } catch { return null; }
  if (!url.hostname || url.username || url.password || url.search || url.hash ||
      /\s/.test(endpoint.url) || (url.pathname && url.pathname !== "/")) return null;
  const sccache = id === "sccache" && endpoint.protocol === "webdav" && ["http:", "https:"].includes(url.protocol);
  const pants = id === "pants" && endpoint.protocol === "reapi" && ["grpc:", "grpcs:"].includes(url.protocol);
  const nx = id === "nx" && endpoint.protocol === "nx-http" && ["http:", "https:"].includes(url.protocol);
  if (!sccache && !pants && !nx) return null;
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
