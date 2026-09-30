#!/usr/bin/env python3
"""Exercise the shipped Helm chart and public API on a private disposable cluster."""
import base64
import contextlib
import json
import os
import hashlib
import pathlib
import socket
import sys
from urllib.parse import urlparse
from gateway_fixture import GatewayFixture
from monitoring_fixture import MonitoringFixture
from network_fixture import NetworkFixture
from datetime import datetime, timezone
import subprocess
import tempfile
import uuid
from cluster_lifecycle import APACHE, NODE, run, wait
from container_smoke import request


def main(gateway_enabled=False, isolation_enabled=False):
    name = 'expbuild-helm-' + uuid.uuid4().hex[:10]
    namespace = 'expbuild-system'
    origin = 'https://console.example.test'
    with tempfile.TemporaryDirectory(prefix=name) as directory:
        config = str(pathlib.Path(directory) / 'kubeconfig')
        gateway = None
        monitoring = None
        network = None
        def kubectl(*args, data=None):
            return run('kubectl', '--kubeconfig', config, '--context', 'kind-' + name, *args, data=data)
        def apply(obj):
            kubectl('apply', '-f', '-', data=json.dumps(obj))
        def helm(*args):
            return run('helm', '--kubeconfig', config, '--kube-context', 'kind-' + name, '-n', namespace, *args, timeout=600)
        @contextlib.contextmanager
        def connection(ns, service, target=80):
            with socket.socket() as sock:
                sock.bind(('127.0.0.1', 0))
                port = sock.getsockname()[1]
            process = subprocess.Popen(['kubectl', '--kubeconfig', config, '--context', 'kind-' + name, '-n', ns, 'port-forward', 'service/' + service, f'{port}:{target}', '--address=127.0.0.1'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            try:
                url = f'http://127.0.0.1:{port}'
                wait(lambda: request(url + '/')[0] in (200, 401, 404), 'Service forwarding established')
                yield url
            finally:
                process.terminate()
                try: process.wait(timeout=10)
                except subprocess.TimeoutExpired: process.kill(); process.wait()
        try:
            extra = []
            if isolation_enabled:
                kind_config = pathlib.Path(directory) / 'kind.json'
                kind_config.write_text(json.dumps({'kind': 'Cluster', 'apiVersion': 'kind.x-k8s.io/v1alpha4', 'networking': {'disableDefaultCNI': True}, 'nodes': [{'role': 'control-plane'}]}))
                extra = ['--config', str(kind_config)]
            run('kind', 'create', 'cluster', '--name', name, '--kubeconfig', config, '--image', NODE, '--wait', '0s' if isolation_enabled else '180s', *extra, timeout=480)
            if isolation_enabled:
                network = NetworkFixture(kubectl, apply, directory, config, 'kind-' + name)
                network.install()
            run('kind', 'load', 'docker-image', 'expbuild/operator:test', 'expbuild/admin-api:test', 'expbuild/admin-web:test', '--name', name)
            apply({'apiVersion': 'v1', 'kind': 'Namespace', 'metadata': {'name': namespace, 'labels': {'cache.expbuild.io/control-plane': 'true'}}})
            # Ephemeral test database, never a developer or production database.
            apply({'apiVersion': 'v1', 'kind': 'Pod', 'metadata': {'name': 'postgres', 'namespace': namespace, 'labels': {'app': 'postgres'}}, 'spec': {'containers': [{'name': 'postgres', 'image': 'postgres:18', 'env': [{'name': 'POSTGRES_PASSWORD', 'value': 'isolated-test-only'}], 'readinessProbe': {'exec': {'command': ['pg_isready', '-U', 'postgres']}, 'periodSeconds': 2}}]}})
            apply({'apiVersion': 'v1', 'kind': 'Service', 'metadata': {'name': 'postgres', 'namespace': namespace}, 'spec': {'selector': {'app': 'postgres'}, 'ports': [{'port': 5432}]}})
            kubectl('-n', namespace, 'wait', '--for=condition=Ready', 'pod/postgres', '--timeout=180s')
            for secret_name, data in {'database': {'DATABASE_URL': 'postgresql://postgres:isolated-test-only@postgres:5432/postgres'}, 'encryption': {'OPERATION_ENCRYPTION_KEY': '11'*32}, 'bootstrap': {'ADMIN_EMAIL': 'admin@example.test', 'ADMIN_PASSWORD': 'isolated-password-only'}}.items():
                apply({'apiVersion': 'v1', 'kind': 'Secret', 'metadata': {'name': secret_name, 'namespace': namespace}, 'stringData': data})
            if gateway_enabled:
                gateway = GatewayFixture(kubectl, apply, directory, config, 'kind-' + name)
                gateway.install()
                monitoring = MonitoringFixture(kubectl, apply, config, 'kind-' + name)
                monitoring.install()
            values = pathlib.Path(directory) / 'values.json'
            values.write_text(json.dumps({'images': {'api': 'expbuild/admin-api:test', 'web': 'expbuild/admin-web:test', 'operator': 'expbuild/operator:test', 'bazelRemote': 'buchgr/bazel-remote-cache:v2.6.2@sha256:8109f1f39eb17d898cf51e08b41e4eabaaaeb1f584c2f22c1be45b7568fcc512', 'webdav': APACHE}, 'appOrigin': origin, 'storageClass': 'standard', 'secrets': {'database': 'database', 'operationEncryption': 'encryption', 'bootstrap': 'bootstrap'}, 'bootstrap': {'enabled': True}, 'ingress': {'enabled': False}}))
            if gateway:
                settings = json.loads(values.read_text())
                settings['gateway'] = gateway.values
                settings['monitoring'] = monitoring.values
                values.write_text(json.dumps(settings))
            helm('install', 'test', 'deploy/charts/expbuild', '-f', str(values), '--wait', '--timeout', '8m')
            print('Helm install, migration, bootstrap and workload readiness passed', flush=True)
            with connection(namespace, 'test-expbuild-web') as url:
                assert request(url + '/')[0] == 200
            with connection(namespace, 'test-expbuild-api') as url:
                status, body, headers = request(url + '/v1/auth/login', 'POST', json.dumps({'email': 'admin@example.test', 'password': 'isolated-password-only'}).encode(), {'Content-Type': 'application/json', 'Origin': origin})
                assert status == 200, 'Login failed: ' + str(status)
                auth = {'Cookie': headers['Set-Cookie'].split(';')[0], 'Origin': origin, 'x-csrf-token': json.loads(body)['csrfToken']}
                def api(path, method='GET', data=None, extra=None, expected=200):
                    request_headers = {**auth, **(extra or {})}
                    if data is not None: request_headers['Content-Type'] = 'application/json'
                    status, body, _ = request(url + '/v1' + path, method, None if data is None else json.dumps(data).encode(), request_headers)
                    assert status == expected, f'{method} {path}: expected {expected}, got {status}'
                    return json.loads(body)
                def submit(path, method='POST', data=None, revision=None):
                    headers = {'Idempotency-Key': str(uuid.uuid4())}
                    if revision: headers['If-Match'] = revision
                    return api(path, method, data, headers, 202)
                project = api('/projects', 'POST', {'name': 'Helm E2E'}, expected=202)
                pid, ns = project['id'], project['namespace']
                wait(lambda: any(p['id'] == pid and p['state'] == 'ready' for p in api('/projects')['items']), 'Worker initialized project namespace and policies')
                def complete(result):
                    op = result['operation']['id']
                    def check():
                        operation = api(f'/projects/{pid}/operations/{op}')
                        assert operation['state'] != 'failed', f'Operation failed: {operation.get("error_code")}'
                        return operation['state'] == 'succeeded'
                    wait(check, 'Operation succeeded: ' + op)
                quota_path = f'/projects/{pid}/quota'
                initial_quota = api(quota_path)
                quota_limits = {'instances': 1, 'storageGiB': 3, 'cpuMillis': 1000, 'memoryMiB': 1024}
                api(quota_path, 'PUT', quota_limits, {'If-Match': initial_quota['revision']})
                spec = {'name': 'WebDAV via API', 'template': 'webdav-apache', 'storageGiB': 2, 'cacheGiB': 0, 'cpuMillis': 100, 'memoryMiB': 128, 'deletionPolicy': 'Delete', 'desiredState': 'Running'}
                if gateway: spec['exposure'] = 'Gateway'
                created = submit(f'/projects/{pid}/instances', data=spec)
                complete(created)
                assert api(quota_path)['reserved'] == {'instances': 1, 'storageGiB': 2, 'cpuMillis': 100, 'memoryMiB': 128}
                rejected = api(f'/projects/{pid}/instances', 'POST', spec, {'Idempotency-Key': str(uuid.uuid4())}, 409)
                assert rejected['error'] == 'Project quota exceeded: instances'
                assert len(json.loads(kubectl('-n', ns, 'get', 'cacheinstances', '-o', 'json'))['items']) == 1
                iid = created['operation']['instance_id']
                path = f'/projects/{pid}/instances/{iid}'
                resource = 'c-' + iid
                def basic(credentials):
                    token = base64.b64encode((credentials['username'] + ':' + credentials['password']).encode()).decode()
                    return {'Authorization': 'Basic ' + token}
                with connection(ns, resource, 8080) as cache:
                    assert request(cache + '/artifact', 'PUT', b'created through API', basic(created['credentials']))[0] == 201
                if gateway:
                    host = urlparse(api(path)['status']['endpoints'][0]['url']).hostname
                    gateway.forward()
                    gateway.verify(host, basic(created['credentials']))
                for state in ('Suspended', 'Running'):
                    complete(submit(path, 'PATCH', {**spec, 'desiredState': state}, api(path)['revision']))
                    assert api(quota_path)['reserved']['cpuMillis'] == 100, 'Suspension retains compute reservations'
                    if gateway:
                        if state == 'Suspended':
                            assert kubectl('-n', ns, 'get', 'httproute', resource + '-http', '--ignore-not-found', '-o', 'name') == ''
                            wait(lambda: gateway.request(host, '/artifact', headers=basic(created['credentials']))[0] in (404, 503), 'Suspension revoked external route')
                        else:
                            wait(lambda: gateway.request(host, '/artifact', headers=basic(created['credentials']))[:2] == (200, b'created through API'), 'Resumed HTTPS route preserved data')
                rotated = submit(path + '/credentials/rotate', revision=api(path)['revision'])
                complete(rotated)
                with connection(ns, resource, 8080) as cache:
                    assert request(cache + '/artifact', headers=basic(created['credentials']))[0] == 401
                    assert request(cache + '/artifact', headers=basic(rotated['credentials']))[:2] == (200, b'created through API')
                if gateway:
                    assert gateway.request(host, '/artifact', headers=basic(created['credentials']))[0] == 401
                    assert gateway.request(host, '/artifact', headers=basic(rotated['credentials']))[:2] == (200, b'created through API')
                secrets = json.loads(kubectl('-n', ns, 'get', 'secrets', '-l', 'cache.expbuild.io/instance-id=' + iid, '-o', 'json'))['items']
                assert len(secrets) == 1, 'Old credential revisions must be removed after readiness'
                print('API create, pause/resume, persistence and password rotation passed', flush=True)
                # Re-run real upgrade hooks while a provisioned instance still exists.
                helm('upgrade', 'test', 'deploy/charts/expbuild', '-f', str(values), '--wait', '--timeout', '8m')
                assert api(path)['revision']
                with connection(ns, resource, 8080) as cache:
                    assert request(cache + '/artifact', headers=basic(rotated['credentials']))[:2] == (200, b'created through API')
                complete(submit(path, 'DELETE'))
                if gateway:
                    wait(lambda: gateway.request(host, '/artifact', headers=basic(rotated['credentials']))[0] in (404, 503), 'Deletion revoked external route')
                for kind in ('cacheinstance', 'statefulset', 'service'):
                    assert kubectl('-n', ns, 'get', kind, resource, '--ignore-not-found', '-o', 'name') == ''
                assert kubectl('-n', ns, 'get', 'pvc', resource + '-data', '--ignore-not-found', '-o', 'name') == ''
                assert json.loads(kubectl('-n', ns, 'get', 'secrets', '-l', 'cache.expbuild.io/instance-id=' + iid, '-o', 'json'))['items'] == []
                print('Helm upgrade preserved cache; API deletion removed workload, PVC and credentials', flush=True)
                retained = submit(f'/projects/{pid}/instances', data={**spec, 'name': 'Retained cache', 'deletionPolicy': 'Retain'})
                complete(retained)
                retained_id = retained['operation']['instance_id']
                retained_path = f'/projects/{pid}/instances/{retained_id}'
                complete(submit(retained_path, 'DELETE'))
                volume = api(retained_path + '/retained-volume')
                assert api(quota_path)['reserved'] == {'instances': 0, 'storageGiB': 2, 'cpuMillis': 0, 'memoryMiB': 0}
                actual = json.loads(kubectl('-n', ns, 'get', 'pvc', volume['name'], '-o', 'json'))
                assert volume['uid'] == actual['metadata']['uid']
                complete(submit(retained_path + '/retained-volume', 'DELETE', revision=volume['uid']))
                assert kubectl('-n', ns, 'get', 'pvc', volume['name'], '--ignore-not-found', '-o', 'name') == ''
                assert api(retained_path)['lifecycle'] == 'deleted'
                assert api(quota_path)['reserved'] == {'instances': 0, 'storageGiB': 0, 'cpuMillis': 0, 'memoryMiB': 0}
                print('Project quotas rejected excess admission and released reservations after confirmed cleanup', flush=True)
                print('Retain storage inspection and explicit API cleanup passed', flush=True)
                if gateway:
                    reapi_spec = {**spec, 'template': 'bazel-remote', 'name': 'REAPI via TLS', 'storageGiB': 3, 'cacheGiB': 1, 'memoryMiB': 512}
                    reapi = submit(f'/projects/{pid}/instances', data=reapi_spec)
                    complete(reapi)
                    reapi_id = reapi['operation']['instance_id']
                    reapi_path = f'/projects/{pid}/instances/{reapi_id}'
                    detail = api(reapi_path)
                    policy = next(c for c in detail['status']['conditions'] if c['type'] == 'PolicyApplied')
                    assert policy['status'] == 'True' and str(policy['observedGeneration']) == detail['revision'].split(':')[-1]
                    endpoints = detail['status']['endpoints']
                    grpc_host = urlparse(next(e['url'] for e in endpoints if e['protocol'] == 'reapi')).hostname
                    http_host = urlparse(next(e['url'] for e in endpoints if e['protocol'] == 'bazel-http')).hostname
                    def grpc_contract(credentials, phase, old_password=''):
                        fixture = pathlib.Path(directory) / 'reapi-fixture.json'
                        fixture.touch(mode=0o600, exist_ok=True)
                        fixture.write_text(json.dumps({'Address': f'127.0.0.1:{gateway.port}', 'Host': grpc_host, 'CA': str(pathlib.Path(directory) / 'ca.crt'), 'Username': credentials['username'], 'Password': credentials['password'], 'OldPassword': old_password, 'Phase': phase}))
                        try:
                            subprocess.run(['go', 'test', './internal/controller', '-run', '^TestGatewayREAPIContract$', '-count=1', '-v'], cwd='operator', env={**os.environ, 'GATEWAY_REAPI_FIXTURE': str(fixture)}, check=True, timeout=180)
                        finally: fixture.unlink(missing_ok=True)
                    if network: network.verify(pid, ns, 'c-' + reapi_id)
                    grpc_contract(reapi['credentials'], 'write')
                    artifact = b'Bazel HTTP through TLS'
                    cas_path = '/cas/' + hashlib.sha256(artifact).hexdigest()
                    assert gateway.request(http_host, cas_path, 'PUT', artifact, basic(reapi['credentials']))[0] == 200
                    assert gateway.request(http_host, cas_path, headers=basic(reapi['credentials']))[:2] == (200, artifact)
                    complete(submit(reapi_path, 'PATCH', {**reapi_spec, 'cacheGiB': 2}, api(reapi_path)['revision']))
                    adjusted = api(reapi_path)
                    applied = next(c for c in adjusted['status']['conditions'] if c['type'] == 'PolicyApplied')
                    assert applied['status'] == 'True' and str(applied['observedGeneration']) == adjusted['revision'].split(':')[-1]
                    assert api(reapi_path + '/statistics')['capacityBytes'] == 2 * 1024**3
                    assert gateway.request(http_host, cas_path, headers=basic(reapi['credentials']))[:2] == (200, artifact)
                    print('Cache budget update applied to running engine and preserved data', flush=True)
                    def traffic(credentials):
                        assert gateway.request(http_host, cas_path, headers=basic(credentials))[:2] == (200, artifact)
                    assert gateway.request(http_host, '/metrics')[0] == 401
                    assert gateway.request(http_host, '/metrics', headers=basic(reapi['credentials']))[0] == 200
                    metric_uid = monitoring.verify(api, reapi_path, lambda: traffic(reapi['credentials']))
                    changed = submit(reapi_path + '/credentials/rotate', revision=api(reapi_path)['revision'])
                    complete(changed)
                    rotation_finished = datetime.now(timezone.utc)
                    grpc_contract(changed['credentials'], 'read', reapi['credentials']['password'])
                    assert gateway.request(http_host, cas_path, headers=basic(reapi['credentials']))[0] == 401
                    assert gateway.request(http_host, cas_path, headers=basic(changed['credentials']))[:2] == (200, artifact)
                    assert gateway.request(http_host, '/metrics', headers=basic(reapi['credentials']))[0] == 401
                    assert gateway.request(http_host, '/metrics', headers=basic(changed['credentials']))[0] == 200
                    monitoring.verify(api, reapi_path, lambda: traffic(changed['credentials']), after=rotation_finished)
                    complete(submit(reapi_path, 'DELETE'))
                    assert kubectl('-n', ns, 'get', 'httproute,grpcroute', '-l', 'cache.expbuild.io/instance-id=' + reapi_id, '-o', 'name') == ''
                    assert kubectl('-n', ns, 'get', 'servicemonitor', 'c-' + reapi_id + '-metrics', '--ignore-not-found', '-o', 'name') == ''
                    monitoring.removed(metric_uid)
                    print('REAPI TLS and automatic metrics collection, credential rotation and cleanup passed', flush=True)
            helm('uninstall', 'test', '--wait', '--timeout', '3m')
            assert kubectl('-n', namespace, 'get', 'deployment', '-l', 'app.kubernetes.io/instance=test', '-o', 'name') == ''
            # CRDs and external database/secrets are intentionally not owned by the release.
            assert kubectl('get', 'crd', 'cacheinstances.cache.expbuild.io', '-o', 'name')
            print('Helm uninstall passed; isolated control-plane E2E passed', flush=True)
        except BaseException:
            if network:
                for args in [('-n', 'kube-system', 'logs', 'daemonset/cilium', '--tail=80'), ('get', 'networkpolicies,ciliumendpoints', '-A', '-o', 'wide')]:
                    try: print(kubectl(*args), flush=True)
                    except Exception: pass
            if monitoring:
                for args in [('-n', 'default', 'logs', 'deployment/prometheus-operator', '--tail=60'), ('-n', 'monitoring', 'get', 'prometheus,pods', '-o', 'wide'), ('get', 'servicemonitors', '-A', '-o', 'yaml')]:
                    try: print(kubectl(*args), flush=True)
                    except Exception: pass
            if gateway:
                for args in [('get', 'gateway,httproute,grpcroute', '-A', '-o', 'yaml'), ('-n', 'edge', 'logs', 'deployment/envoy-gateway', '--tail=80')]:
                    try: print(kubectl(*args), flush=True)
                    except Exception: pass
            for args in [('get', 'pods,jobs,pvc,cacheinstances', '-A', '-o', 'wide'), ('get', 'events', '-A', '--sort-by=.lastTimestamp'), ('-n', namespace, 'logs', 'deployment/test-expbuild-api', '--tail=80'), ('-n', namespace, 'logs', 'deployment/test-expbuild-operator', '--tail=80')]:
                try: print(kubectl(*args), flush=True)
                except Exception: pass
            raise
        finally:
            if monitoring: monitoring.close()
            if gateway: gateway.close()
            subprocess.run(['kind', 'delete', 'cluster', '--name', name, '--kubeconfig', config], timeout=180, check=False)


if __name__ == '__main__':
    if sys.argv[1:] not in ([], ['--gateway'], ['--gateway', '--isolation']): raise SystemExit('Usage: helm_lifecycle.py [--gateway [--isolation]]')
    main(gateway_enabled='--gateway' in sys.argv, isolation_enabled='--isolation' in sys.argv)
