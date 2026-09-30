#!/usr/bin/env python3
"""Creates its own disposable kind cluster; never uses the caller's kubeconfig."""
import base64
import contextlib
import json
import pathlib
import socket
import subprocess
import tempfile
import time
import uuid
from container_smoke import request

NODE = 'kindest/node:v1.32.2@sha256:f226345927d7e348497136874b6d207e0b32cc52154ad8323129352923a3142f'
APACHE = 'httpd:2.4.68-trixie@sha256:03f858efb82c25cb0f9962946615cdcdaf26927cb971722149b563197cfd0fdd'
HASH = '$2b$10$Z9RNLYUAIh7a19cBqRUKx.zSNfeY9lgPD3T6/fMX.JC82Or3o/5SW'


def run(*args, data=None, timeout=240):
    return subprocess.check_output(args, input=data, text=True, timeout=timeout).strip()


def wait(check, label, timeout=240):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        try:
            if check():
                print(label, flush=True)
                return
        except (OSError, subprocess.CalledProcessError):
            pass
        time.sleep(2)
    raise RuntimeError('Timed out: ' + label)


def main():
    name = 'expbuild-e2e-' + uuid.uuid4().hex[:10]
    with tempfile.TemporaryDirectory(prefix=name) as directory:
        config = str(pathlib.Path(directory) / 'kubeconfig')
        def kubectl(*args, data=None):
            return run('kubectl', '--kubeconfig', config, '--context', 'kind-' + name, *args, data=data)
        def apply(obj):
            kubectl('apply', '-f', '-', data=json.dumps(obj))
        def get(kind, object_name, ns='expbuild-demo'):
            return json.loads(kubectl('-n', ns, 'get', kind, object_name, '-o', 'json'))
        def ready(instance_name='webdav-demo'):
            obj = get('cacheinstance', instance_name)
            return obj.get('status', {}).get('observedGeneration') == obj['metadata']['generation'] and any(c['type'] == 'Ready' and c['status'] == 'True' and c.get('observedGeneration') == obj['metadata']['generation'] for c in obj.get('status', {}).get('conditions', []))
        def patch(spec):
            kubectl('-n', 'expbuild-demo', 'patch', 'cacheinstance', 'webdav-demo', '--type=merge', '-p', json.dumps({'spec': spec}))
        def secret(secret_name, user, instance_name='webdav-demo'):
            apply({'apiVersion': 'v1', 'kind': 'Secret', 'metadata': {'name': secret_name, 'namespace': 'expbuild-demo', 'labels': {'cache.expbuild.io/project-id': 'demo', 'cache.expbuild.io/instance-id': instance_name}}, 'immutable': True, 'stringData': {'htpasswd': user + ':' + HASH + '\n', 'probe-username': user, 'probe-password': 'engine-test-only'}})
        def auth(user):
            return {'Authorization': 'Basic ' + base64.b64encode((user + ':engine-test-only').encode()).decode()}
        @contextlib.contextmanager
        def connection(remote_port=8080):
            with socket.socket() as sock:
                sock.bind(('127.0.0.1', 0))
                port = sock.getsockname()[1]
            process = subprocess.Popen(['kubectl', '--kubeconfig', config, '--context', 'kind-' + name, '-n', 'expbuild-demo', 'port-forward', 'service/webdav-demo', f'{port}:{remote_port}', '--address=127.0.0.1'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            try:
                url = f'http://127.0.0.1:{port}'
                wait(lambda: request(url + ('/status' if remote_port == 9093 else '/'))[0] == 401, 'HTTP access established')
                yield url
            finally:
                process.terminate()
                try: process.wait(timeout=10)
                except subprocess.TimeoutExpired: process.kill(); process.wait()
        try:
            run('kind', 'create', 'cluster', '--name', name, '--kubeconfig', config, '--image', NODE, '--wait', '180s', timeout=480)
            run('kind', 'load', 'docker-image', 'expbuild/operator:test', '--name', name)
            apply({'apiVersion': 'v1', 'kind': 'Namespace', 'metadata': {'name': 'expbuild-system'}})
            apply({'apiVersion': 'v1', 'kind': 'Namespace', 'metadata': {'name': 'expbuild-demo', 'labels': {'app.kubernetes.io/managed-by': 'expbuild', 'cache.expbuild.io/project-id': 'demo'}}})
            kubectl('apply', '-f', 'operator/config/crd/cache.expbuild.io_cacheinstances.yaml')
            kubectl('wait', '--for=condition=Established', 'crd/cacheinstances.cache.expbuild.io', '--timeout=60s')
            kubectl('apply', '-f', 'operator/config/rbac.yaml')
            apply({'apiVersion': 'apps/v1', 'kind': 'Deployment', 'metadata': {'name': 'operator', 'namespace': 'expbuild-system'}, 'spec': {'replicas': 2, 'selector': {'matchLabels': {'app': 'operator'}}, 'template': {'metadata': {'labels': {'app': 'operator'}}, 'spec': {'serviceAccountName': 'expbuild-operator', 'securityContext': {'runAsNonRoot': True, 'runAsUser': 65532, 'seccompProfile': {'type': 'RuntimeDefault'}}, 'containers': [{'name': 'operator', 'image': 'expbuild/operator:test', 'imagePullPolicy': 'Never', 'args': ['--bazel-remote-image=example.invalid/unused@sha256:' + 'a'*64, '--webdav-image=' + APACHE, '--webdav-stats-image=expbuild/operator:test'], 'securityContext': {'readOnlyRootFilesystem': True, 'allowPrivilegeEscalation': False, 'capabilities': {'drop': ['ALL']}}}]}}}})
            secret('webdav-demo-auth', 'cache')
            kubectl('apply', '-f', 'operator/examples/webdav.yaml')
            wait(ready, 'WebDAV ready through authenticated Operator probe')
            original_spec = get('cacheinstance', 'webdav-demo')['spec']
            volume_uid = get('pvc', 'webdav-demo-data')['metadata']['uid']
            with connection() as url:
                assert request(url + '/artifact', 'PUT', b'persistent payload', auth('cache'))[0] == 201
                assert request(url + '/artifact', headers=auth('cache'))[:2] == (200, b'persistent payload')
            with connection(9093) as url:
                wait(lambda: (lambda status, body: status == 200 and json.loads(body)['itemCount'] == 1 and json.loads(body)['usedBytes'] == len(b'persistent payload'))(*request(url + '/status', headers=auth('cache'))[:2]), 'WebDAV content statistics sampled')
            # Remove a cache Pod: StatefulSet must restore it and preserve PVC data.
            pod_uid = get('pod', 'webdav-demo-0')['metadata']['uid']
            kubectl('-n', 'expbuild-demo', 'delete', 'pod', 'webdav-demo-0', '--wait=true')
            wait(lambda: get('pod', 'webdav-demo-0')['metadata']['uid'] != pod_uid and ready(), 'Cache Pod recovered')
            patch({'desiredState': 'Suspended'})
            wait(lambda: any(c.get('reason') == 'Suspended' and c.get('observedGeneration') == get('cacheinstance', 'webdav-demo')['metadata']['generation'] for c in get('cacheinstance', 'webdav-demo').get('status', {}).get('conditions', [])), 'Instance suspended')
            assert json.loads(kubectl('-n', 'expbuild-demo', 'get', 'pods', '-o', 'json'))['items'] == []
            patch({'desiredState': 'Running'})
            wait(ready, 'Instance resumed')
            with connection() as url:
                assert request(url + '/artifact', headers=auth('cache'))[:2] == (200, b'persistent payload')
            secret('webdav-demo-auth-rotated', 'new-cache')
            patch({'access': {'credentialsSecretRef': 'webdav-demo-auth-rotated'}})
            wait(ready, 'Credential rollout ready')
            with connection() as url:
                assert request(url + '/artifact', headers=auth('cache'))[0] == 401
                assert request(url + '/artifact', headers=auth('new-cache'))[:2] == (200, b'persistent payload')
            with connection(9093) as url:
                assert request(url + '/status', headers=auth('cache'))[0] == 401
                assert request(url + '/status', headers=auth('new-cache'))[0] == 200
            lease = get('lease', 'expbuild-cache-operator', 'expbuild-system')
            holder = lease['spec']['holderIdentity']
            pods = json.loads(kubectl('-n', 'expbuild-system', 'get', 'pods', '-o', 'json'))['items']
            leader = next(p['metadata']['name'] for p in pods if holder.startswith(p['metadata']['name'] + '_'))
            kubectl('-n', 'expbuild-system', 'delete', 'pod', leader, '--wait=true')
            wait(lambda: get('lease', 'expbuild-cache-operator', 'expbuild-system')['spec']['holderIdentity'] != holder and ready(), 'Operator leadership recovered')
            kubectl('-n', 'expbuild-demo', 'delete', 'cacheinstance', 'webdav-demo', '--wait=true', '--timeout=180s')
            assert get('pvc', 'webdav-demo-data')['metadata']['uid'] == volume_uid
            wait(lambda: json.loads(kubectl('-n', 'expbuild-demo', 'get', 'pods', '-o', 'json'))['items'] == [], 'Retain deletion stopped Pods and preserved PVC')
            original_spec['instanceId'] = 'webdav-delete'
            original_spec['access']['credentialsSecretRef'] = 'webdav-delete-auth'
            original_spec['storage']['deletionPolicy'] = 'Delete'
            secret('webdav-delete-auth', 'cache', 'webdav-delete')
            apply({'apiVersion': 'cache.expbuild.io/v1alpha1', 'kind': 'CacheInstance', 'metadata': {'name': 'webdav-delete', 'namespace': 'expbuild-demo'}, 'spec': original_spec})
            wait(lambda: ready('webdav-delete'), 'Delete-policy instance ready')
            kubectl('-n', 'expbuild-demo', 'delete', 'cacheinstance', 'webdav-delete', '--wait=true', '--timeout=180s')
            assert kubectl('-n', 'expbuild-demo', 'get', 'pvc', 'webdav-delete-data', '--ignore-not-found', '-o', 'name') == ''
            print('Delete policy removed PVC', flush=True)
            print('Isolated WebDAV lifecycle passed', flush=True)
        except BaseException:
            for args in [('get', 'pods,pvc,statefulsets,cacheinstances', '-A', '-o', 'wide'), ('get', 'events', '-A', '--sort-by=.lastTimestamp'), ('-n', 'expbuild-system', 'logs', 'deployment/operator', '--all-pods=true', '--tail=100')]:
                try: print(kubectl(*args), flush=True)
                except Exception: pass
            raise
        finally:
            subprocess.run(['kind', 'delete', 'cluster', '--name', name, '--kubeconfig', config], timeout=180, check=False)


if __name__ == '__main__':
    main()
