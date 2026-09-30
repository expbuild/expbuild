import { KubeConfig, CoreV1Api, CustomObjectsApi, NetworkingV1Api, createConfiguration, ServerConfiguration, type V1Secret } from '@kubernetes/client-node';
import { isDeepStrictEqual } from 'node:util';
import { labels, revision, type CacheObject } from './instance-contract.js';
import { OperationError } from './errors.js';
import { readEngineStatistics } from './statistics.js';

export type CredentialData = { htpasswd: string; 'probe-username': string; 'probe-password': string };
export interface KubernetesPort {
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
    return readEngineStatistics(object.metadata.namespace,object.metadata.name,username,password);
  }
  constructor(config?: KubeConfig, timeoutMs = 10_000) {
    const kc = config ?? new KubeConfig(); if (!config) kc.loadFromDefault();
    const cluster = kc.getCurrentCluster();
    if (!cluster) throw new Error('Kubernetes context must select a cluster');
    const configuration = createConfiguration({
      baseServer: new ServerConfiguration(cluster.server, {}), authMethods: { default: kc },
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
      if (current.metadata?.labels?.['cache.expbuild.io/project-id'] !== projectId) throw new OperationError('policy_ownership_conflict');
    }
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
  async deleteCredentials(namespace: string, name: string, projectId: string, instanceId: string) {
    try {
      const secret = await this.core.readNamespacedSecret({ namespace, name });
      if (secret.metadata?.labels?.['cache.expbuild.io/project-id'] !== projectId || secret.metadata?.labels?.['cache.expbuild.io/instance-id'] !== instanceId) throw new OperationError('credential_ownership_conflict');
      await this.core.deleteNamespacedSecret({ namespace, name, body: { preconditions: { uid: secret.metadata.uid } } });
    } catch (error) { if (statusCode(error) !== 404) throw error; }
  }
}
