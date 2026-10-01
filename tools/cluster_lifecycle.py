#!/usr/bin/env python3
"""Creates its own disposable kind cluster; never uses the caller's kubeconfig."""
import base64
import contextlib
import json
import pathlib
import re
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


def pin_loaded_image(cluster_name, image):
    """Add a digest reference to an image that kind loaded from the local Docker daemon."""
    node = cluster_name + '-control-plane'
    source = 'docker.io/' + image
    image_row = next(row for row in run('docker', 'exec', node, 'ctr', '-n', 'k8s.io', 'images', 'ls').splitlines() if row.startswith(source + ' '))
    manifest = re.search(r'\bsha256:[a-f0-9]{64}\b', image_row).group()
    pinned = source.rsplit(':', 1)[0] + '@' + manifest
    run('docker', 'exec', node, 'ctr', '-n', 'k8s.io', 'images', 'tag', source, pinned)
    return pinned


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
        def patch(spec, instance_name='webdav-demo'):
            kubectl('-n', 'expbuild-demo', 'patch', 'cacheinstance', instance_name, '--type=merge', '-p', json.dumps({'spec': spec}))
        def secret(secret_name, user, instance_name='webdav-demo'):
            apply({'apiVersion': 'v1', 'kind': 'Secret', 'metadata': {'name': secret_name, 'namespace': 'expbuild-demo', 'labels': {'cache.expbuild.io/project-id': 'demo', 'cache.expbuild.io/instance-id': instance_name}}, 'immutable': True, 'stringData': {'htpasswd': user + ':' + HASH + '\n', 'probe-username': user, 'probe-password': 'engine-test-only'}})
        def auth(user):
            return {'Authorization': 'Basic ' + base64.b64encode((user + ':engine-test-only').encode()).decode()}
        @contextlib.contextmanager
        def connection(remote_port=8080, instance_name='webdav-demo', unauthorized_path=None):
            with socket.socket() as sock:
                sock.bind(('127.0.0.1', 0))
                port = sock.getsockname()[1]
            process = subprocess.Popen(['kubectl', '--kubeconfig', config, '--context', 'kind-' + name, '-n', 'expbuild-demo', 'port-forward', 'service/' + instance_name, f'{port}:{remote_port}', '--address=127.0.0.1'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            try:
                url = f'http://127.0.0.1:{port}'
                path = unauthorized_path if unauthorized_path is not None else ('/status' if remote_port == 9093 else '/')
                wait(lambda: request(url + path)[0] == 401, 'HTTP access established')
                yield url
            finally:
                process.terminate()
                try: process.wait(timeout=10)
                except subprocess.TimeoutExpired: process.kill(); process.wait()
        try:
            run('kind', 'create', 'cluster', '--name', name, '--kubeconfig', config, '--image', NODE, '--wait', '180s', timeout=480)
            run('kind', 'load', 'docker-image', 'expbuild/operator:test', '--name', name)
            run('kind', 'load', 'docker-image', 'expbuild/gradle-cache:test', '--name', name)
            # Keep the production digest-only image contract in this test.
            gradle_image = pin_loaded_image(name, 'expbuild/gradle-cache:test')
            apply({'apiVersion': 'v1', 'kind': 'Namespace', 'metadata': {'name': 'expbuild-system'}})
            apply({'apiVersion': 'v1', 'kind': 'Namespace', 'metadata': {'name': 'expbuild-demo', 'labels': {'app.kubernetes.io/managed-by': 'expbuild', 'cache.expbuild.io/project-id': 'demo'}}})
            kubectl('apply', '-f', 'operator/config/crd/cache.expbuild.io_cacheinstances.yaml')
            kubectl('wait', '--for=condition=Established', 'crd/cacheinstances.cache.expbuild.io', '--timeout=60s')
            kubectl('apply', '-f', 'operator/config/rbac.yaml')
            apply({'apiVersion': 'apps/v1', 'kind': 'Deployment', 'metadata': {'name': 'operator', 'namespace': 'expbuild-system'}, 'spec': {'replicas': 2, 'selector': {'matchLabels': {'app': 'operator'}}, 'template': {'metadata': {'labels': {'app': 'operator'}}, 'spec': {'serviceAccountName': 'expbuild-operator', 'securityContext': {'runAsNonRoot': True, 'runAsUser': 65532, 'seccompProfile': {'type': 'RuntimeDefault'}}, 'containers': [{'name': 'operator', 'image': 'expbuild/operator:test', 'imagePullPolicy': 'Never', 'args': ['--bazel-remote-image=example.invalid/unused@sha256:' + 'a'*64, '--webdav-image=' + APACHE, '--webdav-stats-image=expbuild/operator:test', '--gradle-image=' + gradle_image], 'securityContext': {'readOnlyRootFilesystem': True, 'allowPrivilegeEscalation': False, 'capabilities': {'drop': ['ALL']}}}]}}}})
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

            secret('gradle-demo-auth', 'gradle', 'gradle-demo')
            kubectl('apply', '-f', 'operator/examples/gradle-http.yaml')
            wait(lambda: ready('gradle-demo'), 'Gradle cache ready through authenticated Operator probe')
            gradle_spec = get('cacheinstance', 'gradle-demo')['spec']
            gradle_volume_uid = get('pvc', 'gradle-demo-data')['metadata']['uid']
            key = 'a' * 64
            payload = b'opaque Gradle task output persisted on PVC'
            with connection(instance_name='gradle-demo', unauthorized_path='/status') as url:
                assert request(url + '/cache/' + key, 'PUT', payload, auth('gradle'))[0] == 201
                assert request(url + '/cache/' + key, headers=auth('gradle'))[:2] == (200, payload)
                assert request(url + '/cache/' + key, headers=auth('cache'))[0] == 401
                status, body, _ = request(url + '/status', headers=auth('gradle'))
                snapshot = json.loads(body)
                assert status == 200 and snapshot['entries'] == 1 and snapshot['sizeBytes'] == len(payload)
                assert snapshot['getHits'] >= 1 and snapshot['putSuccess'] >= 1
            pod_uid = get('pod', 'gradle-demo-0')['metadata']['uid']
            kubectl('-n', 'expbuild-demo', 'delete', 'pod', 'gradle-demo-0', '--wait=true')
            wait(lambda: get('pod', 'gradle-demo-0')['metadata']['uid'] != pod_uid and ready('gradle-demo'), 'Gradle Pod recovered with PVC')
            with connection(instance_name='gradle-demo', unauthorized_path='/status') as url:
                assert request(url + '/cache/' + key, headers=auth('gradle'))[:2] == (200, payload)
            patch({'desiredState': 'Suspended'}, 'gradle-demo')
            wait(lambda: any(c.get('reason') == 'Suspended' and c.get('observedGeneration') == get('cacheinstance', 'gradle-demo')['metadata']['generation'] for c in get('cacheinstance', 'gradle-demo').get('status', {}).get('conditions', [])), 'Gradle instance suspended')
            wait(lambda: kubectl('-n', 'expbuild-demo', 'get', 'pod', 'gradle-demo-0', '--ignore-not-found', '-o', 'name') == '', 'Gradle Pod stopped')
            patch({'desiredState': 'Running'}, 'gradle-demo')
            wait(lambda: ready('gradle-demo'), 'Gradle instance resumed')
            secret('gradle-demo-auth-rotated', 'new-gradle', 'gradle-demo')
            patch({'access': {'credentialsSecretRef': 'gradle-demo-auth-rotated'}}, 'gradle-demo')
            wait(lambda: ready('gradle-demo'), 'Gradle credential rollout ready')
            with connection(instance_name='gradle-demo', unauthorized_path='/status') as url:
                assert request(url + '/cache/' + key, headers=auth('gradle'))[0] == 401
                assert request(url + '/cache/' + key, headers=auth('new-gradle'))[:2] == (200, payload)
                assert request(url + '/status', headers=auth('gradle'))[0] == 401
                assert request(url + '/status', headers=auth('new-gradle'))[0] == 200
            kubectl('-n', 'expbuild-demo', 'delete', 'cacheinstance', 'gradle-demo', '--wait=true', '--timeout=180s')
            assert get('pvc', 'gradle-demo-data')['metadata']['uid'] == gradle_volume_uid
            gradle_spec['instanceId'] = 'gradle-delete'
            gradle_spec['access']['credentialsSecretRef'] = 'gradle-delete-auth'
            gradle_spec['storage']['deletionPolicy'] = 'Delete'
            secret('gradle-delete-auth', 'gradle', 'gradle-delete')
            apply({'apiVersion': 'cache.expbuild.io/v1alpha1', 'kind': 'CacheInstance', 'metadata': {'name': 'gradle-delete', 'namespace': 'expbuild-demo'}, 'spec': gradle_spec})
            wait(lambda: ready('gradle-delete'), 'Gradle Delete-policy instance ready')
            kubectl('-n', 'expbuild-demo', 'delete', 'cacheinstance', 'gradle-delete', '--wait=true', '--timeout=180s')
            assert kubectl('-n', 'expbuild-demo', 'get', 'pvc', 'gradle-delete-data', '--ignore-not-found', '-o', 'name') == ''
            print('Isolated Gradle lifecycle passed', flush=True)
        except BaseException:
            for args in [('get', 'pods,pvc,statefulsets,cacheinstances', '-A', '-o', 'wide'), ('get', 'events', '-A', '--sort-by=.lastTimestamp'), ('-n', 'expbuild-system', 'logs', 'deployment/operator', '--all-pods=true', '--tail=100')]:
                try: print(kubectl(*args), flush=True)
                except Exception: pass
            raise
        finally:
            subprocess.run(['kind', 'delete', 'cluster', '--name', name, '--kubeconfig', config], timeout=180, check=False)


if __name__ == '__main__':
    main()
