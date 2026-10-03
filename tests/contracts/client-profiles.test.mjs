import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { clientProfiles } from '../../apps/admin-api/src/client-profiles.ts';
import { clientProfileExample } from '../../apps/admin-web/src/client-profiles.ts';

const endpoints = {
  moonrepo: { protocol: 'reapi', url: 'grpcs://cache.example.test' },
  pants: { protocol: 'reapi', url: 'grpcs://cache.example.test' },
  sccache: { protocol: 'webdav', url: 'https://cache.example.test/' },
};
const credentials = "cache-user\np@ss'$(unexpected)word\n";
const basic = Buffer.from("cache-user:p@ss'$(unexpected)word").toString('base64');
function run(id, ci = '', extra = '') {
  const text = clientProfileExample(id, endpoints[id]);
  assert.ok(text);
  const stubs = `
    unexpected() { printf INJECTED; }
    pants() {
      if [ "$1" = --version ]; then printf '2.33.1\\n'; return; fi
      printf 'pants:%s provider:%s execution:%s read:%s write:%s\\n' "$*" "$PANTS_REMOTE_PROVIDER" "$PANTS_REMOTE_EXECUTION" "$PANTS_REMOTE_CACHE_READ" "$PANTS_REMOTE_CACHE_WRITE"
      printf 'headers:%s address:%s daemon:%s\\n' "$PANTS_REMOTE_STORE_HEADERS" "$PANTS_REMOTE_STORE_ADDRESS" "$PANTS_PANTSD"
    }
    sccache() {
      if [ "$1" = --version ]; then printf 'sccache 0.18.0\\n'; return; fi
      printf 'sccache:%s mode:%s prefix:%s port:%s token:%s\\n' "$*" "$SCCACHE_WEBDAV_RW_MODE" "$SCCACHE_WEBDAV_KEY_PREFIX" "$SCCACHE_SERVER_PORT" "\${SCCACHE_WEBDAV_TOKEN-unset}"
    }
    cargo() {
      printf 'cargo:%s wrapper:%s incremental:%s user:%s password:%s endpoint:%s\\n' "$*" "$RUSTC_WRAPPER" "$CARGO_INCREMENTAL" "$SCCACHE_WEBDAV_USERNAME" "$SCCACHE_WEBDAV_PASSWORD" "$SCCACHE_WEBDAV_ENDPOINT"
    }
  `;
  return spawnSync('bash', ['-c', stubs + extra + '\n' + text + '\nresult=$?; test -z "${CACHE_PASSWORD-}" || exit 99; exit "$result"'], {
    input: credentials, encoding: 'utf8',
    env: { PATH: process.env.PATH, CI: ci, SCCACHE_WEBDAV_TOKEN: 'must-not-win' },
  });
}

test('only known template versions expose experimental recipes; each has a matching generator', () => {
  for (const [name, version, id] of [
    ['bazel-remote', '0.1.0', 'pants'],
    ['webdav-apache', '0.1.0', 'sccache'],
    ['webdav-apache', '0.2.0', 'sccache'],
  ]) {
    const [profile] = clientProfiles(name, version);
    assert.equal(profile.id, id);
    assert.equal(profile.status, 'experimental');
    assert.ok(clientProfileExample(id, endpoints[id]).includes(profile.version));
    profile.version = 'mutated';
    assert.notEqual(clientProfiles(name, version)[0].version, 'mutated');
  }
  for (const [name, version] of [['bazel-remote', null], ['webdav-apache', '9.0'], ['gradle-http', '0.2.0'], ['unknown', '0.1.0']]) {
    assert.deepEqual(clientProfiles(name, version), []);
  }
});

test('profiles reject incompatible protocols, secrets, invalid paths and schemes', () => {
  for (const id of ['pants', 'sccache', 'moonrepo']) {
    for (const url of ['not-a-url', 'file:///tmp/cache', 'https://cache.test?token=secret', 'https://user:pass@cache.test', 'https://cache.test/#secret', 'https://cache.test/nested/', 'https://cache.test/\necho']) {
      assert.equal(clientProfileExample(id, { ...endpoints[id], url }), null);
    }
  }
  assert.equal(clientProfileExample('pants', endpoints.sccache), null);
  assert.equal(clientProfileExample('sccache', { protocol: 'bazel-http', url: 'https://cache.test' }), null);
  assert.equal(clientProfileExample('unknown', endpoints.pants), null);
  assert.equal(clientProfileExample('pants', endpoints.pants, '9.0'), null);
});

test('Pants Bash recipe uses Basic REAPI, keeps remote execution off and scopes credentials', () => {
  for (const ci of ['', 'false', 'true']) {
    const result = run('pants', ci);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes(`execution:false read:true write:${ci === 'true'}`));
    assert.ok(result.stdout.includes(`headers:{'authorization': 'Basic ${basic}'}`), result.stdout);
    assert.ok(result.stdout.includes('address:grpcs://cache.example.test daemon:false'));
    assert.ok(result.stdout.includes('pants:test :: provider:reapi'));
    assert.ok(result.stdout.includes('pants:package :: provider:reapi'));
    assert.ok(!result.stdout.includes('INJECTED'));
  }
});

test('sccache Bash recipe preserves opaque credentials and starts an isolated daemon', () => {
  for (const ci of ['', 'false', 'true']) {
    const result = run('sccache', ci);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes(`mode:${ci === 'true' ? 'READ_WRITE' : 'READ_ONLY'} prefix:sccache/ port:4227 token:unset`));
    assert.ok(result.stdout.includes("wrapper:sccache incremental:0 user:cache-user password:p@ss'$(unexpected)word"));
    assert.ok(result.stdout.includes('endpoint:https://cache.example.test/'));
    assert.ok(result.stdout.includes('sccache:--start-server'));
    assert.ok(result.stdout.includes('sccache:--show-stats'));
    assert.ok(!result.stdout.includes('INJECTED'));
  }
});

test('version mismatch stops before either build and daemon startup failure cannot run Cargo', () => {
  let result = run('pants', '', "pants() { printf '2.32.0\\n'; }");
  assert.notEqual(result.status, 0);
  assert.ok(!result.stdout.includes('pants:test'));
  result = run('sccache', '', "sccache() { if [ \"$1\" = --version ]; then printf 'sccache 0.18.0\\n'; else return 7; fi; }");
  assert.equal(result.status, 7);
  assert.ok(!result.stdout.includes('cargo:'));
});

// No moon binary is used: exercise generated Bash + Python against real files.
const moonConfig = JSON.parse(readFileSync(new URL('../../docs/k8s-platform/moonrepo.md', import.meta.url), 'utf8').match(/```json\n([\s\S]+?)\n```/)[1]);
function runMoon({ env = {}, change, version = 'moon 2.5.6', exit = 0 } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'expbuild-moon-'));
  try {
    mkdirSync(join(directory, '.moon'));
    const config = structuredClone(moonConfig);
    change?.(config, directory);
    const path = join(directory, '.moon/workspace.json');
    writeFileSync(path, JSON.stringify(config));
    const before = readFileSync(path, 'utf8');
    const recipe = clientProfileExample('moonrepo', endpoints.moonrepo, '2.5.6');
    const stub = `moon() {
      if [ "$1" = --version ]; then printf '%s\\n' '${version}'; return; fi
      printf 'args:%s\\nmode:%s host:%s auth:%s daemon:%s\\n' "$*" "$MOON_CACHE" "$MOON_REMOTE_HOST" "$EXPBUILD_MOON_AUTHORIZATION" "$MOON_DAEMON"
      return ${exit}
    }\nunexpected() { printf INJECTED; }\n`;
    const result = spawnSync('bash', ['-c', stub + recipe + '\nresult=$?; test -z "${EXPBUILD_MOON_AUTHORIZATION-}" || exit 99; exit "$result"'], {
      input: credentials, encoding: 'utf8', cwd: directory,
      env: { PATH: process.env.PATH, ...env },
    });
    assert.equal(readFileSync(path, 'utf8'), before, 'must not rewrite project config');
    return result;
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

test('moonrepo API profile matches the pinned REAPI generator and rejects other transports', () => {
  const profile = clientProfiles('bazel-remote', '0.1.0').find(p => p.id === 'moonrepo');
  assert.deepEqual(profile, { id: 'moonrepo', protocol: 'reapi', version: '2.5.6', status: 'experimental' });
  assert.ok(clientProfileExample(profile.id, endpoints.moonrepo, profile.version).includes('moon 2.5.6'));
  assert.equal(clientProfileExample('moonrepo', endpoints.sccache, '2.5.6'), null);
  assert.equal(clientProfileExample('moonrepo', endpoints.moonrepo, '2.5.5'), null);
  assert.ok(clientProfileExample('moonrepo', { protocol: 'reapi', url: 'grpc://cache.test:9092' }));
});

test('moonrepo default global read mode survives CI variants and keeps Basic auth scoped', () => {
  for (const env of [{}, { CI: 'false' }, { CI: 'true' }, { CI_NAME: 'some-runner' }, { AZURE_PIPELINES: 'false' }]) {
    const result = runMoon({ env });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes('args:--log warn --cache read run app:build'), result.stdout);
    assert.ok(result.stdout.includes(`mode:read host:grpcs://cache.example.test auth:Basic ${basic} daemon:false`));
    assert.ok(!result.stdout.includes('INJECTED'));
    assert.ok(!result.stderr.includes(basic));
  }
});

test('moonrepo writes require both explicit opt-in and CI=true; task failures propagate', () => {
  const success = runMoon({ env: { EXPBUILD_MOON_WRITE: 'true', CI: 'true' } });
  assert.equal(success.status, 0, success.stderr);
  assert.ok(success.stdout.includes('--cache read-write run app:build'));
  for (const env of [{ EXPBUILD_MOON_WRITE: 'true' }, { EXPBUILD_MOON_WRITE: 'true', CI: 'false' }, { EXPBUILD_MOON_WRITE: 'yes', CI: 'true' }]) {
    const result = runMoon({ env });
    assert.notEqual(result.status, 0);
    assert.ok(!result.stdout.includes('args:'));
  }
  assert.equal(runMoon({ exit: 7 }).status, 7);
  const mismatch = runMoon({ version: 'moon 2.5.5' });
  assert.notEqual(mismatch.status, 0);
  assert.ok(!mismatch.stdout.includes('args:'));
});

test('moonrepo preflight rejects config/auth ambiguity and overrides before invoking client', () => {
  const changes = [
    c => { c.versionConstraint = '^2.5.6'; },
    (_, d) => { mkdirSync(join(d, 'node_modules/@moonrepo/cli'), { recursive: true }); },
    c => { c.remote.auth.token = 'TOKEN'; },
    c => { c.remote.auth.headers.authorization = 'literal-secret'; },
    c => { c.remote.cache.verifyIntegrity = false; },
    c => { c.remote.cache.compression = 'zstd'; },
    c => { c.remote.cache.localReadOnly = false; },
    c => { c.remote.api = 'http'; },
    c => { c.extends = './other.json'; },
    c => { c.pipeline.installDependencies = true; },
    (_, d) => { writeFileSync(join(d, '.moon/workspace.yml'), '{}'); },
    (_, d) => { mkdirSync(join(d, '.config/moon'), { recursive: true }); },
    (_, d) => { writeFileSync(join(d, 'other.json'), '{}'); symlinkSync(join(d, 'other.json'), join(d, '.moon/workspace.json')); },
  ];
  for (const change of changes) {
    const result = runMoon({ change });
    assert.notEqual(result.status, 0, result.stdout);
    assert.ok(!result.stdout.includes('args:'));
  }
  for (const key of ['MOON_REMOTE_AUTH_TOKEN', 'MOON_CACHE', 'MOON_WORKSPACE_ROOT', 'MOON_DAEMON_RUNNING', 'MOON_DEBUG_PROCESS_ENV', 'STARBASE_LOG', 'WARPGATE_LOG']) {
    const result = runMoon({ env: { [key]: 'unexpected' } });
    assert.notEqual(result.status, 0);
    assert.ok(!result.stdout.includes('args:'));
  }
});
