"""NetworkPolicy enforcement tests, only inside a caller-owned kind cluster."""
import hashlib
import json
import pathlib
import subprocess
import time
from cluster_lifecycle import run, wait

VERSION = '1.19.7'
CHART_SHA = 'af6aeba999b438b897e71452051aab2c014bb89369ab34ca46a33003eb0d017e'
PROBE = r'''
const net = require('node:net');
const input = JSON.parse(require('node:fs').readFileSync(0, 'utf8'));
Promise.all(input.ports.map(port => new Promise(resolve => {
  const socket = net.createConnection({host:input.host, port, timeout:2500});
  socket.once('connect', () => {socket.destroy(); resolve('open');});
  socket.once('timeout', () => {socket.destroy(); resolve('timeout');});
  socket.once('error', error => {socket.destroy(); resolve('error:'+error.code);});
}))).then(result => console.log(JSON.stringify(result)));
'''

class NetworkFixture:
    def __init__(self, kubectl, apply, directory, config, context):
        self.kubectl, self.apply = kubectl, apply
        self.root, self.config, self.context = pathlib.Path(directory), config, context

    def install(self):
        for attempt in range(3):
            try:
                run('helm', 'pull', 'cilium', '--repo', 'https://helm.cilium.io', '--version', VERSION, '--destination', str(self.root))
                break
            except subprocess.CalledProcessError:
                if attempt == 2:
                    raise
                time.sleep(2 ** attempt)
        chart = self.root / f'cilium-{VERSION}.tgz'
        assert hashlib.sha256(chart.read_bytes()).hexdigest() == CHART_SHA, 'Cilium Chart digest mismatch'
        values = self.root / 'cilium-values.json'
        values.write_text(json.dumps({'ipam': {'mode': 'kubernetes'}, 'kubeProxyReplacement': False, 'operator': {'replicas': 1}, 'envoy': {'enabled': False}, 'hubble': {'enabled': False}}))
        # The checksum locks the upstream image digests in this chart, too.
        rendered = run('helm', 'template', 'cilium', str(chart), '-n', 'kube-system', '-f', str(values))
        images = [line.strip().split('image:', 1)[1].strip().strip('"') for line in rendered.splitlines() if line.strip().startswith('image:')]
        assert images and all('@sha256:' in image for image in images), 'CNI image is not digest-pinned'
        run('helm', '--kubeconfig', self.config, '--kube-context', self.context, 'install', 'cilium', str(chart), '-n', 'kube-system', '-f', str(values), '--wait', '--timeout', '8m', timeout=600)
        self.kubectl('wait', '--for=condition=Ready', 'node', '--all', '--timeout=180s')
        print('Pinned Cilium installed; real NetworkPolicy enforcement enabled', flush=True)

    def pod(self, namespace, name, labels):
        self.apply({'apiVersion': 'v1', 'kind': 'Pod', 'metadata': {'namespace': namespace, 'name': name, 'labels': labels}, 'spec': {
            'automountServiceAccountToken': False,
            'securityContext': {'runAsNonRoot': True, 'runAsUser': 1000, 'runAsGroup': 1000, 'seccompProfile': {'type': 'RuntimeDefault'}},
            'containers': [{'resources': {'requests': {'cpu': '20m', 'memory': '64Mi'}, 'limits': {'cpu': '20m', 'memory': '64Mi'}}, 'name': 'probe', 'image': 'expbuild/admin-api:test', 'imagePullPolicy': 'Never', 'command': ['node', '-e', 'setInterval(() => {}, 60000)'],
                            'securityContext': {'allowPrivilegeEscalation': False, 'capabilities': {'drop': ['ALL']}, 'readOnlyRootFilesystem': True}}],
        }})
        self.kubectl('-n', namespace, 'wait', '--for=condition=Ready', 'pod/'+name, '--timeout=120s')

    def verify(self, project, namespace, resource):
        access = 'cache.expbuild.io/access-'+project
        self.apply({'apiVersion': 'v1', 'kind': 'Namespace', 'metadata': {'name': 'np-authorized', 'labels': {access: 'true'}}})
        self.apply({'apiVersion': 'v1', 'kind': 'Namespace', 'metadata': {'name': 'np-foreign', 'labels': {'cache.expbuild.io/access-other-project': 'true'}}})
        sources = [
            ('np-authorized', 'allowed', {'cache.expbuild.io/client': 'true'}, ['open', 'open']),
            ('np-authorized', 'unlabeled', {}, ['timeout', 'timeout']),
            ('np-foreign', 'client', {'cache.expbuild.io/client': 'true'}, ['timeout', 'timeout']),
            ('np-foreign', 'spoofed', {'cache.expbuild.io/client': 'true', 'cache.expbuild.io/gateway': 'true', 'cache.expbuild.io/monitoring': 'true'}, ['timeout', 'timeout']),
            ('edge', 'unlabeled', {}, ['timeout', 'timeout']),
            ('edge', 'router', {'cache.expbuild.io/gateway': 'true'}, ['open', 'open']),
            ('monitoring', 'unlabeled', {}, ['timeout', 'timeout']),
            ('monitoring', 'collector', {'cache.expbuild.io/monitoring': 'true'}, ['open', 'timeout']),
            (namespace, 'untrusted-peer', {}, ['timeout', 'timeout']),
        ]
        for ns, pod, labels, _ in sources: self.pod(ns, pod, labels)
        service = json.loads(self.kubectl('-n', namespace, 'get', 'service', resource, '-o', 'json'))['spec']['clusterIP']
        pod_ip = json.loads(self.kubectl('-n', namespace, 'get', 'pod', resource+'-0', '-o', 'json'))['status']['podIP']
        def check(ns, pod, host, expected):
            def probe():
                actual = json.loads(self.kubectl('-n', ns, 'exec', '-i', pod, '--', 'node', '-e', PROBE, data=json.dumps({'host': host, 'ports': [8080, 9092]})))
                return actual == expected
            wait(probe, f'Network boundary verified: {ns}/{pod} to {host}: {expected}')
        for host in [service, pod_ip]:
            for ns, pod, _, expected in sources: check(ns, pod, host, expected)
        self.kubectl('label', 'namespace', 'np-authorized', access+'-')
        for host in [service, pod_ip]: check('np-authorized', 'allowed', host, ['timeout', 'timeout'])
        self.kubectl('label', 'namespace', 'np-authorized', access+'=true')
        for host in [service, pod_ip]: check('np-authorized', 'allowed', host, ['open', 'open'])
        self.kubectl('-n', 'np-authorized', 'label', 'pod', 'allowed', 'cache.expbuild.io/client-')
        for host in [service, pod_ip]: check('np-authorized', 'allowed', host, ['timeout', 'timeout'])
        self.kubectl('-n', 'np-authorized', 'label', 'pod', 'allowed', 'cache.expbuild.io/client=true')
        for host in [service, pod_ip]: check('np-authorized', 'allowed', host, ['open', 'open'])
        print('Cilium enforced project, client, gateway and monitoring boundaries plus authorization revocation', flush=True)
