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
