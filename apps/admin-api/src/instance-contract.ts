import { templateDefinition, type InstanceInput } from './template-catalog.js';
export { bazelInput, webdavInput, instanceInput, type InstanceInput } from './template-catalog.js';

export type CacheObject = {
  apiVersion: string;
  kind: string;
  metadata: { name: string; namespace: string; uid?: string; generation?: number; resourceVersion?: string; labels?: Record<string, string>; annotations?: Record<string, string>; deletionTimestamp?: string };
  spec: {
    instanceId: string; projectId: string;
    imageBindingMode?: 'PinnedV1';
    templateRef: { name: string; version: string };
    desiredState: string;
    storage: { className: string; capacity: string; deletionPolicy: string; reclaim?: { previousInstanceUID: string; volumeUID: string } };
    access: { exposure: string; credentialsSecretRef: string; readOnly?: boolean };
    eviction: { maxCacheGiB: number; enginePolicy: string };
    resources: { requests: Record<string, string>; limits: Record<string, string> };
  };
  status?: { observedGeneration?: number; credentialRevision?: string; endpoints?: { protocol: string; url: string }[]; conditions?: { type: string; status: string; reason: string; message?: string; observedGeneration?: number }[] };
};

export const labels = (projectId: string, instanceId?: string) => ({
  'app.kubernetes.io/managed-by': 'expbuild',
  'cache.expbuild.io/project-id': projectId,
  ...(instanceId ? { 'cache.expbuild.io/instance-id': instanceId } : {}),
});

export const revision = (c: CacheObject) => `${c.metadata.uid}:${c.metadata.generation}`;

export function desiredObject(input: InstanceInput, projectId: string, namespace: string, id: string, storageClass: string, operationId: string, requestHash: string): CacheObject {
  const template = templateDefinition(input.template);
  const resources = { cpu: `${input.cpuMillis}m`, memory: `${input.memoryMiB}Mi` };
  return {
    apiVersion: 'cache.expbuild.io/v1alpha1', kind: 'CacheInstance',
    metadata: { name: `c-${id}`, namespace, labels: labels(projectId, id), annotations: { 'cache.expbuild.io/operation-id': operationId, 'cache.expbuild.io/request-hash': requestHash, 'cache.expbuild.io/display-name': input.name } },
    spec: {
      imageBindingMode: 'PinnedV1', instanceId: id, projectId, templateRef: { name: template.name, version: template.version }, desiredState: input.desiredState,
      storage: { className: storageClass, capacity: `${input.storageGiB}Gi`, deletionPolicy: input.deletionPolicy },
      access: { exposure: input.exposure, credentialsSecretRef: `c-${id}-auth`, ...(input.template === 'go-cacheprog' ? { readOnly: input.readOnly } : {}) },
      eviction: { maxCacheGiB: input.cacheGiB, enginePolicy: template.enginePolicy }, resources: { requests: resources, limits: { ...resources } },
    },
  };
}
