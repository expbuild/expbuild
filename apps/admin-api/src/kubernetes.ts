import type { InventoryResources } from './inventory.js';
import { quantityToScalar } from '@kubernetes/client-node/dist/util.js';
import type { Quota } from "./quotas.js";
import { KubeConfig, CoreV1Api, CustomObjectsApi, NetworkingV1Api, createConfiguration, ServerConfiguration, type V1Secret, type V1ResourceQuota } from '@kubernetes/client-node';
import { isDeepStrictEqual } from 'node:util';
import { labels, revision, type CacheObject } from './instance-contract.js';
import { OperationError } from './errors.js';
import { readEngineStatistics, readWebDAVStatistics, readGradleStatistics } from './statistics.js';
import { clientAccessPolicy } from './network-policy.js';

export type CredentialData = { htpasswd: string; 'probe-username': string; 'probe-password': string };
export type RetainedVolumeIdentity = { namespace: string; name: string; projectId: string; instanceId: string; instanceUid: string };
export type RetainedVolume = { name: string; namespace: string; uid: string; capacity: string; allocatedCapacity: string; storageClass: string; phase: string; deleting: boolean };
export interface KubernetesPort {
  approveRetainedVolumeReclaim?(desired: CacheObject, uid: string): Promise<void>;
  inspectProjectResources?(namespace: string, projectId: string): Promise<InventoryResources>;
  getRetainedVolume(identity: RetainedVolumeIdentity): Promise<RetainedVolume | null>;
  deleteRetainedVolume(identity: RetainedVolumeIdentity, uid: string): Promise<void>;
  ensureProject(namespace: string, projectId: string): Promise<void>;
  ensureCredentials(namespace: string, name: string, projectId: string, instanceId: string, operationId: string, data: CredentialData): Promise<void>;
  getInstance(namespace: string, name: string): Promise<CacheObject | null>;
  createInstance(desired: CacheObject): Promise<CacheObject>;
  updateInstance(desired: CacheObject, expectedRevision: string): Promise<CacheObject>;
  deleteInstance(namespace: string, name: string, uid: string): Promise<void>;
  deleteCredentials(namespace: string, name: string, projectId: string, instanceId: string): Promise<void>;
}

export function statusCode(error: unknown): number | undefined {
  const e = error as { code?: number; statusCode?: number; response?: { statusCode?: number } };
  return e?.code ?? e?.statusCode ?? e?.response?.statusCode;
}

const group = 'cache.expbuild.io', version = 'v1alpha1', plural = 'cacheinstances';
const opKey = 'cache.expbuild.io/operation-id';

export class KubernetesClient implements KubernetesPort {
  private core: CoreV1Api;
  private custom: CustomObjectsApi;
  private network: NetworkingV1Api;
  async readStatistics(object: CacheObject) {
    const secret=await this.core.readNamespacedSecret({namespace:object.metadata.namespace,name:object.spec.access.credentialsSecretRef});
    if(secret.metadata?.labels?.['cache.expbuild.io/project-id']!==object.spec.projectId || secret.metadata?.labels?.['cache.expbuild.io/instance-id']!==object.spec.instanceId)throw new OperationError('credential_ownership_conflict');
    const username=Buffer.from(secret.data?.['probe-username']??'','base64').toString('utf8');
    const password=Buffer.from(secret.data?.['probe-password']??'','base64').toString('utf8');
    if (object.spec.templateRef.name === 'webdav-apache' && object.spec.templateRef.version === '0.2.0')
      return readWebDAVStatistics(object.metadata.namespace,object.metadata.name,username,password);
    if (object.spec.templateRef.name === 'bazel-remote' && object.spec.templateRef.version === '0.1.0')
      return readEngineStatistics(object.metadata.namespace,object.metadata.name,username,password);
    if (object.spec.templateRef.name === 'gradle-http' && object.spec.templateRef.version === '0.1.0')
      return readGradleStatistics(object.metadata.namespace,object.metadata.name,username,password);
    throw new OperationError('statistics_template_unsupported');
  }
  constructor(config?: KubeConfig, timeoutMs = 10_000) {
    const kc = config ?? new KubeConfig(); if (!config) kc.loadFromDefault();
    const cluster = kc.getCurrentCluster();
    if (!cluster) throw new Error('Kubernetes context must select a cluster');
    const configuration = createConfiguration({
      baseServer: new ServerConfiguration(cluster.server.replace(/\/+$/, ''), {}), authMethods: { default: kc },
      promiseMiddleware: [{ pre: async request => { request.setSignal(AbortSignal.timeout(timeoutMs)); return request; }, post: async response => response }],
    });
    this.core = new CoreV1Api(configuration); this.custom = new CustomObjectsApi(configuration); this.network = new NetworkingV1Api(configuration);
  }
  async ensureProject(namespace: string, projectId: string) {
    try { await this.core.createNamespace({ body: { metadata: { name: namespace, labels: labels(projectId) } } }); }
    catch (error) { if (statusCode(error) !== 409) throw error; }
    const found = await this.core.readNamespace({ name: namespace });
    if (found.metadata?.labels?.['cache.expbuild.io/project-id'] !== projectId || found.metadata?.labels?.['app.kubernetes.io/managed-by'] !== 'expbuild') throw new OperationError('namespace_ownership_conflict');
    // Default deny direct ingress. A later ingress adapter adds narrow rules for
    // ingress/monitoring; operator status probes originate in the platform namespace.
    const policy = { apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy', metadata: { name: 'expbuild-isolation', namespace, labels: labels(projectId) }, spec: { podSelector: {}, policyTypes: ['Ingress'], ingress: [{ _from: [{ namespaceSelector: { matchLabels: { 'cache.expbuild.io/control-plane': 'true' } } }] }] } };
    try { await this.network.createNamespacedNetworkPolicy({ namespace, body: policy }); }
    catch (error) {
      if (statusCode(error) !== 409) throw error;
      const current = await this.network.readNamespacedNetworkPolicy({ namespace, name: policy.metadata.name });
      if (current.metadata?.labels?.['cache.expbuild.io/project-id'] !== projectId || current.metadata?.labels?.['app.kubernetes.io/managed-by'] !== 'expbuild') throw new OperationError('policy_ownership_conflict');
    }
    const access = clientAccessPolicy(namespace, projectId);
    try { await this.network.createNamespacedNetworkPolicy({ namespace, body: access }); }
    catch (error) {
      if (statusCode(error) !== 409) throw error;
      const current = await this.network.readNamespacedNetworkPolicy({ namespace, name: access.metadata!.name! });
      if (current.metadata?.labels?.['cache.expbuild.io/project-id'] !== projectId || current.metadata?.labels?.['app.kubernetes.io/managed-by'] !== 'expbuild') throw new OperationError('policy_ownership_conflict');
      if (current.metadata.deletionTimestamp || !isDeepStrictEqual(JSON.parse(JSON.stringify(current.spec ?? null)), JSON.parse(JSON.stringify(access.spec)))) throw new OperationError('client_policy_configuration_conflict');
    }
  }
  async inspectProjectResources(namespace: string, projectId: string): Promise<InventoryResources> {
    const ns = await this.core.readNamespace({name:namespace});
    if (!ns.metadata?.uid || ns.metadata.deletionTimestamp || ns.metadata.labels?.['cache.expbuild.io/project-id'] !== projectId || ns.metadata.labels?.['app.kubernetes.io/managed-by'] !== 'expbuild') throw new OperationError('namespace_ownership_conflict');
    const collect = async <T>(page: (continuation?:string)=>Promise<{items:T[];metadata?:{_continue?:string;continue?:string}}>):Promise<T[]> => {
      const items:T[]=[]; let continuation:string|undefined;
      for(let count=0;count<5;count++) {
        const result=await page(continuation); items.push(...result.items);
        if(items.length>1000)throw new OperationError('inventory_limit_exceeded');
        continuation=result.metadata?._continue??result.metadata?.continue;
        if(!continuation)return items;
      }
      throw new OperationError('inventory_limit_exceeded');
    };
    const instances=await collect<CacheObject>(async continuation=>await this.custom.listNamespacedCustomObject({namespace,group,version,plural,limit:200,_continue:continuation}) as {items:CacheObject[];metadata?:{continue?:string}});
    const volumes=await collect(async continuation=>this.core.listNamespacedPersistentVolumeClaim({namespace,limit:200,_continue:continuation}));
    const final=await this.core.readNamespace({name:namespace});
    if(final.metadata?.uid!==ns.metadata.uid || final.metadata.deletionTimestamp || final.metadata.labels?.['cache.expbuild.io/project-id']!==projectId || final.metadata.labels?.['app.kubernetes.io/managed-by']!=='expbuild') throw new OperationError('namespace_changed_during_scan');
    return {instances,volumes};
  }
  async ensureProjectQuota(namespace: string, projectId: string, desiredRevision: string, limits: Quota): Promise<boolean> {
    const ns = await this.core.readNamespace({name: namespace});
    if (ns.metadata?.deletionTimestamp || ns.metadata?.labels?.['cache.expbuild.io/project-id'] !== projectId || ns.metadata?.labels?.['app.kubernetes.io/managed-by'] !== 'expbuild') throw new OperationError('namespace_ownership_conflict');
    const name = 'expbuild-resources', revisionKey = 'cache.expbuild.io/quota-revision';
    const hard: Record<string,string> = {};
    if (limits.instances !== null) hard['count/cacheinstances.cache.expbuild.io'] = String(limits.instances);
    if (limits.storageGiB !== null) hard['requests.storage'] = `${limits.storageGiB}Gi`;
    if (limits.cpuMillis !== null) { hard['requests.cpu'] = `${limits.cpuMillis}m`; hard['limits.cpu'] = `${limits.cpuMillis}m`; }
    if (limits.memoryMiB !== null) { hard['requests.memory'] = `${limits.memoryMiB}Mi`; hard['limits.memory'] = `${limits.memoryMiB}Mi`; }
    let current: V1ResourceQuota | null;
    try { current = await this.core.readNamespacedResourceQuota({namespace,name}); }
    catch(error) { if(statusCode(error) !== 404) throw error; current = null; }
    if (current) {
      const meta = current.metadata;
      if (!meta?.uid || !meta.resourceVersion || meta.ownerReferences?.length || meta.labels?.['cache.expbuild.io/project-id'] !== projectId || meta.labels?.['app.kubernetes.io/managed-by'] !== 'expbuild') throw new OperationError('quota_ownership_conflict');
      if (current.spec?.scopes?.length || current.spec?.scopeSelector) throw new OperationError('quota_scope_conflict');
      if (meta.deletionTimestamp) return false;
      const previous = meta.annotations?.[revisionKey];
      if (previous && (!/^[1-9][0-9]*$/.test(previous) || BigInt(previous) > BigInt(desiredRevision))) throw new OperationError('quota_revision_conflict');
    }
    if (Object.keys(hard).length === 0) {
      if (!current) return true;
      await this.core.deleteNamespacedResourceQuota({namespace,name,body:{preconditions:{uid:current.metadata!.uid,resourceVersion:current.metadata!.resourceVersion}}});
      return false; // Confirm absence on the next observation.
    }
    const equal = (actual: Record<string,string> | undefined) => {
      if (!actual || Object.keys(actual).length !== Object.keys(hard).length) return false;
      try { return Object.entries(hard).every(([key,value]) => actual[key] !== undefined && quantityToScalar(actual[key]).toString() === quantityToScalar(value).toString()); }
      catch { return false; }
    };
    const body: V1ResourceQuota = {apiVersion:'v1',kind:'ResourceQuota',metadata:{name,namespace,labels:labels(projectId),annotations:{[revisionKey]:desiredRevision}},spec:{hard}};
    if (!current) { await this.core.createNamespacedResourceQuota({namespace,body}); return false; }
    if (!equal(current.spec?.hard) || current.metadata?.annotations?.[revisionKey] !== desiredRevision) {
      body.metadata = {...current.metadata, annotations:{...current.metadata?.annotations,[revisionKey]:desiredRevision}};
      await this.core.replaceNamespacedResourceQuota({namespace,name,body});
      return false;
    }
    return equal(current.status?.hard) && Object.keys(hard).every(key => current!.status?.used?.[key] !== undefined);
  }
  async ensureCredentials(namespace: string, name: string, projectId: string, instanceId: string, operationId: string, data: CredentialData) {
    const body: V1Secret = { metadata: { name, namespace, labels: labels(projectId, instanceId), annotations: { [opKey]: operationId } }, type: 'Opaque', immutable: true, data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, Buffer.from(v).toString('base64')])) };
    try { await this.core.createNamespacedSecret({ namespace, body }); }
    catch (error) {
      if (statusCode(error) !== 409) throw error;
      const found = await this.core.readNamespacedSecret({ namespace, name });
      if (found.metadata?.labels?.['cache.expbuild.io/instance-id'] !== instanceId || found.metadata?.labels?.['cache.expbuild.io/project-id'] !== projectId || found.metadata.annotations?.[opKey] !== operationId || JSON.stringify(Object.entries(found.data ?? {}).sort()) !== JSON.stringify(Object.entries(body.data!).sort())) throw new OperationError('credential_ownership_conflict');
    }
  }
  async getInstance(namespace: string, name: string): Promise<CacheObject | null> {
    try { return await this.custom.getNamespacedCustomObject({ group, version, plural, namespace, name }) as CacheObject; }
    catch (error) { if (statusCode(error) === 404) return null; throw error; }
  }
  async createInstance(desired: CacheObject): Promise<CacheObject> {
    try { return await this.custom.createNamespacedCustomObject({ group, version, plural, namespace: desired.metadata.namespace, body: desired }) as CacheObject; }
    catch (error) {
      if (statusCode(error) !== 409) throw error;
      const current = await this.getInstance(desired.metadata.namespace, desired.metadata.name);
      if (!current || current.spec.instanceId !== desired.spec.instanceId || current.spec.projectId !== desired.spec.projectId || current.metadata.annotations?.[opKey] !== desired.metadata.annotations?.[opKey] || current.metadata.annotations?.['cache.expbuild.io/request-hash'] !== desired.metadata.annotations?.['cache.expbuild.io/request-hash']) throw new OperationError('instance_ownership_conflict');
      if (!isDeepStrictEqual(current.spec, desired.spec) || current.metadata.deletionTimestamp) throw new OperationError('instance_configuration_superseded', true);
      return current;
    }
  }
  async approveRetainedVolumeReclaim(desired: CacheObject, uid: string): Promise<void> {
    const reclaim=desired.spec.storage.reclaim;
    if (!reclaim || !uid) throw new OperationError('invalid_reclaim_request');
    const current=await this.getInstance(desired.metadata.namespace,desired.metadata.name);
    if (!current || current.metadata.uid!==uid || current.metadata.deletionTimestamp ||
        current.spec.projectId!==desired.spec.projectId || current.spec.instanceId!==desired.spec.instanceId ||
        current.metadata.annotations?.[opKey]!==desired.metadata.annotations?.[opKey] ||
        !isDeepStrictEqual(current.spec,desired.spec)) throw new OperationError('instance_reclaim_conflict');
    const marker='cache.expbuild.io/reclaim-bound-uid';
    if (current.metadata.annotations?.[marker]===uid) return;
    if (current.metadata.annotations?.[marker]) throw new OperationError('instance_reclaim_conflict');
    if (!current.metadata.resourceVersion) throw new OperationError('missing_kubernetes_identity');
    await this.custom.replaceNamespacedCustomObject({group,version,plural,namespace:current.metadata.namespace,name:current.metadata.name,
      body:{...current,metadata:{...current.metadata,annotations:{...current.metadata.annotations,[marker]:uid}}}});
  }
  async updateInstance(desired: CacheObject, expectedRevision: string): Promise<CacheObject> {
    const current = await this.getInstance(desired.metadata.namespace, desired.metadata.name);
    if (!current || current.spec.instanceId !== desired.spec.instanceId || current.spec.projectId !== desired.spec.projectId || current.metadata.deletionTimestamp) throw new OperationError('instance_identity_conflict');
    if (current.metadata.uid !== expectedRevision.split(':')[0]) throw new OperationError('instance_identity_conflict');
    if (current.metadata.annotations?.[opKey] === desired.metadata.annotations?.[opKey]) {
      if (current.metadata.annotations?.['cache.expbuild.io/request-hash'] !== desired.metadata.annotations?.['cache.expbuild.io/request-hash'] || !isDeepStrictEqual(current.spec, desired.spec)) throw new OperationError('instance_configuration_superseded', true);
      return current;
    }
    if (revision(current) !== expectedRevision) throw new OperationError('instance_version_conflict', true);
    const body = { ...current, metadata: { ...current.metadata, annotations: { ...current.metadata.annotations, ...desired.metadata.annotations } }, spec: desired.spec };
    return await this.custom.replaceNamespacedCustomObject({ group, version, plural, namespace: desired.metadata.namespace, name: desired.metadata.name, body }) as CacheObject;
  }
  async deleteInstance(namespace: string, name: string, uid: string) {
    try { await this.custom.deleteNamespacedCustomObject({ group, version, plural, namespace, name, body: { preconditions: { uid } } }); }
    catch (error) { if (statusCode(error) === 409) throw new OperationError('instance_identity_conflict'); if (statusCode(error) !== 404) throw error; }
  }
  private async retainedClaim(identity: RetainedVolumeIdentity) {
    const { namespace, name, projectId, instanceId, instanceUid } = identity;
    const ns = await this.core.readNamespace({ name: namespace });
    if (ns.metadata?.labels?.['cache.expbuild.io/project-id'] !== projectId || ns.metadata?.labels?.['app.kubernetes.io/managed-by'] !== 'expbuild') throw new OperationError('namespace_ownership_conflict');
    try {
      const pvc = await this.core.readNamespacedPersistentVolumeClaim({ namespace, name: name + '-data' });
      const meta = pvc.metadata;
      if (!meta?.uid || !meta.resourceVersion || meta.labels?.['cache.expbuild.io/project-id'] !== projectId || meta.labels?.['cache.expbuild.io/instance-id'] !== instanceId || meta.labels?.['cache.expbuild.io/instance-uid'] !== instanceUid || meta.labels?.['app.kubernetes.io/managed-by'] !== 'expbuild' || meta.ownerReferences?.length) throw new OperationError('volume_ownership_conflict');
      return pvc;
    } catch (error) { if (statusCode(error) === 404) return null; throw error; }
  }
  async getRetainedVolume(identity: RetainedVolumeIdentity): Promise<RetainedVolume | null> {
    const pvc = await this.retainedClaim(identity);
    if (!pvc) return null;
    return { name: pvc.metadata!.name!, namespace: identity.namespace, uid: pvc.metadata!.uid!, capacity: pvc.spec?.resources?.requests?.storage ?? '', allocatedCapacity: pvc.status?.capacity?.storage ?? '', storageClass: pvc.spec?.storageClassName ?? '', phase: pvc.status?.phase ?? 'Unknown', deleting: !!pvc.metadata?.deletionTimestamp };
  }
  async deleteRetainedVolume(identity: RetainedVolumeIdentity, uid: string) {
    const pvc = await this.retainedClaim(identity);
    if (!pvc) return;
    if (pvc.metadata!.uid !== uid) throw new OperationError('volume_identity_conflict');
    if (await this.getInstance(identity.namespace, identity.name)) throw new OperationError('volume_instance_exists');
    // Include every Pod, not only platform labels: an externally created Pod may
    // still reference the claim. Kubernetes PVC protection additionally delays
    // final removal while a claim is in use.
    const pods = await this.core.listNamespacedPod({ namespace: identity.namespace });
    if (pods.items.some(p => p.spec?.volumes?.some(v => v.persistentVolumeClaim?.claimName === pvc.metadata!.name))) throw new OperationError('volume_in_use');
    try {
      await this.core.deleteNamespacedPersistentVolumeClaim({ namespace: identity.namespace, name: pvc.metadata!.name!, body: { preconditions: { uid, resourceVersion: pvc.metadata!.resourceVersion } } });
    } catch (error) { if (statusCode(error) === 409) throw new OperationError('volume_identity_conflict'); if (statusCode(error) !== 404) throw error; }
  }
  async deleteCredentials(namespace: string, name: string, projectId: string, instanceId: string) {
    try {
      const secret = await this.core.readNamespacedSecret({ namespace, name });
      if (secret.metadata?.labels?.['cache.expbuild.io/project-id'] !== projectId || secret.metadata?.labels?.['cache.expbuild.io/instance-id'] !== instanceId) throw new OperationError('credential_ownership_conflict');
      await this.core.deleteNamespacedSecret({ namespace, name, body: { preconditions: { uid: secret.metadata.uid } } });
    } catch (error) { if (statusCode(error) !== 404) throw error; }
  }
}
