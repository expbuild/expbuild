import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { instanceInput, desiredObject } from './instance-contract.js';
import { templateCatalog, templateDefinition, templateEnabled } from './template-catalog.js';

test('catalog keeps deployment availability separate from existing template maintenance', () => {
  assert.deepEqual(templateCatalog({}).map(t => t.name), ['bazel-remote']);
  assert.equal(templateEnabled('webdav-apache', {}), false);
  assert.equal(templateEnabled('webdav-apache', { webdavEnabled: true }), true);
  assert.equal(templateEnabled('gradle-http', {}), false);
  assert.equal(templateEnabled('gradle-http', { gradleEnabled: true }), true);
  const input = instanceInput.parse({ name: 'Retained DAV', template: 'webdav-apache', storageGiB: 3, cacheGiB: 0, desiredState: 'Suspended' });
  const desired = desiredObject(input, 'project', 'namespace', 'instance', 'standard', 'operation', 'hash');
  assert.deepEqual(desired.spec.templateRef, { name: 'webdav-apache', version: '0.2.0' });
  assert.equal(desired.spec.desiredState, 'Suspended');
  assert.equal(desired.spec.eviction.enginePolicy, 'none');
  for (const name of ['unknown', '__proto__', 'constructor']) {
    assert.throws(() => templateDefinition(name), /Unsupported template/);
  }
  assert.throws(() => templateDefinition('bazel-remote', 'latest'), /Unsupported template/);
  assert.equal(templateDefinition('webdav-apache', '0.1.0').capabilities.statistics, false);
  assert.throws(() => templateDefinition('webdav-apache', '0.3.0'), /Unsupported template/);
  const gradle = instanceInput.parse({ name: 'Gradle', template: 'gradle-http', storageGiB: 3, cacheGiB: 1 });
  assert.deepEqual(desiredObject(gradle, 'project', 'namespace', 'instance', 'standard', 'operation', 'hash').spec.templateRef, { name: 'gradle-http', version: '0.2.0' });
});

test('published configuration contracts and generated instances match each registered template', () => {
  const catalog = templateCatalog({ webdavEnabled: true, gradleEnabled: true, gatewayEnabled: true });
  for (const template of catalog) {
    const input = instanceInput.parse({ name: 'CI', template: template.name, storageGiB: 3, cacheGiB: template.capabilities.capacity ? 1 : 0 });
    const desired = desiredObject(input, 'project', 'namespace', 'instance', 'standard', 'operation', 'hash');
    assert.deepEqual(desired.spec.templateRef, { name: template.name, version: template.version });
    assert.equal(desired.spec.eviction.enginePolicy === 'lru', template.capabilities.lru);
    assert.deepEqual(template.exposures, ['ClusterInternal', 'Gateway']);
    const schema = template.inputSchema as { properties: Record<string, { const?: unknown }>; additionalProperties?: boolean };
    assert.equal(schema.properties.template?.const, template.name);
    assert.equal(schema.additionalProperties, false);
    assert.equal(instanceInput.safeParse({ ...input, image: 'arbitrary:latest' }).success, false);
    assert.equal(instanceInput.safeParse({ ...input, cacheGiB: 3 }).success, false);
  }
  // A caller editing its response must not alter subsequent catalogs.
  catalog[0]!.protocols.length = 0;
  catalog[0]!.exposures.push('invalid');
  assert.deepEqual(templateCatalog({})[0]!.protocols, ['reapi', 'bazel-http']);
  assert.deepEqual(templateCatalog({})[0]!.exposures, ['ClusterInternal']);
});

test('API definitions satisfy the shared Operator template fixtures', () => {
  const fixtures = JSON.parse(readFileSync(new URL('../../../tests/contracts/templates.json', import.meta.url), 'utf8')) as Array<{name:string;version:string;enginePolicy:string;storageGiB:number;cacheGiB:number;protocols:string[];statistics:boolean}>;
  const catalog = templateCatalog({ webdavEnabled: true, gradleEnabled: true });
  assert.deepEqual(catalog.map(t => t.name).sort(), fixtures.filter(f => f.name === 'bazel-remote' || f.version === '0.2.0').map(t => t.name).sort());
  for (const fixture of fixtures) {
    if (fixture.name === 'gradle-http' && fixture.version === '0.1.0') {
      assert.equal(templateDefinition(fixture.name, fixture.version).capabilities.lookupHistory, false);
      continue;
    }
    if (fixture.name === 'webdav-apache' && fixture.version === '0.1.0') {
      assert.equal(templateDefinition(fixture.name, fixture.version).capabilities.statistics, false);
      continue;
    }
    const input = instanceInput.parse({ name: 'Contract', template: fixture.name, storageGiB: fixture.storageGiB, cacheGiB: fixture.cacheGiB });
    const desired = desiredObject(input, 'project', 'namespace', 'instance', 'standard', 'operation', 'hash');
    assert.deepEqual(desired.spec.templateRef, { name: fixture.name, version: fixture.version });
    assert.equal(desired.spec.eviction.enginePolicy, fixture.enginePolicy);
    assert.deepEqual(catalog.find(t => t.name === fixture.name)!.protocols, fixture.protocols);
    assert.equal(catalog.find(t => t.name === fixture.name)!.capabilities.statistics, fixture.statistics);
  }
});

test('catalog exposes configuration profiles separately from engine capabilities', () => {
  const catalog = templateCatalog({ webdavEnabled: true, gradleEnabled: true });
  assert.deepEqual(catalog.find(t => t.name === 'bazel-remote')!.clientProfiles,
    [{ id: 'pants', protocol: 'reapi', version: '2.33.1', status: 'experimental' }]);
  assert.deepEqual(catalog.find(t => t.name === 'webdav-apache')!.clientProfiles,
    [{ id: 'sccache', protocol: 'webdav', version: '0.18.0', status: 'experimental' }, { id: 'maven-build-cache', protocol: 'webdav', version: '1.3.0', status: 'experimental' }]);
  assert.deepEqual(catalog.find(t => t.name === 'gradle-http')!.clientProfiles, []);
});
