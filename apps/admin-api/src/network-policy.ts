import type { V1NetworkPolicy } from '@kubernetes/client-node';
import { labels } from './instance-contract.js';

// Namespace authorization is administered by cluster operators. Pod labels alone
// cannot grant access from an unauthorized namespace.
export function clientAccessPolicy(namespace: string, projectId: string): V1NetworkPolicy {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,47}$/.test(projectId)) throw new Error('Invalid project identity for network access');
  return {
    apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy',
    metadata: { name: 'expbuild-client-access', namespace, labels: labels(projectId) },
    spec: {
      podSelector: { matchLabels: labels(projectId) }, policyTypes: ['Ingress'],
      ingress: [{
        _from: [{
          namespaceSelector: { matchLabels: { [`cache.expbuild.io/access-${projectId}`]: 'true' } },
          podSelector: { matchLabels: { 'cache.expbuild.io/client': 'true' } },
        }],
        ports: [{ protocol: 'TCP', port: 8080 }, { protocol: 'TCP', port: 9092 }],
      }],
    },
  };
}
