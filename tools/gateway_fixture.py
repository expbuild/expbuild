"""Pinned Envoy Gateway fixture; requires a caller-owned disposable cluster."""
import hashlib
import http.client
import json
import pathlib
import socket
import ssl
import subprocess
import time
import tempfile
from cluster_lifecycle import run, wait

VERSION = 'v1.8.5'
CHART_SHA256 = '34c3e6ef80c73933699479b3ca158fc027d7cf1a75344e5108a229dab39801f9'
CONTROLLER = 'docker.io/envoyproxy/gateway:v1.8.5@sha256:d45d97c1c00babbcddb7a500bb782ff9c87f6526446f5b480fe3c040d8488184'
PROXY = 'docker.io/envoyproxy/envoy:distroless-v1.38.4@sha256:b28fbee81528c5b6e8857412e5e0f48ea5baa0199cf73ab611aa7f88a808eba7'


class GatewayFixture:
    def __init__(self, kubectl, apply, directory, config, context):
        self.kubectl, self.apply = kubectl, apply
        self.root, self.config, self.context = pathlib.Path(directory), config, context
        self.process = None
        self.port = None
        self.transport_logs = []

    @property
    def values(self):
        return {'enabled': True, 'name': 'caches', 'namespace': 'edge', 'sectionName': 'https', 'baseDomain': 'cache.example.test', 'controllerName': 'gateway.envoyproxy.io/gatewayclass-controller', 'dataPlaneNamespace': 'edge'}

    def install(self):
        run('helm', 'pull', 'oci://docker.io/envoyproxy/gateway-helm', '--version', VERSION, '--destination', str(self.root))
        chart = self.root / ('gateway-helm-' + VERSION + '.tgz')
        assert hashlib.sha256(chart.read_bytes()).hexdigest() == CHART_SHA256, 'Gateway chart digest mismatch'
        values = self.root / 'envoy-values.json'
        values.write_text(json.dumps({'global': {'images': {'envoyGateway': {'image': CONTROLLER}, 'envoyProxy': {'image': PROXY}}}}))
        run('helm', '--kubeconfig', self.config, '--kube-context', self.context, 'install', 'eg', str(chart), '-n', 'edge', '--create-namespace', '-f', str(values), '--wait', '--timeout', '8m', timeout=600)
        # Separate CA and leaf certificate, with real hostname verification.
        def openssl(*args):
            subprocess.run(['openssl', *args], cwd=self.root, check=True, capture_output=True, timeout=60)
        openssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.crt', '-days', '1', '-subj', '/CN=expbuild-isolated-CA', '-addext', 'basicConstraints=critical,CA:TRUE')
        openssl('req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'server.key', '-out', 'server.csr', '-subj', '/CN=*.cache.example.test')
        (self.root / 'server.ext').write_text('subjectAltName=DNS:*.cache.example.test\nbasicConstraints=critical,CA:FALSE\nextendedKeyUsage=serverAuth\nkeyUsage=digitalSignature,keyEncipherment\n')
        openssl('x509', '-req', '-in', 'server.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'server.crt', '-days', '1', '-extfile', 'server.ext')
        self.apply({'apiVersion': 'v1', 'kind': 'Secret', 'metadata': {'name': 'wildcard', 'namespace': 'edge'}, 'type': 'kubernetes.io/tls', 'stringData': {'tls.crt': (self.root / 'server.crt').read_text(), 'tls.key': (self.root / 'server.key').read_text()}})
        self.apply({'apiVersion': 'gateway.envoyproxy.io/v1alpha1', 'kind': 'EnvoyProxy', 'metadata': {'name': 'cache-proxy', 'namespace': 'edge'}, 'spec': {'provider': {'type': 'Kubernetes', 'kubernetes': {'envoyService': {'type': 'ClusterIP'}, 'envoyDeployment': {'pod': {'labels': {'cache.expbuild.io/gateway': 'true'}}, 'container': {'image': PROXY}}}}}})
        self.apply({'apiVersion': 'gateway.networking.k8s.io/v1', 'kind': 'GatewayClass', 'metadata': {'name': 'expbuild-test'}, 'spec': {'controllerName': self.values['controllerName'], 'parametersRef': {'group': 'gateway.envoyproxy.io', 'kind': 'EnvoyProxy', 'name': 'cache-proxy', 'namespace': 'edge'}}})
        self.apply({'apiVersion': 'gateway.networking.k8s.io/v1', 'kind': 'Gateway', 'metadata': {'name': 'caches', 'namespace': 'edge'}, 'spec': {'gatewayClassName': 'expbuild-test', 'listeners': [{'name': 'https', 'protocol': 'HTTPS', 'port': 443, 'hostname': '*.cache.example.test', 'tls': {'mode': 'Terminate', 'certificateRefs': [{'name': 'wildcard'}]}, 'allowedRoutes': {'namespaces': {'from': 'Selector', 'selector': {'matchLabels': {'app.kubernetes.io/managed-by': 'expbuild'}}}, 'kinds': [{'group': 'gateway.networking.k8s.io', 'kind': 'HTTPRoute'}, {'group': 'gateway.networking.k8s.io', 'kind': 'GRPCRoute'}]}}]}})
        print('Pinned Envoy Gateway and isolated TLS certificate installed', flush=True)

    def forward(self):
        services = json.loads(self.kubectl('-n', 'edge', 'get', 'services', '-l', 'gateway.envoyproxy.io/owning-gateway-name=caches', '-o', 'json'))['items']
        service = next(s['metadata']['name'] for s in services if any(p['port'] == 443 for p in s['spec']['ports']))
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            self.port = sock.getsockname()[1]
        with tempfile.NamedTemporaryFile(prefix='gateway-forward-', suffix='.log', dir=self.root, delete=False) as log:
            self.transport_logs.append(pathlib.Path(log.name))
            self.process = subprocess.Popen(['kubectl', '--kubeconfig', self.config, '--context', self.context, '-n', 'edge', 'port-forward', 'service/' + service, f'{self.port}:443', '--address=127.0.0.1'], stdout=subprocess.DEVNULL, stderr=log)
        def connected():
            with socket.create_connection(('127.0.0.1', self.port), timeout=2): return True
        wait(connected, 'TLS proxy forwarding established')

    def request(self, host, path='/', method='GET', body=None, headers=None, trusted=True):
        context = ssl.create_default_context(cafile=str(self.root / 'ca.crt')) if trusted else ssl.create_default_context()
        class LocalTLSConnection(http.client.HTTPConnection):
            def connect(connection):
                connection.sock = context.wrap_socket(socket.create_connection(('127.0.0.1', self.port), timeout=30), server_hostname=host)
        # Read-only probes may encounter a transport disconnect during rollout.
        # Never retry writes, TLS verification failures, or an HTTP response:
        # callers must still assert the exact authorization/status outcome.
        attempts = 3 if method == 'GET' and trusted else 1
        for attempt in range(attempts):
            connection = LocalTLSConnection(host, timeout=30)
            try:
                connection.request(method, path, body=body, headers=headers or {})
                response = connection.getresponse()
                return response.status, response.read(), dict(response.getheaders())
            except (http.client.RemoteDisconnected, ConnectionResetError, ConnectionRefusedError):
                if attempt + 1 == attempts:
                    raise
                print('TLS GET transport disconnected; retrying read-only probe', flush=True)
                time.sleep(1)
                # Inspect the actual handle; a live forwarder is never restarted
                # just because observing a response failed.
                if self.process is not None and self.process.poll() is not None:
                    print('Gateway port-forward exited; recreating the test transport', flush=True)
                    self.close()
                    self.forward()
            finally:
                connection.close()

    def verify(self, host, auth):
        wait(lambda: self.request(host)[0] == 401, 'Anonymous HTTPS access rejected')
        for hostname, trusted, rejection in [('wrong.example.test', True, (ssl.SSLError, ConnectionResetError)), (host, False, ssl.SSLCertVerificationError)]:
            # kubectl may terminate its forwarding session when the proxy resets
            # an unmatched-SNI connection. Isolate each intentional rejection.
            self.close()
            self.forward()
            assert self.request(host)[0] == 401
            try:
                self.request(hostname, trusted=trusted)
                raise AssertionError('Invalid TLS identity was accepted')
            except rejection:
                pass
        self.close()
        self.forward()
        assert self.request(host, '/dav', 'MKCOL', headers=auth)[0] == 201
        payload = b'g' * (16 * 1024 * 1024)
        assert self.request(host, '/dav/blob', 'PUT', payload, auth)[0] == 201
        assert self.request(host, '/dav/blob', headers=auth)[:2] == (200, payload)
        assert self.request(host, '/dav/', 'PROPFIND', headers={**auth, 'Depth': '1'})[0] == 207
        lock = b'<?xml version="1.0"?><D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype><D:owner>isolated-ci</D:owner></D:lockinfo>'
        status, _, headers = self.request(host, '/dav/blob', 'LOCK', lock, {**auth, 'Content-Type': 'application/xml', 'Timeout': 'Second-60'})
        assert status == 200
        token = next(value for key, value in headers.items() if key.lower() == 'lock-token')
        assert self.request(host, '/dav/blob', 'DELETE', headers=auth)[0] == 423
        # Scope the lock condition to the file, not its unlocked parent.
        status, body, _ = self.request(host, '/dav/blob', 'DELETE', headers={**auth, 'If': f'<https://{host}/dav/blob> ({token})'})
        assert status == 204, f'Locked WebDAV DELETE: {status} {body[:2048]!r}'
        print('Verified TLS hostname/trust, authentication, 16 MiB WebDAV transfer and locks', flush=True)

    def diagnose_transport(self):
        print('Gateway forwarder exit status:', None if self.process is None else self.process.poll(), flush=True)
        # kubectl forwarding diagnostics contain transport errors, not HTTP
        # payloads or credentials. Read a bounded tail of the last two sessions.
        for path in self.transport_logs[-2:]:
            with path.open('rb') as stream:
                stream.seek(max(0, path.stat().st_size - 8192))
                print(stream.read().decode('utf8', errors='replace'), flush=True)

    def close(self):
        if self.process:
            self.process.terminate()
            try: self.process.wait(timeout=10)
            except subprocess.TimeoutExpired: self.process.kill(); self.process.wait()
