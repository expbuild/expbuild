import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { KubeConfig } from '@kubernetes/client-node';
import { KubernetesClient } from './kubernetes.js';
import { desiredObject, instanceInput } from './instance-contract.js';
import { OperationError } from './errors.js';

async function endpoint(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const config = new KubeConfig();
  config.loadFromOptions({ clusters: [{ name: 'test', server: `http://127.0.0.1:${address.port}`, skipTLSVerify: true }], users: [{ name: 'test' }], contexts: [{ name: 'test', user: 'test', cluster: 'test' }], currentContext: 'test' });
  return { config, close: () => new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }) };
}

test('Kubernetes SDK serializes NetworkPolicy source restrictions to the wire', async () => {
  const bodies: any[] = [];
  const fixture = await endpoint(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    if (body) bodies.push(body);
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(body ?? { metadata: { labels: { 'app.kubernetes.io/managed-by': 'expbuild', 'cache.expbuild.io/project-id': 'project' } } }));
  });
  try {
    await new KubernetesClient(fixture.config).ensureProject('test-project', 'project');
    const policy = bodies.find(body => body.kind === 'NetworkPolicy');
    assert.deepEqual(policy.spec.ingress, [{ from: [{ namespaceSelector: { matchLabels: { 'cache.expbuild.io/control-plane': 'true' } } }] }]);
    assert.deepEqual(policy.spec.policyTypes, ['Ingress']);
    assert.equal(policy.spec.ingress[0]._from, undefined);
    const access = bodies.find(body => body.metadata?.name === 'expbuild-client-access');
    assert.deepEqual(access.spec.ingress[0].from, [{
      namespaceSelector: { matchLabels: { 'cache.expbuild.io/access-project': 'true' } },
      podSelector: { matchLabels: { 'cache.expbuild.io/client': 'true' } },
    }]);
    assert.deepEqual(access.spec.ingress[0].ports, [{ protocol: 'TCP', port: 8080 }, { protocol: 'TCP', port: 9092 }]);
    assert.equal(access.spec.podSelector.matchLabels['cache.expbuild.io/project-id'], 'project');

  } finally { await fixture.close(); }
});

test('stalled Kubernetes responses are aborted rather than holding a worker forever', async () => {
  const fixture = await endpoint(() => {});
  try {
    await assert.rejects(new KubernetesClient(fixture.config, 50).getInstance('demo', 'cache'), (error: unknown) => error instanceof Error && error.name === 'TimeoutError');
  } finally { await fixture.close(); }
});

test('replayed operations cannot accept externally changed configuration', async () => {
  const desired = desiredObject(instanceInput.parse({ name: 'cache', storageGiB: 10, cacheGiB: 8 }), 'project', 'demo', 'instance', 'standard', 'op', 'hash');
  const current = structuredClone(desired);
  current.metadata.uid = 'uid'; current.metadata.generation = 2;
  current.spec.eviction.maxCacheGiB = 7;
  const fixture = await endpoint((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.method === 'POST') { response.statusCode = 409; response.end(JSON.stringify({ kind: 'Status', code: 409, reason: 'AlreadyExists' })); }
    else response.end(JSON.stringify(current));
  });
  try {
    const client = new KubernetesClient(fixture.config);
    const superseded = (error: unknown) => error instanceof OperationError && error.superseded;
    await assert.rejects(client.createInstance(desired), superseded);
    await assert.rejects(client.updateInstance(desired, 'uid:1'), superseded);
  } finally { await fixture.close(); }
});

test('existing client access policy must match ownership and exact access rules', async () => {
  const stored = new Map<string, any>();
  const fixture = await endpoint(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    response.setHeader('Content-Type', 'application/json');
    if (request.method === 'POST') {
      const key = `${request.url}/${body.metadata.name}`;
      if (stored.has(key)) { response.statusCode = 409; response.end(JSON.stringify({ kind: 'Status', code: 409 })); return; }
      stored.set(key, body); response.end(JSON.stringify(body)); return;
    }
    const object = stored.get(request.url!);
    if (!object) { response.statusCode = 404; response.end(JSON.stringify({ kind: 'Status', code: 404 })); return; }
    response.end(JSON.stringify(object));
  });
  try {
    const client = new KubernetesClient(fixture.config);
    await client.ensureProject('demo', 'project');
    await client.ensureProject('demo', 'project');
    const policy = [...stored.values()].find(x => x.metadata.name === 'expbuild-client-access');
    const saved = structuredClone(policy);
    policy.spec.ingress[0].from = [{}];
    await assert.rejects(client.ensureProject('demo', 'project'), (e: unknown) => e instanceof OperationError && e.code === 'client_policy_configuration_conflict');
    policy.spec = saved.spec;
    policy.metadata.labels['cache.expbuild.io/project-id'] = 'other';
    await assert.rejects(client.ensureProject('demo', 'project'), (e: unknown) => e instanceof OperationError && e.code === 'policy_ownership_conflict');
  } finally { await fixture.close(); }
});
