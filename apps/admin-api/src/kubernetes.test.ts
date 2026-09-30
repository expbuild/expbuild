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
    assert.ok(!request.url!.startsWith('//'), 'SDK base URL must not produce a double-slash API path');
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    if (body) bodies.push(body);
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(body ?? { metadata: { labels: { 'app.kubernetes.io/managed-by': 'expbuild', 'cache.expbuild.io/project-id': 'project' } } }));
  });
  try {
    fixture.config.getCurrentCluster()!.server += '/';
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

test('retained volume cleanup fences identity, ownership, active instances and every Pod reference', async () => {
  const identity = { namespace: 'demo', name: 'c-instance', projectId: 'project', instanceId: 'instance', instanceUid: 'original-cr' };
  const labels = { 'app.kubernetes.io/managed-by': 'expbuild', 'cache.expbuild.io/project-id': 'project', 'cache.expbuild.io/instance-id': 'instance', 'cache.expbuild.io/instance-uid': 'original-cr' };
  const claim = { metadata: { name: 'c-instance-data', namespace: 'demo', uid: 'volume-uid', resourceVersion: '42', labels, ownerReferences: [] as any[] }, spec: { resources: { requests: { storage: '10Gi' } }, storageClassName: 'standard' }, status: { phase: 'Bound' } };
  let exists = true, instanceExists = false, pods: any[] = [], namespaceProject = 'project';
  const deletes: any[] = [];
  const fixture = await endpoint(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    const notFound = () => { response.statusCode = 404; response.end(JSON.stringify({ kind: 'Status', code: 404 })); };
    if (request.method === 'DELETE') {
      assert.equal(request.url, '/api/v1/namespaces/demo/persistentvolumeclaims/c-instance-data');
      let raw = ''; for await (const part of request) raw += part;
      deletes.push(JSON.parse(raw)); exists = false; response.end(JSON.stringify({ kind: 'Status', status: 'Success' })); return;
    }
    if (request.url === '/api/v1/namespaces/demo') response.end(JSON.stringify({ metadata: { labels: { 'app.kubernetes.io/managed-by': 'expbuild', 'cache.expbuild.io/project-id': namespaceProject } } }));
    else if (request.url?.includes('/persistentvolumeclaims/')) { if (exists) response.end(JSON.stringify(claim)); else notFound(); }
    else if (request.url?.endsWith('/pods')) response.end(JSON.stringify({ items: pods }));
    else if (request.url?.includes('/cacheinstances/')) { if (instanceExists) response.end(JSON.stringify({ metadata: { uid: 'recreated-cr' } })); else notFound(); }
    else { assert.fail('Unexpected request: ' + request.url); }
  });
  try {
    const client = new KubernetesClient(fixture.config);
    const rejects = (code: string) => assert.rejects(client.deleteRetainedVolume(identity, 'volume-uid'), (e: unknown) => e instanceof OperationError && e.code === code);
    assert.equal((await client.getRetainedVolume(identity))?.capacity, '10Gi');
    namespaceProject = 'other'; await rejects('namespace_ownership_conflict'); namespaceProject = 'project';
    labels['cache.expbuild.io/instance-uid'] = 'other-cr'; await rejects('volume_ownership_conflict'); labels['cache.expbuild.io/instance-uid'] = 'original-cr';
    claim.metadata.ownerReferences = [{ uid: 'owner' }]; await rejects('volume_ownership_conflict'); claim.metadata.ownerReferences = [];
    claim.metadata.uid = 'replacement-volume'; await rejects('volume_identity_conflict'); claim.metadata.uid = 'volume-uid';
    instanceExists = true; await rejects('volume_instance_exists'); instanceExists = false;
    pods = [{ spec: { volumes: [{ persistentVolumeClaim: { claimName: claim.metadata.name } }] } }]; await rejects('volume_in_use'); pods = [];
    assert.equal(deletes.length, 0);
    await client.deleteRetainedVolume(identity, 'volume-uid');
    assert.deepEqual(deletes[0].preconditions, { uid: 'volume-uid', resourceVersion: '42' });
    assert.equal(await client.getRetainedVolume(identity), null);
    await client.deleteRetainedVolume(identity, 'volume-uid');
    assert.equal(deletes.length, 1, 'missing volume replay must not delete anything else');
  } finally { await fixture.close(); }
});

test('project ResourceQuota reconciles quantities, rejects foreign ownership and fences writes', async () => {
  const limits = {instances:2,storageGiB:4,cpuMillis:1000,memoryMiB:1024};
  let current: any = null, foreignNamespace = false;
  const writes: {method:string;body:any}[] = [];
  const fixture = await endpoint(async (request,response)=>{
    let raw=''; for await(const chunk of request) raw+=chunk;
    const body=raw?JSON.parse(raw):undefined;
    response.setHeader('Content-Type','application/json');
    if(request.url==='/api/v1/namespaces/project-test') {
      response.end(JSON.stringify({metadata:{labels:{'app.kubernetes.io/managed-by':'expbuild','cache.expbuild.io/project-id':foreignNamespace?'foreign':'project'}}})); return;
    }
    if(request.method==='GET') {
      if(!current) { response.statusCode=404; response.end(JSON.stringify({code:404})); }
      else response.end(JSON.stringify(current));
      return;
    }
    writes.push({method:request.method!,body});
    if(request.method==='DELETE') { current=null; response.end(JSON.stringify({status:'Success'})); return; }
    current={...body,metadata:{...body.metadata,uid:'quota-uid',resourceVersion:'9'}};
    response.end(JSON.stringify(current));
  });
  const allNull={instances:null,storageGiB:null,cpuMillis:null,memoryMiB:null};
  try {
    const kube = new KubernetesClient(fixture.config);
    assert.equal(await kube.ensureProjectQuota('project-test','project','1',limits),false);
    assert.equal(writes.length,1);
    assert.deepEqual(current.spec.hard,{'count/cacheinstances.cache.expbuild.io':'2','requests.storage':'4Gi','requests.cpu':'1000m','limits.cpu':'1000m','requests.memory':'1024Mi','limits.memory':'1024Mi'});
    // Kubernetes canonicalizes equivalent quantities. Reconciliation must be idle.
    current.spec.hard['requests.cpu']='1'; current.spec.hard['limits.memory']='1Gi';
    current.status={hard:structuredClone(current.spec.hard),used:Object.fromEntries(Object.keys(current.spec.hard).map(key=>[key,'0']))};
    assert.equal(await kube.ensureProjectQuota('project-test','project','1',limits),true);
    assert.equal(writes.length,1,'equivalent quantities must not cause writes');
    delete current.status.used['requests.storage'];
    assert.equal(await kube.ensureProjectQuota('project-test','project','1',limits),false,'incomplete accounting is not ready');
    assert.equal(await kube.ensureProjectQuota('project-test','project','2',{...limits,cpuMillis:2000}),false);
    assert.equal(writes[1].method,'PUT');
    assert.equal(writes[1].body.metadata.uid,'quota-uid');
    assert.equal(writes[1].body.metadata.resourceVersion,'9');
    await assert.rejects(kube.ensureProjectQuota('project-test','project','1',limits), /quota_revision_conflict/);
    current.metadata.labels['cache.expbuild.io/project-id']='foreign';
    await assert.rejects(kube.ensureProjectQuota('project-test','project','2',allNull), /quota_ownership_conflict/);
    current.metadata.labels['cache.expbuild.io/project-id']='project';
    current.spec.scopes=['BestEffort'];
    await assert.rejects(kube.ensureProjectQuota('project-test','project','2',allNull), /quota_scope_conflict/);
    delete current.spec.scopes;
    foreignNamespace=true;
    await assert.rejects(kube.ensureProjectQuota('project-test','project','2',limits), /namespace_ownership_conflict/);
    foreignNamespace=false;
    assert.equal(await kube.ensureProjectQuota('project-test','project','3',allNull),false);
    assert.deepEqual(writes.at(-1)!.body.preconditions,{uid:'quota-uid',resourceVersion:'9'});
    assert.equal(await kube.ensureProjectQuota('project-test','project','3',allNull),true);
    assert.equal(writes.length,3,'conflicts must not mutate resources');
  } finally { await fixture.close(); }
});

test('resource inventory reads complete paginated lists and refuses truncation or namespace replacement', async()=>{
  let mode='normal', namespaceReads=0, mutations=0;
  const seen:string[]=[];
  const fixture=await endpoint((request,response)=>{
    if(request.method!=='GET')mutations++;
    const url=new URL(request.url!,'http://fixture');seen.push(request.url!);
    response.setHeader('Content-Type','application/json');
    if(url.pathname==='/api/v1/namespaces/inventory-test'){
      namespaceReads++;
      response.end(JSON.stringify({metadata:{uid:mode==='replacement'&&namespaceReads%2===0?'replacement':'namespace-uid',labels:{'app.kubernetes.io/managed-by':'expbuild','cache.expbuild.io/project-id':'project'}}}));return;
    }
    assert.equal(url.searchParams.get('limit'),'200');
    const next=url.searchParams.get('continue');
    if(url.pathname.endsWith('/cacheinstances')){
      response.end(JSON.stringify({metadata:{continue:next?'':'next-instance-page'},items:next?[]:[{metadata:{name:'c-existing'}}]}));return;
    }
    response.end(JSON.stringify({metadata:{continue:mode==='overflow'?'repeat':next?'':'next-volume-page'},items:next?[]:[{metadata:{name:'c-existing-data'}}]}));
  });
  try{
    const kube=new KubernetesClient(fixture.config);
    const result=await kube.inspectProjectResources('inventory-test','project');
    assert.equal(result.instances.length,1);assert.equal(result.volumes.length,1);
    assert.ok(seen.some(path=>path.includes('continue=next-instance-page')));
    assert.ok(seen.some(path=>path.includes('continue=next-volume-page')));
    mode='overflow';await assert.rejects(kube.inspectProjectResources('inventory-test','project'),/inventory_limit_exceeded/);
    mode='replacement';namespaceReads=0;
    await assert.rejects(kube.inspectProjectResources('inventory-test','project'),/namespace_changed_during_scan/);
    assert.equal(mutations,0);
  }finally{await fixture.close();}
});
