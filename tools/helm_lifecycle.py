#!/usr/bin/env python3
"""Exercise the shipped Helm chart and public API on a private disposable cluster."""
import base64
import contextlib
import json
import pathlib
import socket
import subprocess
import tempfile
import uuid
from cluster_lifecycle import APACHE, NODE, run, wait
from container_smoke import request


def main():
    name = 'expbuild-helm-' + uuid.uuid4().hex[:10]
    namespace = 'expbuild-system'
    origin = 'https://console.example.test'
    with tempfile.TemporaryDirectory(prefix=name) as directory:
        config = str(pathlib.Path(directory) / 'kubeconfig')
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
            run('kind', 'create', 'cluster', '--name', name, '--kubeconfig', config, '--image', NODE, '--wait', '180s', timeout=480)
            run('kind', 'load', 'docker-image', 'expbuild/operator:test', 'expbuild/admin-api:test', 'expbuild/admin-web:test', '--name', name)
            apply({'apiVersion': 'v1', 'kind': 'Namespace', 'metadata': {'name': namespace, 'labels': {'cache.expbuild.io/control-plane': 'true'}}})
            # Ephemeral test database, never a developer or production database.
            apply({'apiVersion': 'v1', 'kind': 'Pod', 'metadata': {'name': 'postgres', 'namespace': namespace, 'labels': {'app': 'postgres'}}, 'spec': {'containers': [{'name': 'postgres', 'image': 'postgres:18', 'env': [{'name': 'POSTGRES_PASSWORD', 'value': 'isolated-test-only'}], 'readinessProbe': {'exec': {'command': ['pg_isready', '-U', 'postgres']}, 'periodSeconds': 2}}]}})
            apply({'apiVersion': 'v1', 'kind': 'Service', 'metadata': {'name': 'postgres', 'namespace': namespace}, 'spec': {'selector': {'app': 'postgres'}, 'ports': [{'port': 5432}]}})
            kubectl('-n', namespace, 'wait', '--for=condition=Ready', 'pod/postgres', '--timeout=180s')
            for secret_name, data in {'database': {'DATABASE_URL': 'postgresql://postgres:isolated-test-only@postgres:5432/postgres'}, 'encryption': {'OPERATION_ENCRYPTION_KEY': '11'*32}, 'bootstrap': {'ADMIN_EMAIL': 'admin@example.test', 'ADMIN_PASSWORD': 'isolated-password-only'}}.items():
                apply({'apiVersion': 'v1', 'kind': 'Secret', 'metadata': {'name': secret_name, 'namespace': namespace}, 'stringData': data})
            values = pathlib.Path(directory) / 'values.json'
            values.write_text(json.dumps({'images': {'api': 'expbuild/admin-api:test', 'web': 'expbuild/admin-web:test', 'operator': 'expbuild/operator:test', 'bazelRemote': 'example.invalid/unused@sha256:' + 'a'*64, 'webdav': APACHE}, 'appOrigin': origin, 'storageClass': 'standard', 'secrets': {'database': 'database', 'operationEncryption': 'encryption', 'bootstrap': 'bootstrap'}, 'bootstrap': {'enabled': True}, 'ingress': {'enabled': False}}))
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
                spec = {'name': 'WebDAV via API', 'template': 'webdav-apache', 'storageGiB': 2, 'cacheGiB': 0, 'cpuMillis': 100, 'memoryMiB': 128, 'deletionPolicy': 'Delete', 'desiredState': 'Running'}
                created = submit(f'/projects/{pid}/instances', data=spec)
                complete(created)
                iid = created['operation']['instance_id']
                path = f'/projects/{pid}/instances/{iid}'
                resource = 'c-' + iid
                def basic(credentials):
                    token = base64.b64encode((credentials['username'] + ':' + credentials['password']).encode()).decode()
                    return {'Authorization': 'Basic ' + token}
                with connection(ns, resource, 8080) as cache:
                    assert request(cache + '/artifact', 'PUT', b'created through API', basic(created['credentials']))[0] == 201
                for state in ('Suspended', 'Running'):
                    complete(submit(path, 'PATCH', {**spec, 'desiredState': state}, api(path)['revision']))
                rotated = submit(path + '/credentials/rotate', revision=api(path)['revision'])
                complete(rotated)
                with connection(ns, resource, 8080) as cache:
                    assert request(cache + '/artifact', headers=basic(created['credentials']))[0] == 401
                    assert request(cache + '/artifact', headers=basic(rotated['credentials']))[:2] == (200, b'created through API')
                secrets = json.loads(kubectl('-n', ns, 'get', 'secrets', '-l', 'cache.expbuild.io/instance-id=' + iid, '-o', 'json'))['items']
                assert len(secrets) == 1, 'Old credential revisions must be removed after readiness'
                print('API create, pause/resume, persistence and password rotation passed', flush=True)
                # Re-run real upgrade hooks while a provisioned instance still exists.
                helm('upgrade', 'test', 'deploy/charts/expbuild', '-f', str(values), '--wait', '--timeout', '8m')
                assert api(path)['revision']
                with connection(ns, resource, 8080) as cache:
                    assert request(cache + '/artifact', headers=basic(rotated['credentials']))[:2] == (200, b'created through API')
                complete(submit(path, 'DELETE'))
                for kind in ('cacheinstance', 'statefulset', 'service'):
                    assert kubectl('-n', ns, 'get', kind, resource, '--ignore-not-found', '-o', 'name') == ''
                assert kubectl('-n', ns, 'get', 'pvc', resource + '-data', '--ignore-not-found', '-o', 'name') == ''
                assert json.loads(kubectl('-n', ns, 'get', 'secrets', '-l', 'cache.expbuild.io/instance-id=' + iid, '-o', 'json'))['items'] == []
                print('Helm upgrade preserved cache; API deletion removed workload, PVC and credentials', flush=True)
            helm('uninstall', 'test', '--wait', '--timeout', '3m')
            assert kubectl('-n', namespace, 'get', 'deployment', '-l', 'app.kubernetes.io/instance=test', '-o', 'name') == ''
            # CRDs and external database/secrets are intentionally not owned by the release.
            assert kubectl('get', 'crd', 'cacheinstances.cache.expbuild.io', '-o', 'name')
            print('Helm uninstall passed; isolated control-plane E2E passed', flush=True)
        except BaseException:
            for args in [('get', 'pods,jobs,pvc,cacheinstances', '-A', '-o', 'wide'), ('get', 'events', '-A', '--sort-by=.lastTimestamp'), ('-n', namespace, 'logs', 'deployment/test-expbuild-api', '--tail=80'), ('-n', namespace, 'logs', 'deployment/test-expbuild-operator', '--tail=80')]:
                try: print(kubectl(*args), flush=True)
                except Exception: pass
            raise
        finally:
            subprocess.run(['kind', 'delete', 'cluster', '--name', name, '--kubeconfig', config], timeout=180, check=False)


if __name__ == '__main__':
    main()
