import { z } from 'zod';

const commonInput = z.object({
  name: z.string().trim().min(1).max(100),
  storageGiB: z.number().int().min(2).max(1048576),
  cpuMillis: z.number().int().min(100).max(64000).default(500),
  memoryMiB: z.number().int().min(128).max(262144).default(512),
  exposure: z.enum(['ClusterInternal', 'Gateway']).default('ClusterInternal'),
  desiredState: z.enum(['Running', 'Suspended']).default('Running'),
  deletionPolicy: z.enum(['Retain', 'Delete']).default('Retain'),
}).strict();
export const bazelInput = commonInput.extend({
  template: z.literal('bazel-remote').default('bazel-remote'),
  cacheGiB: z.number().int().min(1).max(1048575),
}).refine(x => x.cacheGiB < x.storageGiB, { message: 'Cache budget must leave space in the volume', path: ['cacheGiB'] });
export const webdavInput = commonInput.extend({
  template: z.literal('webdav-apache'),
  cacheGiB: z.literal(0),
});
export const instanceInput = z.union([bazelInput, webdavInput]);
export type InstanceInput = z.infer<typeof instanceInput>;

export type CacheObject = {
  apiVersion: string;
  kind: string;
  metadata: { name: string; namespace: string; uid?: string; generation?: number; resourceVersion?: string; labels?: Record<string, string>; annotations?: Record<string, string>; deletionTimestamp?: string };
  spec: {
    instanceId: string; projectId: string;
    templateRef: { name: string; version: string };
    desiredState: string;
    storage: { className: string; capacity: string; deletionPolicy: string };
    access: { exposure: string; credentialsSecretRef: string };
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
  const resources = { cpu: `${input.cpuMillis}m`, memory: `${input.memoryMiB}Mi` };
  return {
    apiVersion: 'cache.expbuild.io/v1alpha1', kind: 'CacheInstance',
    metadata: { name: `c-${id}`, namespace, labels: labels(projectId, id), annotations: { 'cache.expbuild.io/operation-id': operationId, 'cache.expbuild.io/request-hash': requestHash, 'cache.expbuild.io/display-name': input.name } },
    spec: {
      instanceId: id, projectId, templateRef: { name: input.template, version: '0.1.0' }, desiredState: input.desiredState,
      storage: { className: storageClass, capacity: `${input.storageGiB}Gi`, deletionPolicy: input.deletionPolicy },
      access: { exposure: input.exposure, credentialsSecretRef: `c-${id}-auth` },
      eviction: { maxCacheGiB: input.cacheGiB, enginePolicy: input.template === 'bazel-remote' ? 'lru' : 'none' }, resources: { requests: resources, limits: { ...resources } },
    },
  };
}
