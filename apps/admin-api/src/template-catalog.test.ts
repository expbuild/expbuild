import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { instanceInput, desiredObject } from './instance-contract.js';
import { templateCatalog, templateDefinition, templateEnabled } from './template-catalog.js';

test('catalog keeps deployment availability separate from existing template maintenance', () => {
  assert.deepEqual(templateCatalog({}).map(t => t.name), ['bazel-remote']);
  assert.equal(templateEnabled('webdav-apache', {}), false);
  assert.equal(templateEnabled('webdav-apache', { webdavEnabled: true }), true);
  const input = instanceInput.parse({ name: 'Retained DAV', template: 'webdav-apache', storageGiB: 3, cacheGiB: 0, desiredState: 'Suspended' });
  const desired = desiredObject(input, 'project', 'namespace', 'instance', 'standard', 'operation', 'hash');
  assert.deepEqual(desired.spec.templateRef, { name: 'webdav-apache', version: '0.1.0' });
  assert.equal(desired.spec.desiredState, 'Suspended');
  assert.equal(desired.spec.eviction.enginePolicy, 'none');
  for (const name of ['unknown', '__proto__', 'constructor']) {
    assert.throws(() => templateDefinition(name), /Unsupported template/);
  }
  assert.throws(() => templateDefinition('bazel-remote', 'latest'), /Unsupported template/);
  assert.throws(() => templateDefinition('webdav-apache', '0.2.0'), /Unsupported template/);
});

test('published configuration contracts and generated instances match each registered template', () => {
  const catalog = templateCatalog({ webdavEnabled: true, gatewayEnabled: true });
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
  const catalog = templateCatalog({ webdavEnabled: true });
  assert.deepEqual(catalog.map(t => t.name).sort(), fixtures.map(t => t.name).sort());
  for (const fixture of fixtures) {
    const input = instanceInput.parse({ name: 'Contract', template: fixture.name, storageGiB: fixture.storageGiB, cacheGiB: fixture.cacheGiB });
    const desired = desiredObject(input, 'project', 'namespace', 'instance', 'standard', 'operation', 'hash');
    assert.deepEqual(desired.spec.templateRef, { name: fixture.name, version: fixture.version });
    assert.equal(desired.spec.eviction.enginePolicy, fixture.enginePolicy);
    assert.deepEqual(catalog.find(t => t.name === fixture.name)!.protocols, fixture.protocols);
    assert.equal(catalog.find(t => t.name === fixture.name)!.capabilities.statistics, fixture.statistics);
  }
});
