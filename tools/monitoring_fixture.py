"""Real Prometheus Operator fixture for caller-owned disposable kind clusters."""
import hashlib
import json
import socket
import subprocess
import urllib.request
from datetime import datetime, timezone
from cluster_lifecycle import wait
from container_smoke import request

VERSION = 'v0.94.1'
BUNDLE_SHA = '7ab177610b271c70c57c7d6fc550a1e934eff4f707a5d8b61dfaa3845d52deea'
OPERATOR = 'quay.io/prometheus-operator/prometheus-operator:v0.94.1@sha256:7c88d4e7bae63bd8d0f8da986054337c23b4472fa8d3c6817f5bc4b8407a2d6a'
RELOADER = 'quay.io/prometheus-operator/prometheus-config-reloader:v0.94.1@sha256:06b52bd4dbe3ed6dd5905aadaf8b9987d9da4c31d37bb86deaadae68cee2d26b'
PROMETHEUS = 'quay.io/prometheus/prometheus:v3.15.0@sha256:efd719c99d83b060d9daefdcf00360461adf279f45ef5391f8d111892118753e'

class MonitoringFixture:
    def __init__(self, kubectl, apply, config, context):
        self.kubectl, self.apply, self.config, self.context = kubectl, apply, config, context
        self.process = None

    @property
    def values(self):
        return {'prometheusURL': 'http://fixture.monitoring.svc:9090', 'serviceMonitor': {'enabled': True, 'namespace': 'monitoring'}}

    def install(self):
        with urllib.request.urlopen(f'https://raw.githubusercontent.com/prometheus-operator/prometheus-operator/{VERSION}/bundle.yaml', timeout=60) as response:
            bundle = response.read()
        assert hashlib.sha256(bundle).hexdigest() == BUNDLE_SHA, 'Prometheus Operator bundle digest mismatch'
        manifest = bundle.decode().replace('quay.io/prometheus-operator/prometheus-operator:'+VERSION, OPERATOR).replace('quay.io/prometheus-operator/prometheus-config-reloader:'+VERSION, RELOADER)
        self.kubectl('apply', '--server-side', '-f', '-', data=manifest)
        self.kubectl('-n', 'default', 'rollout', 'status', 'deployment/prometheus-operator', '--timeout=240s')
        self.apply({'apiVersion': 'v1', 'kind': 'Namespace', 'metadata': {'name': 'monitoring'}})
        self.apply({'apiVersion': 'v1', 'kind': 'ServiceAccount', 'metadata': {'name': 'fixture', 'namespace': 'monitoring'}})
        self.apply({'apiVersion': 'rbac.authorization.k8s.io/v1', 'kind': 'ClusterRole', 'metadata': {'name': 'fixture-prometheus'}, 'rules': [
            {'apiGroups': [''], 'resources': ['nodes', 'nodes/metrics', 'services', 'endpoints', 'pods', 'namespaces'], 'verbs': ['get', 'list', 'watch']},
            {'apiGroups': ['discovery.k8s.io'], 'resources': ['endpointslices'], 'verbs': ['get', 'list', 'watch']},
        ]})
        self.apply({'apiVersion': 'rbac.authorization.k8s.io/v1', 'kind': 'ClusterRoleBinding', 'metadata': {'name': 'fixture-prometheus'}, 'roleRef': {'apiGroup': 'rbac.authorization.k8s.io', 'kind': 'ClusterRole', 'name': 'fixture-prometheus'}, 'subjects': [{'kind': 'ServiceAccount', 'name': 'fixture', 'namespace': 'monitoring'}]})
        self.apply({'apiVersion': 'monitoring.coreos.com/v1', 'kind': 'Prometheus', 'metadata': {'name': 'fixture', 'namespace': 'monitoring'}, 'spec': {
            'replicas': 1, 'version': 'v3.15.0', 'image': PROMETHEUS, 'serviceAccountName': 'fixture',
            'serviceMonitorSelector': {'matchLabels': {'app.kubernetes.io/managed-by': 'expbuild'}},
            'serviceMonitorNamespaceSelector': {'matchLabels': {'app.kubernetes.io/managed-by': 'expbuild'}},
            'podMetadata': {'labels': {'cache.expbuild.io/monitoring': 'true'}},
            'resources': {'requests': {'memory': '256Mi'}, 'limits': {'memory': '512Mi'}}, 'retention': '1h',
        }})
        self.apply({'apiVersion': 'v1', 'kind': 'Service', 'metadata': {'name': 'fixture', 'namespace': 'monitoring'}, 'spec': {'selector': {'prometheus': 'fixture'}, 'ports': [{'port': 9090, 'targetPort': 9090}]}})
        wait(lambda: bool(json.loads(self.kubectl('-n', 'monitoring', 'get', 'pods', '-l', 'prometheus=fixture', '-o', 'json'))['items']), 'Prometheus Pod created')
        self.kubectl('-n', 'monitoring', 'wait', '--for=condition=Ready', 'pod', '-l', 'prometheus=fixture', '--timeout=240s')
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0)); self.port = sock.getsockname()[1]
        self.process = subprocess.Popen(['kubectl', '--kubeconfig', self.config, '--context', self.context, '-n', 'monitoring', 'port-forward', 'service/fixture', f'{self.port}:9090', '--address=127.0.0.1'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        wait(lambda: request(f'http://127.0.0.1:{self.port}/-/ready')[0] == 200, 'Pinned Prometheus Operator and Prometheus ready')

    def targets(self, uid):
        status, body, _ = request(f'http://127.0.0.1:{self.port}/api/v1/targets?state=active')
        assert status == 200
        return [t for t in json.loads(body)['data']['activeTargets'] if t['labels'].get('expbuild_instance_uid') == uid]

    def verify(self, api, path, traffic, after=None):
        detail = api(path)
        uid = detail['revision'].split(':')[0]
        earliest = after or datetime.now(timezone.utc)
        def collected():
            traffic()
            targets = self.targets(uid)
            if len(targets) != 1: return False
            target = targets[0]
            assert target['labels'].get('expbuild_project_id') == path.split('/')[2]
            if target['health'] != 'up': return False
            if datetime.fromisoformat(target['lastScrape'].replace('Z', '+00:00')) < earliest: return False
            history = api(path + '/statistics/history?window=1h')
            return any(s['kind'] == 'cas' and s['method'] == 'get' and s['outcome'] == 'hit' and any(time >= earliest.timestamp() and value is not None and value > 0 for time, value in s['points']) for s in history['series'])
        wait(collected, 'One authenticated scrape target and real CAS lookup history verified')
        return uid

    def removed(self, uid):
        wait(lambda: not self.targets(uid), 'Deleted instance removed from Prometheus targets')

    def close(self):
        if self.process:
            self.process.terminate()
            try: self.process.wait(timeout=10)
            except subprocess.TimeoutExpired: self.process.kill(); self.process.wait()
