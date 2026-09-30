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


// All creation schemas, public capabilities and CR policy mappings live together.
// Disabled templates remain resolvable for existing-instance maintenance.
const templates = [
  {
    name: 'bazel-remote', version: '0.1.0', enginePolicy: 'lru',
    protocols: ['reapi', 'bazel-http'], input: bazelInput,
    capabilities: { capacity: true, statistics: true, lru: true, ttl: false, replicas: 1, policyApplyMode: 'restart', policyCondition: 'PolicyApplied' },
    enabled: (_options: TemplateOptions) => true,
  },
  {
    name: 'webdav-apache', version: '0.1.0', enginePolicy: 'none',
    protocols: ['webdav', 'http'], input: webdavInput,
    capabilities: { capacity: false, statistics: false, lru: false, ttl: false, replicas: 1, policyApplyMode: 'unsupported', policyCondition: 'PolicyApplied' },
    enabled: (options: TemplateOptions) => options.webdavEnabled === true,
  },
] as const;

export type TemplateOptions = { webdavEnabled?: boolean; gatewayEnabled?: boolean };
export const instanceInput = z.union([templates[0].input, templates[1].input]);
export type InstanceInput = z.infer<typeof instanceInput>;

export function templateDefinition(name: string, version?: string) {
  const template = templates.find(t => t.name === name && (version === undefined || t.version === version));
  if (!template) throw new Error('Unsupported template or version');
  return template;
}

export function templateEnabled(name: string, options: TemplateOptions): boolean {
  return templateDefinition(name).enabled(options);
}

export function templateCatalog(options: TemplateOptions) {
  return templates.filter(t => t.enabled(options)).map(t => ({
    name: t.name, version: t.version,
    exposures: options.gatewayEnabled ? ['ClusterInternal', 'Gateway'] : ['ClusterInternal'],
    protocols: [...t.protocols], capabilities: { ...t.capabilities },
    inputSchema: z.toJSONSchema(t.input, { io: 'input' }),
  }));
}
