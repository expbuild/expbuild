import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { buildApp } from './app.js';
import { createPool, migrate } from './db.js';
import { hashPassword } from './security.js';
import { OperationWorker } from './worker.js';
import { OperationError } from './errors.js';
import { revision, type CacheObject } from './instance-contract.js';
import type { CredentialData, KubernetesPort, RetainedVolume } from './kubernetes.js';

// This fake models API persistence and lost responses, not kubelet behavior.
class Cluster implements KubernetesPort {
  volume: RetainedVolume | null = null;
  loseVolumeDeleteResponse = false;
  async getRetainedVolume() { return structuredClone(this.volume); }
  async deleteRetainedVolume(_identity: unknown, uid: string) {
    if (this.volume && this.volume.uid !== uid) throw new OperationError('volume_identity_conflict');
    this.volume = null;
    if (this.loseVolumeDeleteResponse) { this.loseVolumeDeleteResponse = false; throw new Error('delete response lost'); }
  }
  objects = new Map<string, CacheObject>();
  secrets = new Map<string, CredentialData>();
  loseCreateResponse = true;
  creations = 0;
  loseUpdateResponse = false;
  onProject?: () => Promise<void>;
  async ensureProject() { await this.onProject?.(); }
  async ensureCredentials(ns: string, name: string, _p: string, _i: string, _op: string, data: CredentialData) {
    const key = `${ns}/${name}`, previous = this.secrets.get(key);
    if (previous) assert.deepEqual(previous, data, 'retry must reuse original credentials');
    this.secrets.set(key, structuredClone(data));
  }
  async getInstance(ns: string, name: string) { return structuredClone(this.objects.get(`${ns}/${name}`) ?? null); }
  async createInstance(desired: CacheObject) {
    const key = `${desired.metadata.namespace}/${desired.metadata.name}`;
    if (!this.objects.has(key)) {
      const object = structuredClone(desired);
      object.metadata.uid = randomUUID(); object.metadata.generation = 1;
      this.objects.set(key, object); this.creations++;
    }
    if (this.loseCreateResponse) { this.loseCreateResponse = false; throw new Error('response lost after persistence'); }
    return structuredClone(this.objects.get(key)!);
  }
  async updateInstance(desired: CacheObject, expected: string) {
    const key = `${desired.metadata.namespace}/${desired.metadata.name}`, old = this.objects.get(key)!;
    if (old.metadata.annotations?.['cache.expbuild.io/operation-id'] === desired.metadata.annotations?.['cache.expbuild.io/operation-id']) return structuredClone(old);
    if (revision(old) !== expected) throw new OperationError('instance_version_conflict', true);
    const next = structuredClone(desired);
    next.metadata.uid = old.metadata.uid; next.metadata.generation = old.metadata.generation! + 1;
    this.objects.set(key, next);
    if(this.loseUpdateResponse){this.loseUpdateResponse=false;throw new Error('update response lost');}
    return structuredClone(next);
  }
  async deleteInstance(ns: string, name: string, uid: string) {
    const key = `${ns}/${name}`, old = this.objects.get(key);
    if (old && old.metadata.uid !== uid) throw new OperationError('instance_identity_conflict');
    this.objects.delete(key);
  }
  async deleteCredentials(ns: string, name: string) { this.secrets.delete(`${ns}/${name}`); }
  ready() {
    for (const object of this.objects.values()) object.status = {
      observedGeneration: object.metadata.generation,
      conditions: [{ type: 'Ready', observedGeneration: object.metadata.generation,
        status: object.spec.desiredState === 'Suspended' ? 'False' : 'True',
        reason: object.spec.desiredState === 'Suspended' ? 'Suspended' : 'Ready' }],
    };
  }
}

test('instance queue recovers a lost create response, serializes updates and retains deleted storage', { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const root = createPool(process.env.TEST_DATABASE_URL!), database = `expbuild_test_${randomUUID().replaceAll('-', '')}`;
  await root.query(`CREATE DATABASE "${database}"`);
  const url = new URL(process.env.TEST_DATABASE_URL!); url.pathname = `/${database}`;
  const pool = createPool(url.toString()), kube = new Cluster(), key = randomBytes(32);
  const origin = 'http://localhost:5173';
  let statisticsCalls=0;
  const historyTargets: {projectId: string; instanceUID: string}[] = [];
  const app = await buildApp(pool, { origin, secureCookies: false, kube, encryptionKey: key, storageClass: 'test',history:{read:async(target,window)=>{historyTargets.push(target);return {source:'prometheus',metric:'cache-lookups',window,start:0,end:1,stepSeconds:60,rateWindowSeconds:300,series:[]};}},statistics:{readStatistics:async()=>{statisticsCalls++;return {source:'bazel-remote-status',observedAt:new Date().toISOString(),usedBytes:1024,capacityBytes:8589934592,itemCount:2,reservedBytes:null,uncompressedBytes:null};}} });
  const worker = new OperationWorker(pool, kube, key);
  const tick = async () => {
    await pool.query("UPDATE operations SET next_attempt_at=now()-interval '1 second'");
    assert.equal(await worker.tick(), true);
  };
  try {
    await migrate(pool);
    const password = 'integration-test-password';
    await pool.query('INSERT INTO users(id,email,password_hash,platform_admin) VALUES($1,$2,$3,true)', [randomUUID(), 'admin@test.local', await hashPassword(password)]);
    const login = await app.inject({ method: 'POST', url: '/v1/auth/login', headers: { origin }, payload: { email: 'admin@test.local', password } });
    assert.equal(login.statusCode, 200, login.body);
    const headers = { origin, cookie: `expbuild_session=${login.cookies[0]!.value}`, 'x-csrf-token': login.json().csrfToken };
    const project = await app.inject({ method: 'POST', url: '/v1/projects', headers, payload: { name: 'Build team' } });
    assert.equal(project.statusCode, 202, project.body);
    const projectId = project.json().id, path = `/v1/projects/${projectId}/instances`;
    let release!: () => void, entered!: () => void;
    const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
    const releasePromise = new Promise<void>(resolve => { release = resolve; });
    let first = true;
    kube.onProject = async () => { if (first) { first = false; entered(); await releasePromise; } };
    const staleWorker = worker.tick();
    await enteredPromise;
    await pool.query("UPDATE operations SET lease_until=now()-interval '1 second' WHERE project_id=$1", [projectId]);
    await new OperationWorker(pool, kube, key).tick();
    release(); await staleWorker;
    const completed = (await pool.query("SELECT id,state,attempts FROM operations WHERE project_id=$1 AND kind='project.create'", [projectId])).rows[0];
    assert.equal(completed.state, 'succeeded'); assert.equal(completed.attempts, 2);
    assert.equal((await pool.query("SELECT count(*)::int AS total FROM audit_events WHERE operation_id=$1 AND action='operation.succeeded'", [completed.id])).rows[0].total, 1, 'expired claimant must not commit a duplicate completion');
    assert.equal((await pool.query('SELECT state FROM projects WHERE id=$1', [projectId])).rows[0].state, 'ready');
    const templates = await app.inject({ url: '/v1/templates', headers });
    assert.equal(templates.statusCode, 200, templates.body);
    assert.equal(templates.json().items[0].capabilities.policyApplyMode, "restart");
    assert.equal(templates.json().items[0].capabilities.policyCondition, "PolicyApplied");
    const input = { name: 'Build cache', storageGiB: 10, cacheGiB: 8 };
    const create = () => app.inject({ method: 'POST', url: path, headers: { ...headers, 'idempotency-key': 'create-cache-1' }, payload: input });
    const accepted = await create(); assert.equal(accepted.statusCode, 202, accepted.body);
    const { operation, credentials } = accepted.json(), instanceId = operation.instance_id;
    assert.ok(credentials.password);
    const replay = await create(); assert.equal(replay.statusCode, 202, replay.body);
    assert.equal(replay.json().operation.id, operation.id); assert.equal(replay.json().credentials, undefined);
    const conflict = await app.inject({ method: 'POST', url: path, headers: { ...headers, 'idempotency-key': 'create-cache-1' }, payload: { ...input, name: 'Other' } });
    assert.equal(conflict.statusCode, 409);
    await tick(); // CR persisted but response was lost.
    assert.equal(kube.creations, 1);
    assert.equal((await pool.query('SELECT kubernetes_uid FROM instance_bindings WHERE id=$1', [instanceId])).rows[0].kubernetes_uid, null);
    await tick(); // Retry recovers the same identity and credentials.
    assert.equal(kube.creations, 1);
    const pending = (await pool.query('SELECT * FROM operations WHERE id=$1', [operation.id])).rows[0];
    assert.equal(pending.state, 'reconciling'); assert.ok(pending.secret_payload);
    assert.equal(JSON.stringify(pending.request).includes(credentials.password), false);
    const safeOperation = await app.inject({ url: `/v1/projects/${projectId}/operations/${operation.id}`, headers });
    assert.equal(safeOperation.json().secret_payload, undefined); assert.equal(safeOperation.json().request, undefined);
    kube.ready(); await tick();
    assert.equal((await pool.query('SELECT secret_payload FROM operations WHERE id=$1', [operation.id])).rows[0].secret_payload, null);
    const historyPath = `${path}/${instanceId}/statistics/history`;
    assert.equal((await app.inject({url:historyPath,headers})).statusCode,200);
    const recordedUID = (await pool.query('SELECT kubernetes_uid FROM instance_bindings WHERE id=$1',[instanceId])).rows[0].kubernetes_uid;
    assert.deepEqual(historyTargets.at(-1),{projectId,instanceUID:recordedUID});
    assert.equal((await app.inject({url:historyPath+'?query=up',headers})).statusCode,400);
    assert.equal((await app.inject({url:historyPath+'?window=30d',headers})).statusCode,400);
    const beforeRotation=await app.inject({url:`${path}/${instanceId}`,headers});
    const oldSecret=[...kube.secrets.keys()][0]!;
    const rotationHeaders={...headers,'idempotency-key':'rotate-credentials-1','if-match':beforeRotation.headers.etag as string};
    const rotate=()=>app.inject({method:'POST',url:`${path}/${instanceId}/credentials/rotate`,headers:rotationHeaders});
    const rotated=await rotate();assert.equal(rotated.statusCode,202,rotated.body);
    assert.notEqual(rotated.json().credentials.password,credentials.password);
    const replayRotation=await rotate();assert.equal(replayRotation.json().credentials,undefined);
    assert.equal(replayRotation.json().operation.id,rotated.json().operation.id);
    kube.loseUpdateResponse=true;
    await tick();assert.equal(kube.secrets.size,2,'old credential remains until rollout is proven');
    await tick();assert.equal(kube.secrets.size,2);
    kube.ready();await tick();assert.equal(kube.secrets.size,1);assert.equal(kube.secrets.has(oldSecret),false);
    const credentialRows=(await pool.query('SELECT state,revision FROM instance_credentials WHERE instance_id=$1 ORDER BY revision',[instanceId])).rows;
    assert.deepEqual(credentialRows,[{state:'revoked',revision:1},{state:'active',revision:2}]);
    const rotatedSecret=[...kube.objects.values()][0]!.spec.access.credentialsSecretRef;
    const detail = await app.inject({ url: `${path}/${instanceId}`, headers });
    assert.equal(detail.json().lifecycle, 'active');
    const snapshot=await app.inject({url:`${path}/${instanceId}/statistics`,headers});assert.equal(snapshot.statusCode,200,snapshot.body);assert.equal(snapshot.json().usedBytes,1024);assert.equal(statisticsCalls,1);
    const updateHeaders = { ...headers, 'idempotency-key': 'suspend-cache-1', 'if-match': detail.headers.etag as string };
    const update = await app.inject({ method: 'PATCH', url: `${path}/${instanceId}`, headers: updateHeaders, payload: { ...input, desiredState: 'Suspended' } });
    assert.equal(update.statusCode, 202, update.body);
    const concurrent = await app.inject({ method: 'PATCH', url: `${path}/${instanceId}`, headers: { ...updateHeaders, 'idempotency-key': 'suspend-cache-2' }, payload: { ...input, desiredState: 'Suspended' } });
    assert.equal(concurrent.statusCode, 409, concurrent.body);
    await tick(); kube.ready(); await tick();
    assert.equal([...kube.objects.values()][0]!.spec.access.credentialsSecretRef,rotatedSecret,'ordinary update must preserve rotated credentials');
    const suspendedStats=await app.inject({url:`${path}/${instanceId}/statistics`,headers});assert.equal(suspendedStats.statusCode,409);assert.equal(statisticsCalls,1,'suspended instances must not be scraped');
    const stale = await app.inject({ method: 'PATCH', url: `${path}/${instanceId}`, headers: { ...updateHeaders, 'idempotency-key': 'stale-update-1' }, payload: input });
    assert.equal(stale.statusCode, 409);
    const deletion = await app.inject({ method: 'DELETE', url: `${path}/${instanceId}`, headers: { ...headers, 'idempotency-key': 'delete-cache-1' } });
    assert.equal(deletion.statusCode, 202, deletion.body);
    const original = structuredClone([...kube.objects.values()][0]!);
    await tick(); // CR deleted; credential cleanup is still pending.
    const deleteId = deletion.json().operation.id;
    await pool.query("UPDATE operations SET deadline_at=now()-interval '1 second' WHERE id=$1", [deleteId]);
    await tick();
    assert.ok(kube.secrets.size > 0);
    const retryDelete = (key: string) => app.inject({ method: 'POST', url: `/v1/projects/${projectId}/operations/${deleteId}/retry`, headers: { ...headers, 'idempotency-key': key } });
    assert.equal((await retryDelete('resume-delete-1')).statusCode, 202);
    const replacement = structuredClone(original); replacement.metadata.uid = randomUUID();
    const resourceKey = `${original.metadata.namespace}/${original.metadata.name}`;
    kube.objects.set(resourceKey, replacement);
    await tick();
    assert.equal((await pool.query('SELECT error_code FROM operations WHERE id=$1', [deleteId])).rows[0].error_code, 'instance_identity_conflict');
    assert.equal(kube.objects.get(resourceKey)?.metadata.uid, replacement.metadata.uid);
    assert.ok(kube.secrets.size > 0, 'must not clean credentials while a replacement resource exists');
    const changedPolicy = structuredClone(original);
    changedPolicy.spec.storage.deletionPolicy = 'Delete';
    kube.objects.set(resourceKey, changedPolicy);
    assert.equal((await retryDelete('resume-delete-policy')).statusCode, 202);
    await tick();
    assert.equal((await pool.query('SELECT error_code FROM operations WHERE id=$1', [deleteId])).rows[0].error_code, 'deletion_policy_changed');
    assert.ok(kube.objects.has(resourceKey));
    kube.objects.delete(resourceKey);
    assert.equal((await retryDelete('resume-delete-2')).statusCode, 202);
    await tick();
    const replayedDelete = await retryDelete('resume-delete-2');
    assert.equal(replayedDelete.json().operation.state, 'succeeded');
    assert.equal(replayedDelete.json().replayed, true);
    assert.equal((await pool.query('SELECT request FROM operations WHERE id=$1', [deleteId])).rows[0].request.deletionPolicy, 'Retain');
    assert.equal((await pool.query('SELECT lifecycle FROM instance_bindings WHERE id=$1', [instanceId])).rows[0].lifecycle, 'detached');
    assert.equal(kube.secrets.size, 0);
    assert.equal(await worker.tick(), false);
    const volumePath = `${path}/${instanceId}/retained-volume`;
    kube.volume = { name: original.metadata.name + '-data', namespace: original.metadata.namespace, uid: randomUUID(), capacity: '10Gi', storageClass: 'standard', phase: 'Bound', deleting: false };
    const observedVolume = await app.inject({ url: volumePath, headers });
    assert.equal(observedVolume.statusCode, 200);
    const volumeUid = observedVolume.json().uid;
    assert.equal(observedVolume.headers.etag, `"${volumeUid}"`);
    const viewerId = randomUUID();
    await pool.query('INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)', [viewerId, 'volume-viewer@test.local', await hashPassword(password)]);
    await pool.query("INSERT INTO project_members(project_id,user_id,role) VALUES($1,$2,'viewer')", [projectId, viewerId]);
    const viewerLogin = await app.inject({ method: 'POST', url: '/v1/auth/login', headers: { origin }, payload: { email: 'volume-viewer@test.local', password } });
    const viewerHeaders = { origin, cookie: `expbuild_session=${viewerLogin.cookies[0]!.value}`, 'x-csrf-token': viewerLogin.json().csrfToken, 'if-match': volumeUid, 'idempotency-key': 'viewer-volume-delete' };
    assert.equal((await app.inject({ url: volumePath, headers: viewerHeaders })).statusCode, 200);
    assert.equal((await app.inject({url:historyPath,headers:viewerHeaders})).statusCode,200,'detached instances retain authorized UID-scoped history');
    const beforeDenied = historyTargets.length;
    assert.equal((await app.inject({url:`/v1/projects/${randomUUID()}/instances/${instanceId}/statistics/history`,headers:viewerHeaders})).statusCode,404);
    assert.equal(historyTargets.length,beforeDenied,'unauthorized requests must not query metrics');

    assert.equal((await app.inject({ method: 'DELETE', url: volumePath, headers: viewerHeaders })).statusCode, 403);
    assert.equal((await app.inject({ url: `/v1/projects/${randomUUID()}/instances/${instanceId}/retained-volume`, headers: viewerHeaders })).statusCode, 404);
    const removeVolume = (key: string, uid = volumeUid) => app.inject({ method: 'DELETE', url: volumePath, headers: { ...headers, 'idempotency-key': key, 'if-match': uid } });
    assert.equal((await app.inject({ method: 'DELETE', url: volumePath, headers: { ...headers, 'idempotency-key': 'missing-volume-version' } })).statusCode, 400);
    const staleVolume = await removeVolume('stale-volume-delete', 'replaced-uid');
    assert.equal(staleVolume.statusCode, 202);
    await tick();
    assert.equal((await pool.query('SELECT error_code FROM operations WHERE id=$1', [staleVolume.json().operation.id])).rows[0].error_code, 'volume_identity_conflict');
    assert.equal(kube.volume.uid, volumeUid);
    const cleanup = await removeVolume('cleanup-volume-delete');
    assert.equal(cleanup.statusCode, 202, cleanup.body);
    assert.equal((await removeVolume('concurrent-volume-delete')).statusCode, 409);
    kube.loseVolumeDeleteResponse = true;
    await tick();
    assert.equal(kube.volume, null);
    await tick();
    const completedCleanup = await removeVolume('cleanup-volume-delete');
    assert.equal(completedCleanup.statusCode, 202);
    assert.equal(completedCleanup.json().operation.id, cleanup.json().operation.id);
    assert.equal(completedCleanup.json().operation.state, 'succeeded');
    assert.equal((await removeVolume('cleanup-volume-delete', 'another-uid')).statusCode, 409);
    assert.equal((await removeVolume('new-volume-delete')).statusCode, 409);
    assert.equal((await pool.query('SELECT lifecycle FROM instance_bindings WHERE id=$1', [instanceId])).rows[0].lifecycle, 'deleted');
    assert.equal((await pool.query("SELECT count(*)::int AS total FROM audit_events WHERE operation_id=$1 AND action='volume.delete'", [cleanup.json().operation.id])).rows[0].total, 1);
    kube.onProject=async()=>{throw new OperationError('namespace_ownership_conflict');};
    const failedProject=await app.inject({method:'POST',url:'/v1/projects',headers,payload:{name:'Retry project'}});
    assert.equal(failedProject.statusCode,202,failedProject.body);
    const failedId=failedProject.json().id;
    await tick();
    assert.equal((await pool.query('SELECT state FROM projects WHERE id=$1',[failedId])).rows[0].state,'failed');
    const retry=()=>app.inject({method:'POST',url:`/v1/projects/${failedId}/retry`,headers:{...headers,'idempotency-key':'retry-project-1'}});
    const acceptedRetry=await retry();assert.equal(acceptedRetry.statusCode,202,acceptedRetry.body);
    const duplicateRetry=await retry();assert.equal(duplicateRetry.json().operation.id,acceptedRetry.json().operation.id);
    const concurrentRetry=await app.inject({method:'POST',url:`/v1/projects/${failedId}/retry`,headers:{...headers,'idempotency-key':'retry-project-2'}});assert.equal(concurrentRetry.statusCode,409);
    kube.onProject=undefined;await tick();
    const recovered=(await pool.query('SELECT state,namespace FROM projects WHERE id=$1',[failedId])).rows[0];
    assert.equal(recovered.state,'ready');assert.equal(recovered.namespace,failedProject.json().namespace);
    assert.equal((await retry()).json().operation.state,'succeeded');

  } finally {
    await app.close(); await pool.end(); await root.query(`DROP DATABASE "${database}"`); await root.end();
  }
});

test('WebDAV provisioning is gated and preserves engine capabilities through updates', { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const root = createPool(process.env.TEST_DATABASE_URL!), database = `expbuild_test_${randomUUID().replaceAll('-', '')}`;
  await root.query(`CREATE DATABASE "${database}"`);
  const url = new URL(process.env.TEST_DATABASE_URL!); url.pathname = `/${database}`;
  const pool = createPool(url.toString()), kube = new Cluster(), key = randomBytes(32);
  kube.loseCreateResponse = false;
  const origin = 'http://localhost:5173';
  const options = { origin, secureCookies: false, kube, encryptionKey: key, storageClass: 'test' };
  const disabled = await buildApp(pool, options);
  let statisticsCalls = 0;
  const app = await buildApp(pool, { ...options, webdavEnabled: true, statistics: { readStatistics: async () => { statisticsCalls++; throw new Error('unsupported'); } } });
  const worker = new OperationWorker(pool, kube, key);
  const tick = async () => {
    await pool.query("UPDATE operations SET next_attempt_at=now()-interval '1 second'");
    assert.equal(await worker.tick(), true);
  };
  try {
    await migrate(pool);
    const password = 'integration-test-password';
    await pool.query('INSERT INTO users(id,email,password_hash,platform_admin) VALUES($1,$2,$3,true)', [randomUUID(), 'admin@test.local', await hashPassword(password)]);
    const login = await app.inject({ method: 'POST', url: '/v1/auth/login', headers: { origin }, payload: { email: 'admin@test.local', password } });
    assert.equal(login.statusCode, 200, login.body);
    const headers = { origin, cookie: `expbuild_session=${login.cookies[0]!.value}`, 'x-csrf-token': login.json().csrfToken };
    const project = await app.inject({ method: 'POST', url: '/v1/projects', headers, payload: { name: 'WebDAV team' } });
    assert.equal(project.statusCode, 202, project.body);
    await tick();
    const path = `/v1/projects/${project.json().id}/instances`;
    const payload = { name: 'Artifacts', template: 'webdav-apache', storageGiB: 10, cacheGiB: 0 };
    const create = (server: typeof app, body = payload) => server.inject({ method: 'POST', url: path, headers: { ...headers, 'idempotency-key': 'webdav-create' }, payload: body });
    assert.deepEqual((await disabled.inject({ url: '/v1/templates', headers })).json().items.map((x: {name: string}) => x.name), ['bazel-remote']);
    assert.equal((await create(disabled)).statusCode, 409);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM instance_bindings')).rows[0].n, 0);
    const gatewayPayload = { name: 'Gateway cache', storageGiB: 10, cacheGiB: 8, exposure: 'Gateway' };
    const gatewayDenied = await disabled.inject({ method: 'POST', url: path, headers: { ...headers, 'idempotency-key': 'gateway-disabled' }, payload: gatewayPayload });
    assert.equal(gatewayDenied.statusCode, 409);
    assert.match(gatewayDenied.body, /Gateway exposure is not enabled/);
    const gatewayApp = await buildApp(pool, { origin, secureCookies: false, kube, encryptionKey: key, storageClass: 'test', gatewayEnabled: true });
    try {
      const directory = (await gatewayApp.inject({ url: '/v1/templates', headers })).json().items;
      assert.deepEqual(directory[0].exposures, ['ClusterInternal', 'Gateway']);
      const routed = await gatewayApp.inject({ method: 'POST', url: path, headers: { ...headers, 'idempotency-key': 'gateway-enabled' }, payload: gatewayPayload });
      assert.equal(routed.statusCode, 202, routed.body);
      const queued = (await pool.query('SELECT request FROM operations WHERE id=$1', [routed.json().operation.id])).rows[0].request;
      assert.equal(queued.desired.spec.access.exposure, 'Gateway');
      // This case checks acceptance only; leave no active work in the recovery fixture.
      await pool.query("UPDATE operations SET state='failed',secret_payload=NULL WHERE id=$1", [routed.json().operation.id]);
      await pool.query("UPDATE instance_bindings SET lifecycle='failed' WHERE id=$1", [routed.json().operation.instance_id]);
    } finally { await gatewayApp.close(); }

    const catalog = (await app.inject({ url: '/v1/templates', headers })).json().items;
    assert.equal(catalog[1].name, 'webdav-apache');
    assert.equal(catalog[1].capabilities.statistics, false);
    assert.equal(catalog[1].capabilities.policyApplyMode, "unsupported");
    assert.equal((await create(app, { ...payload, cacheGiB: 8 })).statusCode, 400);
    const accepted = await create(app);
    assert.equal(accepted.statusCode, 202, accepted.body);
    const id = accepted.json().operation.instance_id;
    // Recreate the pre-column schema with an already queued WebDAV instance.
    await pool.query('ALTER TABLE instance_bindings DROP COLUMN template_name');
    await pool.query("DELETE FROM schema_migrations WHERE name='003_instance_template.sql'");
    await migrate(pool);
    await migrate(pool); // Upgrade remains idempotent.
    const listed = await app.inject({ url: path, headers });
    assert.equal(listed.json().items[0].template_name, 'webdav-apache');
    kube.loseCreateResponse = true;
    await tick();
    const createOperation = accepted.json().operation.id;
    await pool.query("UPDATE operations SET deadline_at=now()-interval '1 second' WHERE id=$1", [createOperation]);
    await tick();
    assert.equal((await pool.query('SELECT kubernetes_uid FROM instance_bindings WHERE id=$1', [id])).rows[0].kubernetes_uid, null);
    assert.equal((await pool.query('SELECT secret_payload FROM operations WHERE id=$1', [createOperation])).rows[0].secret_payload, null);
    const recoveryPath = `/v1/projects/${project.json().id}/operations/${createOperation}/retry`;
    const originalObject = structuredClone([...kube.objects.values()][0]!);
    const originalKey = `${originalObject.metadata.namespace}/${originalObject.metadata.name}`;
    const conflicts = ['missing', 'operation', 'ownership', 'spec'];
    for (const conflict of conflicts) {
      const object = structuredClone(originalObject);
      if (conflict === 'operation') object.metadata.annotations!['cache.expbuild.io/operation-id'] = randomUUID();
      if (conflict === 'ownership') object.metadata.labels!['cache.expbuild.io/project-id'] = randomUUID();
      if (conflict === 'spec') object.spec.desiredState = 'Suspended';
      kube.objects.set(originalKey, object);
      if (conflict === 'missing') kube.objects.delete(originalKey);
      const recovery = await app.inject({ method: 'POST', url: recoveryPath, headers: { ...headers, 'idempotency-key': `recover-${conflict}` } });
      assert.equal(recovery.statusCode, 202, recovery.body);
      await tick();
      assert.equal((await pool.query('SELECT state FROM operations WHERE id=$1', [createOperation])).rows[0].state, 'failed');
      assert.equal((await pool.query('SELECT kubernetes_uid FROM instance_bindings WHERE id=$1', [id])).rows[0].kubernetes_uid, null);
      assert.equal(kube.creations, 1, 'recovery must never create a new object');
    }
    kube.objects.set(originalKey, originalObject);
    const recoveredCreate = await app.inject({ method: 'POST', url: recoveryPath, headers: { ...headers, 'idempotency-key': 'recover-original' } });
    assert.equal(recoveredCreate.statusCode, 202, recoveredCreate.body);
    await tick();
    assert.equal((await pool.query('SELECT kubernetes_uid FROM instance_bindings WHERE id=$1', [id])).rows[0].kubernetes_uid, originalObject.metadata.uid);

    await pool.query("UPDATE operations SET deadline_at=now()-interval '1 second' WHERE id=$1", [createOperation]);
    await tick();
    assert.equal((await pool.query('SELECT state,secret_payload FROM operations WHERE id=$1', [createOperation])).rows[0].state, 'failed');
    const retryPath = `/v1/projects/${project.json().id}/operations/${createOperation}/retry`;
    const retryHeaders = { ...headers, 'idempotency-key': 'resume-webdav' };
    const resumed = await app.inject({ method: 'POST', url: retryPath, headers: retryHeaders });
    assert.equal(resumed.statusCode, 202, resumed.body);
    assert.equal(resumed.json().operation.state, 'reconciling');
    assert.equal(resumed.json().operation.secret_payload, undefined);
    const liveObject = [...kube.objects.values()][0]!;
    const originalUID = liveObject.metadata.uid;
    liveObject.metadata.uid = randomUUID();
    kube.ready(); await tick();
    assert.equal((await pool.query('SELECT error_code FROM operations WHERE id=$1', [createOperation])).rows[0].error_code, 'instance_identity_conflict');
    liveObject.metadata.uid = originalUID;
    const resumedAgain = await app.inject({ method: 'POST', url: retryPath, headers: { ...headers, 'idempotency-key': 'resume-webdav-again' } });
    assert.equal(resumedAgain.statusCode, 202, resumedAgain.body);
    await tick();
    const repeated = await app.inject({ method: 'POST', url: retryPath, headers: retryHeaders });
    assert.equal(repeated.statusCode, 202);
    assert.equal(repeated.json().replayed, true);
    assert.equal(repeated.json().operation.state, 'succeeded');
    assert.equal(kube.creations, 1, 'retry must not create a replacement instance');
    assert.equal((await pool.query("SELECT count(*)::int n FROM audit_events WHERE operation_id=$1 AND action='operation.retry'", [createOperation])).rows[0].n, 7);

    const detail = await app.inject({ url: `${path}/${id}`, headers });
    assert.equal(detail.json().spec.templateRef.name, 'webdav-apache');
    assert.deepEqual(detail.json().spec.eviction, { enginePolicy: 'none', maxCacheGiB: 0 });
    assert.equal((await app.inject({ url: `${path}/${id}/statistics`, headers })).statusCode, 409);
    assert.equal(statisticsCalls, 0);
    const updateHeaders = { ...headers, 'idempotency-key': 'webdav-update', 'if-match': detail.headers.etag as string };
    const switched = await app.inject({ method: 'PATCH', url: `${path}/${id}`, headers: updateHeaders, payload: { ...payload, template: 'bazel-remote', cacheGiB: 8 } });
    assert.equal(switched.statusCode, 400);
    const updated = await disabled.inject({ method: 'PATCH', url: `${path}/${id}`, headers: updateHeaders, payload: { ...payload, desiredState: 'Suspended' } });
    assert.equal(updated.statusCode, 202, updated.body);
    await tick(); kube.ready(); await tick();
    const paused = (await app.inject({ url: `${path}/${id}`, headers })).json();
    assert.equal(paused.spec.templateRef.name, 'webdav-apache');
    assert.equal(paused.spec.desiredState, 'Suspended');
    assert.equal(paused.spec.eviction.enginePolicy, 'none');
    await pool.query("UPDATE operations SET state='failed' WHERE id=$1", [createOperation]);
    const obsolete = await app.inject({ method: 'POST', url: retryPath, headers: { ...headers, 'idempotency-key': 'retry-obsolete-operation' } });
    assert.equal(obsolete.statusCode, 409);

  } finally {
    await app.close(); await disabled.close(); await pool.end();
    await root.query(`DROP DATABASE "${database}"`); await root.end();
  }
});
