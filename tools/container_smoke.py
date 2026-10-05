#!/usr/bin/env python3
"""Run built images locally without publishing images or contacting a K8S cluster."""
import base64
import hashlib
import json
import pathlib
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import uuid

COMPONENTS = {'admin-api', 'admin-web', 'operator', 'webdav', 'gradle-cache', 'turborepo-cache', 'nx-cache', 'go-cache'}


def docker(*args):
    return subprocess.check_output(['docker', *args], text=True, timeout=180).strip()


def request(url, method='GET', body=None, headers=None):
    try:
        with urllib.request.urlopen(urllib.request.Request(url, data=body, headers=headers or {}, method=method), timeout=3) as response:
            return response.status, response.read(), response.headers
    except urllib.error.HTTPError as error:
        return error.code, error.read(), error.headers


def wait_for(check, description):
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        try:
            if check():
                return
        except (OSError, subprocess.CalledProcessError):
            pass
        time.sleep(1)
    raise RuntimeError(f'Timed out: {description}')


def main(component):
    image = f'expbuild/{component}:test'
    prefix = 'expbuild-smoke-' + uuid.uuid4().hex[:12]
    containers = []
    network = None
    flags = ['--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--tmpfs', '/tmp:rw,nosuid,nodev,size=64m']
    image_user = docker('image', 'inspect', image, '--format', '{{.Config.User}}')
    assert image_user and image_user.split(':')[0] not in ('0', 'root'), 'Image must select a non-root user'
    with tempfile.TemporaryDirectory(prefix='expbuild-smoke-') as directory:
        root = pathlib.Path(directory)
        root.chmod(0o755)
        try:
            if component == 'operator':
                result = subprocess.run(['docker', 'run', '--rm', *flags, image, '--help'], text=True, capture_output=True, timeout=30, check=True)
                assert 'bazel-remote-image' in result.stdout + result.stderr
                print('operator: executable entrypoint passed (no cluster connection)')
                return
            args = []
            port = 8080
            if component == 'webdav':
                (root / 'httpd.conf').write_text(pathlib.Path('operator/internal/webdav/httpd.conf').read_text())
                (root / 'htpasswd').write_text('cache:$2b$10$Z9RNLYUAIh7a19cBqRUKx.zSNfeY9lgPD3T6/fMX.JC82Or3o/5SW\n')
                args += ['--mount', f'type=bind,src={root / "httpd.conf"},dst=/config/httpd.conf,readonly',
                         '--mount', f'type=bind,src={root / "htpasswd"},dst=/auth/htpasswd,readonly',
                         '--tmpfs', '/data:rw,nosuid,nodev,uid=1000,gid=1000,mode=0750,size=64m']
            elif component in ('gradle-cache', 'turborepo-cache', 'nx-cache', 'go-cache'):
                (root / 'htpasswd').write_text('cache:$2b$10$Z9RNLYUAIh7a19cBqRUKx.zSNfeY9lgPD3T6/fMX.JC82Or3o/5SW\n')
                if component == 'turborepo-cache':
                    with (root / 'htpasswd').open('a') as credentials:
                        credentials.write('health:$2b$10$Z9RNLYUAIh7a19cBqRUKx.zSNfeY9lgPD3T6/fMX.JC82Or3o/5SW\n')
                if component in ('nx-cache', 'go-cache'):
                    with (root / 'htpasswd').open('a') as credentials:
                        credentials.write('health:$2b$10$Z9RNLYUAIh7a19cBqRUKx.zSNfeY9lgPD3T6/fMX.JC82Or3o/5SW\n')
                args += ['--mount', f'type=bind,src={root / "htpasswd"},dst=/auth/htpasswd,readonly',
                         '--tmpfs', '/data:rw,nosuid,nodev,uid=1000,gid=1000,mode=0750,size=64m']
            elif component == 'admin-api':
                port = 3001
                network = prefix + '-net'
                docker('network', 'create', network)
                database = prefix + '-db'
                containers.append(database)
                docker('run', '-d', '--name', database, '--network', network, '-e', 'POSTGRES_PASSWORD=smoke-test-only', 'postgres:18')
                wait_for(lambda: docker('exec', database, 'pg_isready', '-U', 'postgres') is not None, 'PostgreSQL readiness')
                database_url = f'postgresql://postgres:smoke-test-only@{database}:5432/postgres'
                for entry, extra in [('migrate', []), ('bootstrap', ['-e', 'ADMIN_EMAIL=smoke@example.test', '-e', 'ADMIN_PASSWORD=smoke-password-only'])]:
                    docker('run', '--rm', *flags, '--network', network, '-e', f'DATABASE_URL={database_url}', *extra, image, 'node', f'apps/admin-api/dist/{entry}.js')
                # No instances/projects are provisioned: the API client only needs a valid config.
                (root / 'kubeconfig').write_text(json.dumps({'apiVersion': 'v1', 'kind': 'Config', 'clusters': [{'name': 'test', 'cluster': {'server': 'http://127.0.0.1:9'}}], 'users': [{'name': 'test', 'user': {}}], 'contexts': [{'name': 'test', 'context': {'cluster': 'test', 'user': 'test'}}], 'current-context': 'test'}))
                args += ['--network', network, '--mount', f'type=bind,src={root / "kubeconfig"},dst=/config/kubeconfig,readonly',
                         '-e', 'KUBECONFIG=/config/kubeconfig', '-e', f'DATABASE_URL={database_url}',
                         '-e', 'APP_ORIGIN=http://localhost:5173', '-e', 'STORAGE_CLASS=test',
                         '-e', 'OPERATION_ENCRYPTION_KEY=' + '11' * 32]
            name = prefix + '-app'
            containers.append(name)
            docker('run', '-d', '--name', name, *flags, *args, '-p', f'127.0.0.1::{port}', image, *(['--team=team_smoke', '--max-entry-bytes=1024', '--max-total-bytes=65536'] if component == 'turborepo-cache' else []), *(['--namespace=smoke', '--max-entry-bytes=1024', '--max-total-bytes=65536'] if component in ('nx-cache', 'go-cache') else []), *(['--read-only=false'] if component == 'go-cache' else []))
            address = docker('port', name, f'{port}/tcp')
            base = 'http://' + address
            expected = 401 if component in ('webdav', 'gradle-cache', 'turborepo-cache', 'nx-cache', 'go-cache') else 200
            probe = '/cache/' + 'a' * 64 if component == 'go-cache' else '/v8/artifacts/opaque-key?teamId=team_smoke' if component == 'turborepo-cache' else '/v1/cache/opaque-key' if component == 'nx-cache' else '/cache/' + 'a' * 32 if component == 'gradle-cache' else '/' if component == 'webdav' else '/healthz'
            wait_for(lambda: request(base + probe)[0] == expected, 'container HTTP startup')
            if component == 'admin-web':
                status, body, headers = request(base + '/')
                assert status == 200 and b'<div id="root">' in body
                assert headers.get('Content-Security-Policy')
                assert request(base + '/v1/auth/me')[0] == 404
            elif component == 'admin-api':
                assert request(base + '/readyz')[0] == 200
                status, body, headers = request(base + '/v1/auth/login', 'POST', json.dumps({'email': 'smoke@example.test', 'password': 'smoke-password-only'}).encode(), {'Content-Type': 'application/json', 'Origin': 'http://localhost:5173'})
                assert status == 200, (status, body)
                assert json.loads(body)['csrfToken']
                cookie = headers['Set-Cookie'].split(';')[0]
                assert request(base + '/v1/auth/me', headers={'Cookie': cookie})[0] == 200
            elif component == 'webdav':
                auth = {'Authorization': 'Basic ' + base64.b64encode(b'cache:engine-test-only').decode()}
                assert request(base + '/cache', 'MKCOL', headers=auth)[0] == 201
                assert request(base + '/cache/blob', 'PUT', b'smoke')[0] == 401
                assert request(base + '/cache/blob', 'PUT', b'smoke', auth)[0] == 201
                assert request(base + '/cache/blob', headers=auth)[:2] == (200, b'smoke')
                assert request(base + '/cache/', 'PROPFIND', headers={**auth, 'Depth': '1'})[0] == 207
                assert request(base + '/cache/blob', 'DELETE', headers=auth)[0] == 204
            elif component == 'turborepo-cache':
                auth = {'Authorization': 'Bearer engine-test-only', 'x-artifact-duration': '42', 'x-artifact-tag': 'opaque-client-tag'}
                path = '/v8/artifacts/opaque-key?teamId=team_smoke'
                payload = bytes([0]) + b"opaque artifact" + bytes([255])
                assert request(base + path, 'PUT', payload)[0] == 401
                assert request(base + path, 'PUT', payload, auth)[0] in (200, 201, 204)
                status, body, headers = request(base + path, headers=auth)
                assert status == 200 and body == payload
                assert headers.get('x-artifact-tag') == 'opaque-client-tag'
                assert headers.get('x-artifact-duration') == '42'
                assert headers.get('Content-Length') == str(len(payload))
                assert request(base + '/v8/artifacts/opaque-key?teamId=team_other', headers=auth)[0] == 403
                health = {'Authorization': 'Basic ' + base64.b64encode(b'health:engine-test-only').decode()}
                status, body, _ = request(base + '/status', headers=health)
                assert status == 200 and json.loads(body)['team'] == 'team_smoke'
                assert request(base + path, headers=health)[0] in (401, 403)
            elif component == 'go-cache':
                path = '/cache/' + 'a' * 64
                auth = {'Authorization': 'Bearer engine-test-only'}
                for payload in (b'', b'Go compiler artifact', b'replacement'):
                    metadata = {**auth, 'X-Cacheprog-OutputID': 'b' * 64,
                                'X-Cacheprog-CompressionAlgorithm': '',
                                'X-Cacheprog-UncompressedSize': str(len(payload)),
                                'X-Cacheprog-MD5Sum': hashlib.md5(payload).hexdigest(),
                                'X-Cacheprog-Sha256Sum': hashlib.sha256(payload).hexdigest()}
                    assert request(base + path, 'PUT', payload, metadata)[0] == 200
                    status, body, headers = request(base + path, headers=auth)
                    assert status == 200 and body == payload
                    assert headers['X-Cacheprog-OutputID'] == 'b' * 64 and headers['Last-Modified']
                assert request(base + path, 'PUT', b'bad', metadata)[0] == 400
                assert request(base + path)[0] == 401
                assert request(base + path + '?tenant=other', headers=auth)[0] == 400
                health = {'Authorization': 'Basic ' + base64.b64encode(b'health:engine-test-only').decode()}
                status, body, _ = request(base + '/status', headers=health)
                assert status == 200 and json.loads(body)['readOnly'] is False
                assert request(base + path, headers=health)[0] == 401
            elif component == 'nx-cache':
                auth = {'Authorization': 'Bearer engine-test-only'}
                path = '/v1/cache/opaque-key'
                payload = bytes([0]) + b"opaque artifact" + bytes([255])
                assert request(base + path, 'PUT', payload)[0] == 401
                assert request(base + path, 'PUT', payload, auth)[0] == 200
                assert request(base + path, 'PUT', payload, auth)[0] == 409
                assert request(base + path, 'PUT', b'changed', auth)[0] == 409
                status, body, headers = request(base + path, headers=auth)
                assert status == 200 and body == payload
                assert headers.get('Content-Length') == str(len(payload))
                assert request(base + path + '?namespace=other', headers=auth)[0] == 400
                assert request(base + path, headers={'Authorization': 'Bearer wrong-token'})[0] == 401
                health = {'Authorization': 'Basic ' + base64.b64encode(b'health:engine-test-only').decode()}
                status, body, _ = request(base + '/status', headers=health)
                assert status == 200 and json.loads(body)['namespace'] == 'smoke'
                assert request(base + path, headers=health)[0] in (401, 403)
            else:
                key = 'a' * 32
                auth = {'Authorization': 'Basic ' + base64.b64encode(b'cache:engine-test-only').decode()}
                assert request(base + '/cache/' + key, 'PUT', b'smoke')[0] == 401
                assert request(base + '/cache/' + key, 'PUT', b'smoke', auth)[0] == 201
                assert request(base + '/cache/' + key, headers=auth)[:2] == (200, b'smoke')
                assert request(base + '/cache/' + key, 'PUT', b'changed', auth)[0] == 409
                status, body, _ = request(base + '/status', headers=auth)
                assert status == 200 and json.loads(body)['sizeBytes'] == 5
                assert request(base + '/cache/../outside', 'PUT', b'bad', auth)[0] == 404
        except BaseException:
            for name in containers:
                subprocess.run(['docker', 'logs', '--tail', '50', name], check=False, timeout=15)
            raise
        finally:
            for name in reversed(containers):
                subprocess.run(['docker', 'rm', '-fv', name], check=False, stdout=subprocess.DEVNULL, timeout=30)
            if network:
                subprocess.run(['docker', 'network', 'rm', network], check=False, stdout=subprocess.DEVNULL, timeout=30)
    print(f'{component}: container smoke checks passed')


if __name__ == '__main__':
    if len(sys.argv) != 2 or sys.argv[1] not in COMPONENTS:
        raise SystemExit('Usage: container_smoke.py admin-api|admin-web|operator|webdav|gradle-cache|turborepo-cache|nx-cache|go-cache')
    main(sys.argv[1])
