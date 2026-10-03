import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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

test('Maven profile validates pinned extension XML, preserves credentials and protects existing config', () => {
  const endpoint = { protocol: 'webdav', url: 'https://cache&test.example/' };
  const profile = clientProfiles('webdav-apache', '0.2.0').find(p => p.id === 'maven-build-cache');
  assert.equal(profile.version, '1.3.0');
  assert.equal(profile.status, 'experimental');
  const recipe = clientProfileExample(profile.id, endpoint, profile.version);
  assert.ok(recipe.includes('https://cache&amp;test.example/maven-build-cache'));
  assert.equal(clientProfileExample(profile.id, {protocol:'reapi',url:'grpcs://cache.test'}, profile.version),null);
  assert.equal(clientProfileExample(profile.id,endpoint,'1.2.0'),null);
  const dir = mkdtempSync(join(tmpdir(), 'expbuild-maven-recipe-'));
  try {
    mkdirSync(join(dir,'.mvn'));
    const extension = version => `<extensions xmlns="http://maven.apache.org/EXTENSIONS/1.1.0"><extension><groupId>org.apache.maven.extensions</groupId><artifactId>maven-build-cache-extension</artifactId><version>${version}</version></extension></extensions>`;
    writeFileSync(join(dir,'.mvn/extensions.xml'),extension('1.3.0'));
    const script = `mvn() {
      case "$*" in *--version*) printf 'Apache Maven 3.9.16\\n'; return;; esac
      printf '%s\\n' "args:$*" "user:$EXPBUILD_MAVEN_USER" "password:$EXPBUILD_MAVEN_PASSWORD"
      for arg in "$@"; do case "$arg" in -Dmaven.build.cache.configPath=*) cp "\${arg#*=}" captured.xml; printf '%s' "\${arg#*=}" > temp-path;; esac; done
      return \${STUB_RESULT:-0}
    }
    ${recipe}
    result=$?
    test -z "\${EXPBUILD_MAVEN_PASSWORD-}" || exit 99
    exit "$result"`;
    for (const code of [0,7]) {
      const result=spawnSync('bash',['-c',script],{cwd:dir,input:"cache\np@ss<&'$(unexpected)\n",encoding:'utf8',env:{PATH:process.env.PATH,CI:'true',STUB_RESULT:String(code)}});
      assert.equal(result.status,code,result.stderr);
      assert.ok(result.stdout.includes("password:p@ss<&'$(unexpected)"));
      assert.ok(result.stdout.includes('-Dmaven.build.cache.remote.save.enabled=false'));
      assert.ok(result.stdout.includes('-Daether.connector.http.supportWebDav=true'));
      assert.ok(result.stdout.includes('clean verify'));
      assert.equal(existsSync(readFileSync(join(dir,'temp-path'),'utf8')),false);
      const config=readFileSync(join(dir,'captured.xml'),'utf8');
      assert.ok(!config.includes('p@ss'));
      const parsed=spawnSync('python3',['-c',`import xml.etree.ElementTree as E
r=E.parse('captured.xml').getroot(); n={'c':'http://maven.apache.org/BUILD-CACHE-CONFIG/1.4.0'}
remote=r.find('c:configuration/c:remote',n)
assert remote.get('id')=='expbuild-maven' and remote.get('saveToRemote')=='false'
assert remote.find('c:url',n).text=='https://cache&test.example/maven-build-cache'
p=r.find("c:executionControl/c:reconcile/c:plugins/c:plugin[@artifactId='maven-surefire-plugin']",n)
assert p.get('goal')=='test'
assert {v.get('propertyName') for v in p.findall('c:reconciles/c:reconcile',n)}=={'skip','skipTests','skipExec'}
assert all(x.get('skipValue') is None for x in r.iter())`],{cwd:dir,encoding:'utf8'});
      assert.equal(parsed.status,0,parsed.stderr);
    }
    writeFileSync(join(dir,'.mvn/extensions.xml'),extension('1.2.0'));
    let result=spawnSync('bash',['-c',script],{cwd:dir,encoding:'utf8',env:{PATH:process.env.PATH}});
    assert.notEqual(result.status,0);assert.ok(!result.stdout.includes('args:'));
    writeFileSync(join(dir,'.mvn/extensions.xml'),extension('1.3.0'));
    writeFileSync(join(dir,'.mvn/maven-build-cache-config.xml'),'preserve me');
    result=spawnSync('bash',['-c',script],{cwd:dir,encoding:'utf8',env:{PATH:process.env.PATH}});
    assert.notEqual(result.status,0);assert.ok(!result.stdout.includes('args:'));
    assert.equal(readFileSync(join(dir,'.mvn/maven-build-cache-config.xml'),'utf8'),'preserve me');
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
