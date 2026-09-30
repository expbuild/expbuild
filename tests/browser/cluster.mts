import { randomUUID } from 'node:crypto';
import { revision, type CacheObject } from '../../apps/admin-api/src/instance-contract.js';
import type { CredentialData, KubernetesPort, RetainedVolumeIdentity } from '../../apps/admin-api/src/kubernetes.js';

// Only the Kubernetes boundary is simulated. Browser requests, authorization,
// persistence, operation processing, and the production UI remain real.
export class BrowserCluster implements KubernetesPort {
  private objects = new Map<string, CacheObject>();
  private credentials = new Map<string, CredentialData>();
  private key(namespace: string, name: string) { return `${namespace}/${name}`; }

  async ensureProject(_namespace: string, _projectId: string) {}
  async getRetainedVolume(_identity: RetainedVolumeIdentity) { return null; }
  async deleteRetainedVolume(_identity: RetainedVolumeIdentity, _uid: string) { throw new Error('No retained volume in browser fixture'); }
  async ensureCredentials(namespace: string, name: string, _projectId: string, _instanceId: string, _operationId: string, data: CredentialData) {
    this.credentials.set(this.key(namespace, name), structuredClone(data));
  }
  async deleteCredentials(namespace: string, name: string, _projectId: string, _instanceId: string) {
    this.credentials.delete(this.key(namespace, name));
  }
  async getInstance(namespace: string, name: string) {
    return structuredClone(this.objects.get(this.key(namespace, name)) ?? null);
  }
  private ready(object: CacheObject) {
    const generation = object.metadata.generation!;
    object.status = {
      observedGeneration: generation,
      credentialRevision: object.spec.access.credentialsSecretRef,
      endpoints: object.spec.desiredState === 'Running' ? [{ protocol: 'http', url: `http://${object.metadata.name}.${object.metadata.namespace}.svc.cluster.local:8080` }] : [],
      conditions: [{ type: 'Ready', status: object.spec.desiredState === 'Running' ? 'True' : 'False', reason: object.spec.desiredState === 'Running' ? 'Ready' : 'Suspended', observedGeneration: generation }],
    };
    return object;
  }
  async createInstance(desired: CacheObject) {
    const key = this.key(desired.metadata.namespace, desired.metadata.name);
    if (this.objects.has(key)) throw Object.assign(new Error('Already exists'), { statusCode: 409 });
    const object = structuredClone(desired);
    object.metadata.uid = randomUUID();
    object.metadata.generation = 1;
    this.ready(object);
    this.objects.set(key, object);
    return structuredClone(object);
  }
  async updateInstance(desired: CacheObject, expectedRevision: string) {
    const key = this.key(desired.metadata.namespace, desired.metadata.name);
    const previous = this.objects.get(key);
    if (!previous || revision(previous) !== expectedRevision) throw Object.assign(new Error('Version conflict'), { statusCode: 409 });
    const object = structuredClone(desired);
    object.metadata.uid = previous.metadata.uid;
    object.metadata.generation = previous.metadata.generation! + 1;
    this.ready(object);
    this.objects.set(key, object);
    return structuredClone(object);
  }
  async deleteInstance(namespace: string, name: string, uid: string) {
    const key = this.key(namespace, name);
    const object = this.objects.get(key);
    if (object && object.metadata.uid !== uid) throw Object.assign(new Error('Identity conflict'), { statusCode: 409 });
    this.objects.delete(key);
  }
}
