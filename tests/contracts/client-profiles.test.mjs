import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { clientProfiles } from '../../apps/admin-api/src/client-profiles.ts';
import { clientProfileExample } from '../../apps/admin-web/src/client-profiles.ts';

const endpoints = {
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
  for (const id of ['pants', 'sccache']) {
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
