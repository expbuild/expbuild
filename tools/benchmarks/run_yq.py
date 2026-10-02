#!/usr/bin/env python3
"""Bounded native-arm64 BuildKit/Distribution experiment; no cluster required."""
import argparse
import contextlib
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import platform
import re
import shutil
import subprocess
import tarfile
import time
import urllib.error
import urllib.request
import uuid

HERE = Path(__file__).resolve().parent
PINS = json.loads((HERE / 'yq-pins.json').read_text())
LABEL = 'io.expbuild.yq-poc'
MUTATION = 'expbuild-cache-probe'
COMPILE = 'RUN CGO_ENABLED=0 go build -ldflags "-s -w" .'
ACCEPTANCE = 'RUN ./scripts/acceptance.sh'


def digest(data):
    return 'sha256:' + hashlib.sha256(data).hexdigest()


def save(path, value):
    Path(path).write_text(json.dumps(value, indent=2, sort_keys=True) + '\n')


def verify_buildx(config):
    key = platform.system().lower() + '-arm64'
    if platform.machine().lower() not in ('arm64', 'aarch64') or key not in PINS['buildx_sha256']:
        raise ValueError('Only a native arm64 host with a pinned Buildx binary is supported')
    directories = config.get('cliPluginsExtraDirs', [])
    if len(directories) != 1:
        raise ValueError('Configure exactly one task-only plugin directory')
    binary = Path(directories[0]) / 'docker-buildx'
    if hashlib.sha256(binary.read_bytes()).hexdigest() != PINS['buildx_sha256'][key]:
        raise ValueError('Buildx binary does not match the official release SHA256')


def acceptance_count(log, expected_suites=17):
    text = re.sub(r'\x1b\[[0-9;]*m', '', log)
    counts = [int(n) for n in re.findall(r'Ran (\d+) tests?\.', text)]
    if (len(counts) != expected_suites or any(n == 0 for n in counts) or
            'FAILED (' in text or 'command not found' in text):
        raise ValueError('Incomplete or failed independent acceptance results')
    return sum(counts)


def command(argv, log=None, timeout=1200):
    if log is None:
        return subprocess.check_output(argv, stderr=subprocess.PIPE, timeout=timeout).decode().strip()
    with Path(log).open('w') as out:
        result = subprocess.run(argv, stdout=out, stderr=subprocess.STDOUT, timeout=timeout)
    if result.returncode:
        raise RuntimeError(f'Command failed ({result.returncode}); see {Path(log).name}')


def archive(source, target):
    raw = subprocess.check_output(['git', '-C', str(source), 'archive', PINS['revision']])
    target.mkdir()
    with tarfile.open(fileobj=io.BytesIO(raw)) as stream:
        stream.extractall(target, filter='data')
    if (target / '.git').exists():
        raise ValueError('Build context contains git metadata')
    return digest(raw)


def mutate(context):
    path = context / 'cmd/version.go'
    original = path.read_text()
    old = 'VersionPrerelease = ""'
    if original.count(old) != 1:
        raise ValueError('Mutation no longer matches pinned source')
    path.write_text(original.replace(old, f'VersionPrerelease = "{MUTATION}"'))


def adapt_dockerfile(context, seed, alpine):
    path = context / 'Dockerfile'
    data = path.read_text()
    go_line = 'FROM golang:1.27.1@' + PINS['golang'].split('@')[1] + ' AS builder'
    alpine_line = 'FROM alpine:3@' + PINS['alpine'].split('@')[1] + ' AS production'
    if data.count(go_line) != 1 or data.count(alpine_line) != 1:
        raise ValueError('Pinned upstream Dockerfile changed')
    data = data.replace(go_line, f'FROM {seed} AS builder')
    data = data.replace(alpine_line, f'FROM {alpine} AS production')
    if COMPILE not in data or ACCEPTANCE not in data:
        raise ValueError('Upstream build and acceptance must remain intact')
    path.write_text(data)


def step_hits(log):
    """Require completed named steps, not a count of unrelated cached base layers."""
    result = {}
    for label, marker in [('compile', COMPILE), ('acceptance', ACCEPTANCE)]:
        ids = re.findall(r'^#(\d+) \[builder [^\]]+\] ' + re.escape(marker) + r'$', log, re.M)
        ids = set(ids)
        if len(ids) != 1:
            raise ValueError(f'Missing or ambiguous {label} vertex')
        vertex = ids.pop()
        cached = bool(re.search(r'^#' + vertex + r' CACHED$', log, re.M))
        done = bool(re.search(r'^#' + vertex + r' DONE(?: |$)', log, re.M))
        if not (cached or done):
            raise ValueError(f'Incomplete {label} vertex')
        result[label] = cached
    return result


def oci_artifact(path, binary_path):
    """Verify OCI blobs and compare complete rootfs content/ownership/modes.

    Layer ordering, file mtimes and image config/history remain separately recorded.
    No image filesystem paths are extracted to the host.
    """
    root = {}
    with tarfile.open(path) as image:
        def blob(descriptor):
            name = 'blobs/' + descriptor['digest'].replace(':', '/')
            data = image.extractfile(name).read()
            if digest(data) != descriptor['digest'] or len(data) != descriptor['size']:
                raise ValueError('Invalid OCI descriptor')
            return data
        index = json.load(image.extractfile('index.json'))
        if len(index['manifests']) != 1:
            raise ValueError('Expected one image without attestations')
        manifest = json.loads(blob(index['manifests'][0]))
        config = json.loads(blob(manifest['config']))
        if (config['os'], config['architecture']) != ('linux', 'arm64'):
            raise ValueError('Expected native linux/arm64 output')
        for layer in manifest['layers']:
            with tarfile.open(fileobj=io.BytesIO(blob(layer))) as stream:
                members = stream.getmembers()
                # Whiteouts apply to lower layers, before this layer's additions.
                for item in members:
                    name = item.name.removeprefix('./').rstrip('/')
                    base = PurePosixPath(name).name
                    if base.startswith('.wh.'):
                        parent = str(PurePosixPath(name).parent)
                        parent = '' if parent == '.' else parent + '/'
                        target = parent + base.removeprefix('.wh.')
                        for key in list(root):
                            if ((base == '.wh..wh..opq' and key.startswith(parent)) or
                                    key == target or key.startswith(target + '/')):
                                del root[key]
                for item in members:
                    name = item.name.removeprefix('./').rstrip('/')
                    if not name or name == '.' or PurePosixPath(name).name.startswith('.wh.'):
                        continue
                    if name.startswith('/') or '..' in PurePosixPath(name).parts:
                        raise ValueError('Unsafe image path')
                    entry = {'mode': item.mode, 'uid': item.uid, 'gid': item.gid,
                             'type': item.type.decode(), 'link': item.linkname}
                    if item.isfile():
                        data = stream.extractfile(item).read()
                        entry.update(sha256=digest(data), size=len(data))
                        if name == 'usr/bin/yq':
                            binary_path.write_bytes(data)
                            binary_path.chmod(0o755)
                    root[name] = entry
    if not binary_path.is_file() or 'usr/bin/yq' not in root:
        raise ValueError('Missing yq binary')
    return {'rootfs': root, 'rootfs_sha256': digest(json.dumps(root, sort_keys=True).encode()),
            'binary_sha256': digest(binary_path.read_bytes()),
            'image_manifest': index['manifests'][0]['digest'], 'image_config': config}


class Experiment:
    def __init__(self, args):
        self.args = args
        self.work = args.work_dir.resolve()
        self.docker = ['docker', '--config', str(args.docker_config.resolve()), '--host', args.docker_host]
        self.state_path = self.work / 'state.json'
        self.state = json.loads(self.state_path.read_text()) if self.state_path.exists() else {}

    def d(self, *args, **kwargs):
        return command([*self.docker, *args], **kwargs)

    def persist(self):
        save(self.state_path, self.state)

    def inspect_resource(self, kind, name):
        try:
            return json.loads(self.d(kind, 'inspect', name))[0]
        except subprocess.CalledProcessError as error:
            message = (error.stderr or b'').decode(errors='replace').lower()
            if re.search(r'no such (container|volume|network|object)', message) or (
                    kind == 'network' and f'network {name} not found' in message):
                return None
            raise  # A disconnected daemon is not evidence that cleanup succeeded.

    def ephemeral(self, purpose, *args, **kwargs):
        name = self.state['prefix'] + '-' + purpose
        if name in self.d('ps', '-a', '--format', '{{.Names}}').splitlines():
            raise ValueError('Task container already exists')
        self.state.setdefault('ephemeral_containers', []).append(name)
        self.persist()
        try:
            return self.d('run', '--rm', '--name', name, '--label', LABEL + '=' + self.state['prefix'],
                          *args, **kwargs)
        finally:
            # --rm normally removed it. A client timeout can leave it running.
            info = self.inspect_resource('container', name)
            if info:
                if info['Config']['Labels'].get(LABEL) != self.state['prefix']:
                    raise ValueError('Ephemeral container ownership mismatch')
                self.d('rm', '-f', name)
            self.state['ephemeral_containers'].remove(name)
            self.persist()

    def image(self, name):
        return self.args.image_prefix.rstrip('/') + '/' + PINS[name]

    def api(self, path, method='GET'):
        req = urllib.request.Request(self.state['endpoint'] + path, method=method,
                                     headers={'Accept': 'application/vnd.oci.image.manifest.v1+json'})
        # Task localhost endpoint must never be sent to an ambient HTTP proxy.
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(req, timeout=15) as response:
            return response.status, dict(response.headers), response.read()

    def absent(self, path):
        try:
            self.api(path)
        except urllib.error.HTTPError as error:
            if error.code == 404:
                return
            raise
        raise ValueError('Expected missing cache manifest')

    def refresh_endpoint(self):
        ports = json.loads(self.d('inspect', '--format', '{{json .NetworkSettings.Ports}}',
                                  self.state['registry']))
        bindings = ports['5000/tcp']
        if len(bindings) != 1 or bindings[0]['HostIp'] != '127.0.0.1':
            raise ValueError('Registry must bind only localhost')
        endpoint = 'http://127.0.0.1:' + bindings[0]['HostPort']
        self.state.setdefault('endpoint_history', []).append(endpoint)
        self.state['endpoint'] = endpoint
        self.persist()

    def ready(self):
        # Docker start returning does not mean Colima's loopback forwarder is ready.
        for attempt in range(20):
            try:
                if self.api('/v2/')[0] == 200:
                    return
            except (OSError, urllib.error.URLError):
                if attempt == 19:
                    raise
            time.sleep(0.5)
        raise RuntimeError('Registry readiness deadline exceeded')

    def check_image_blobs(self, repository, reference):
        _, _, raw = self.api(f'/v2/{repository}/manifests/{reference}')
        manifest = json.loads(raw)
        for descriptor in [manifest['config'], *manifest['layers']]:
            _, _, data = self.api(f'/v2/{repository}/blobs/{descriptor["digest"]}')
            if digest(data) != descriptor['digest'] or len(data) != descriptor['size']:
                raise ValueError('Retained Registry image has a missing or corrupt blob')
        return digest(raw)

    def blob_file_present(self, blob_digest):
        if not re.fullmatch(r'sha256:[0-9a-f]{64}', blob_digest):
            raise ValueError('Invalid Registry blob digest')
        value = blob_digest.split(':')[1]
        path = f'/var/lib/registry/docker/registry/v2/blobs/sha256/{value[:2]}/{value}/data'
        output = self.d('exec', self.state['registry'], 'sh', '-c',
                        'if test -f "$1"; then echo present; else echo absent; fi', 'sh', path)
        if output not in ('present', 'absent'):
            raise ValueError('Could not determine physical blob state')
        return output == 'present'

    @contextlib.contextmanager
    def builder(self, purpose):
        name = self.state['prefix'] + '-' + purpose
        volume = 'buildx_buildkit_' + name + '0_state'
        if volume in self.d('volume', 'ls', '--format', '{{.Name}}').splitlines():
            raise ValueError('Builder state already exists')
        self.d('buildx', 'create', '--name', name, '--driver', 'docker-container',
               '--platform', 'linux/arm64', '--buildkitd-config', str(self.work / 'buildkitd.toml'),
               '--driver-opt', ','.join([f'image={self.image("buildkit")}',
                   'memory=2g', 'memory-swap=2g', 'cpu-period=100000', 'cpu-quota=200000',
                   'restart-policy=no', f'network={self.state["network"]}']))
        self.state['builder'] = name
        self.persist()
        try:
            self.d('buildx', 'inspect', name, '--bootstrap', log=self.work / f'{purpose}-builder.log')
            info = json.loads(self.d('inspect', 'buildx_buildkit_' + name + '0'))[0]
            host = info['HostConfig']
            if host['Memory'] != 2147483648 or host['CpuQuota'] != 200000:
                raise ValueError('Builder resource limits not applied')
            save(self.work / f'{purpose}-isolation.json', {
                'builder': name, 'volume': volume, 'new_volume': True,
                'container_id': info['Id'], 'memory_bytes': host['Memory'],
                'cpu_quota': host['CpuQuota'], 'cpu_period': host['CpuPeriod'],
                'privileged': host['Privileged']})
            yield name
        finally:
            self.d('buildx', 'rm', '--force', name)
            self.state.pop('builder', None)
            self.persist()
            if volume in self.d('volume', 'ls', '--format', '{{.Name}}').splitlines():
                raise ValueError('Builder state volume was not removed')

    def build(self, builder, context, log, *args):
        self.d('buildx', 'build', '--builder', builder, '--platform', 'linux/arm64',
               '--provenance=false', '--sbom=false', '--progress=plain',
               *args, str(context), log=log)

    def setup(self):
        setup_start = time.monotonic()
        if self.work.exists() and any(self.work.iterdir()):
            raise ValueError('Setup requires a new empty work directory')
        self.work.mkdir(parents=True, exist_ok=True)
        config = json.loads((self.args.docker_config / 'config.json').read_text())
        if config.get('auths') or config.get('credsStore') or config.get('credHelpers'):
            raise ValueError('Use a dedicated anonymous Docker config')
        verify_buildx(config)
        if PINS['buildx_version'] not in self.d('buildx', 'version'):
            raise ValueError('Unexpected Buildx version')
        info = json.loads(self.d('info', '--format', '{{json .}}'))
        if info['Architecture'] not in ('aarch64', 'arm64'):
            raise ValueError('This experiment requires native arm64; no emulation')
        if info['NCPU'] < 2 or info['MemTotal'] < 4 * 1024**3:
            raise ValueError('Insufficient daemon resources')
        prefix = 'expbuild-yq-' + uuid.uuid4().hex[:10]
        self.state = {'prefix': prefix, 'network': prefix + '-net', 'volume': prefix + '-data',
                      'registry': prefix + '-registry', 'cases': [], 'pins': PINS,
                      'image_prefix': self.args.image_prefix,
                      'host': {'docker': info['ServerVersion'], 'cpu': info['NCPU'],
                               'memory_bytes': info['MemTotal'], 'architecture': info['Architecture']}}
        self.persist()
        self.state['source_archive_sha256'] = archive(self.args.source, self.work / 'source')
        self.persist()
        self.d('network', 'create', '--label', LABEL + '=' + prefix, self.state['network'])
        self.d('volume', 'create', '--label', LABEL + '=' + prefix, self.state['volume'])
        (self.work / 'registry.yml').write_text('''version: 0.1
log:
  level: info
storage:
  filesystem:
    rootdirectory: /var/lib/registry
  delete:
    enabled: true
http:
  addr: :5000
''')
        (self.work / 'buildkitd.toml').write_text('''[worker.oci]
  max-parallelism = 2
[registry."registry:5000"]
  http = true
''')
        self.d('run', '-d', '--name', self.state['registry'], '--label', LABEL + '=' + prefix,
               '--network', self.state['network'], '--network-alias', 'registry',
               '--cpus', '0.5', '--memory', '256m', '--memory-swap', '256m',
               '-p', '127.0.0.1::5000',
               '--mount', f'type=volume,src={self.state["volume"]},dst=/var/lib/registry',
               '--mount', f'type=bind,src={self.work / "registry.yml"},dst=/etc/distribution/config.yml,readonly',
               self.image('registry'), '/etc/distribution/config.yml')
        self.refresh_endpoint()
        self.ready()
        print('Registry ready; preparing download-only dependency base', flush=True)
        seed = self.work / 'seed'
        seed.mkdir()
        for name in ('go.mod', 'go.sum'):
            shutil.copyfile(self.work / 'source' / name, seed / name)
        (seed / 'Dockerfile').write_text(f'''FROM {self.image('golang')}
WORKDIR /seed
COPY go.mod go.sum ./
ENV GOTOOLCHAIN=local GOMAXPROCS=2 GOFLAGS=-p=2 GOCACHE=/tmp/yq-go-build-cache
RUN go mod download all && go mod verify && rm -rf /tmp/yq-go-build-cache
ENV GOPROXY=off GOSUMDB=off
RUN test ! -e /tmp/yq-go-build-cache
''')
        with self.builder('prepare') as builder:
            self.build(builder, seed, self.work / 'seed.log', '--output',
                       'type=image,name=registry:5000/prepared-go:seed,push=true',
                       '--metadata-file', str(self.work / 'seed-metadata.json'))
        meta = json.loads((self.work / 'seed-metadata.json').read_text())
        self.state['seed'] = 'registry:5000/prepared-go@' + meta['containerimage.digest']
        self.state['cache'] = 'registry:5000/yq-cache:baseline'
        self.state['prepared'] = True
        self.state['setup_seconds'] = round(time.monotonic() - setup_start, 3)
        self.persist()
        print('Dependency base ready; no compiled yq layers retained', flush=True)

    def warm_bases(self, builder, case):
        context = case / 'base-warmup'
        context.mkdir()
        # These commands only force base-layer download/unpack and inspect an empty
        # compiler cache. They do not COPY yq or run go build/acceptance.
        (context / 'Dockerfile').write_text(f'''FROM {self.state['seed']} AS go-base
RUN test ! -e /tmp/yq-go-build-cache && go version
FROM {self.image('alpine')} AS alpine-base
RUN cat /etc/alpine-release
''')
        for target in ('go-base', 'alpine-base'):
            self.build(builder, context, case / f'warm-{target}.log', '--target', target)

    def oracle(self, case, mutated):
        source = case / 'oracle'
        archive(self.args.source, source)
        shutil.copyfile(case / 'yq', source / 'yq')
        (source / 'yq').chmod(0o755)
        script = ('set -eu\nmkdir .oracle-tmp\nexport TMPDIR=/work/.oracle-tmp\n'
                  # The pinned Go image lacks hd. Upstream compares two empty
                  # command substitutions in that case, accidentally passing.
                  'command -v od\nhd() { od -An -v -tx1 "$@"; }; export -f hd\n'
                  './scripts/acceptance.sh\n'
                  './yq --version > oracle-version.txt\n'
                  './yq -n -o=json -I=0 \'{\"answer\": (6 * 7), \"items\": [\"a\", \"b\"]}\' > oracle-json.txt\n'
                  "printf 'a: 1\\n---\\na: 2\\n' | ./yq ea -o=json -I=0 '[.a]' > oracle-docs.txt\n"
                  "printf 'a: foo\\nb: bar\\n' | ./yq e -0 '.a, .b' > oracle-nul.bin\n")
        self.ephemeral('oracle', '--network', 'none', '--cpus', '2', '--memory', '512m',
               '--read-only', '--tmpfs', '/tmp:rw,size=128m',
               '--mount', f'type=bind,src={source},dst=/work', '-w', '/work',
               '--entrypoint', '/bin/bash', self.image('golang'), '-c', script,
               log=case / 'oracle.log')
        version = (source / 'oracle-version.txt').read_text().strip()
        expected = PINS['tag'] + ('-' + MUTATION if mutated else '')
        if version != f'yq (https://github.com/mikefarah/yq/) version {expected}':
            raise ValueError('Version oracle mismatch')
        if json.loads((source / 'oracle-json.txt').read_text()) != {'answer': 42, 'items': ['a', 'b']}:
            raise ValueError('JSON semantic oracle mismatch')
        if json.loads((source / 'oracle-docs.txt').read_text()) != [1, 2]:
            raise ValueError('Multi-document semantic oracle mismatch')
        if (source / 'oracle-nul.bin').read_bytes() != b'foo\0bar\0':
            raise ValueError('Raw NUL-separated bytes do not match')
        log = (case / 'oracle.log').read_text()
        scripts = sorted(path.name for path in (source / 'acceptance_tests').glob('*.sh'))
        if any('acceptance_tests/' + name not in log for name in scripts):
            raise ValueError('Independent acceptance suite did not complete')
        count = acceptance_count(log, len(scripts))
        if count != 175:
            raise ValueError('Pinned upstream acceptance test count changed')
        return {'version': version, 'acceptance_scripts': scripts, 'network': 'none',
                'acceptance_tests': count, 'hd_adapter': 'od -An -v -tx1',
                'semantic_checks': ['version', 'json-arithmetic-array', 'multi-document', 'raw-nul-bytes']}

    def case(self, name, remote=False, export=False, mutated=False):
        case_start = time.monotonic()
        timings = {}
        case = self.work / name
        case.mkdir()
        archive(self.args.source, case / 'context')
        if mutated:
            mutate(case / 'context')
        adapt_dockerfile(case / 'context', self.state['seed'], self.image('alpine'))
        flags = ['--network=none', '--output', f'type=oci,dest={case / "image.tar"}',
                 '--output', f'type=image,name=registry:5000/yq-output:{name},push=true',
                 '--metadata-file', str(case / 'metadata.json')]
        if remote:
            flags += ['--cache-from', 'type=registry,ref=' + self.state['cache']]
        else:
            flags += ['--no-cache']
        if export:
            flags += ['--cache-to', 'type=registry,ref=' + self.state['cache'] +
                      ',mode=max,oci-mediatypes=true,image-manifest=true']
        builder_start = time.monotonic()
        with self.builder(name) as builder:
            timings['builder_setup'] = time.monotonic() - builder_start
            warmup_start = time.monotonic()
            self.warm_bases(builder, case)
            timings['base_image_warmup'] = time.monotonic() - warmup_start
            start = time.monotonic()
            self.build(builder, case / 'context', case / 'build.log', *flags)
            duration = time.monotonic() - start
            builder_cleanup_start = time.monotonic()
        timings['builder_cleanup'] = time.monotonic() - builder_cleanup_start
        timings['build_command'] = duration
        hits = step_hits((case / 'build.log').read_text())
        save(case / 'measurement.json', {'seconds': duration, 'hits': hits})
        artifact_start = time.monotonic()
        artifact = oci_artifact(case / 'image.tar', case / 'yq')
        save(case / 'artifact.json', artifact)
        timings['artifact_verification'] = time.monotonic() - artifact_start
        oracle_start = time.monotonic()
        oracle = self.oracle(case, mutated)
        timings['independent_oracle'] = time.monotonic() - oracle_start
        timings['case_total'] = time.monotonic() - case_start
        timings = {key: round(value, 3) for key, value in timings.items()}
        save(case / 'timings.json', timings)
        result = {'case': name, 'seconds': round(duration, 3), 'hits': hits,
                  'timings_seconds': timings,
                  'remote_import': remote, 'mode_max_export': export, 'mutated': mutated,
                  'binary_sha256': artifact['binary_sha256'], 'rootfs_sha256': artifact['rootfs_sha256'],
                  'image_manifest': artifact['image_manifest'], 'oracle': oracle}
        expected_hit = name == 'remote-warm'
        if hits != {'compile': expected_hit, 'acceptance': expected_hit}:
            raise ValueError(f'Unexpected cache behavior: {result}')
        self.state['cases'].append(result)
        self.persist()
        print(json.dumps(result), flush=True)

    def gc(self):
        if self.state.get('builder'):
            raise ValueError('Remove the builder before registry GC')
        status, headers, raw = self.api('/v2/yq-cache/manifests/baseline')
        cache_digest = headers.get('Docker-Content-Digest') or headers.get('docker-content-digest')
        if not cache_digest or digest(raw) != cache_digest:
            raise ValueError('Cache manifest digest mismatch')
        manifest = json.loads(raw)
        save(self.work / 'cache-manifest.json', manifest)
        if manifest['config']['mediaType'] != 'application/vnd.buildkit.cacheconfig.v0':
            raise ValueError('Expected a BuildKit cache manifest')
        cache_config_digest = manifest['config']['digest']
        delete_status, _, _ = self.api('/v2/yq-cache/manifests/' + cache_digest, method='DELETE')
        if delete_status != 202:
            raise ValueError('Cache manifest deletion was not accepted')
        self.absent('/v2/yq-cache/manifests/baseline')
        if not self.blob_file_present(cache_config_digest):
            raise ValueError('Expected cache config blob to remain before physical GC')
        save(self.work / 'cache-reference-delete.json', {
            'manifest_digest': cache_digest, 'delete_status': delete_status,
            'reference_status': 404, 'cache_config_digest': cache_config_digest,
            'cache_config_file_present_before_gc': True})
        before = self.d('exec', self.state['registry'], 'du', '-sk', '/var/lib/registry').split()[0]
        self.d('stop', self.state['registry'])
        try:
            self.ephemeral('gc', '--network', 'none', '--cpus', '1', '--memory', '256m',
                   '--mount', f'type=volume,src={self.state["volume"]},dst=/var/lib/registry',
                   '--mount', f'type=bind,src={self.work / "registry.yml"},dst=/etc/distribution/config.yml,readonly',
                   '--entrypoint', '/bin/registry', self.image('registry'),
                   'garbage-collect', '/etc/distribution/config.yml', log=self.work / 'gc.log')
        finally:
            self.d('start', self.state['registry'])
        self.refresh_endpoint()
        self.ready()
        self.absent('/v2/yq-cache/manifests/baseline')
        if self.blob_file_present(cache_config_digest):
            raise ValueError('Offline GC did not remove the unreferenced cache config blob')
        after = self.d('exec', self.state['registry'], 'du', '-sk', '/var/lib/registry').split()[0]
        # Final image and dependency seed are retained references, not cache.
        output_digest = self.check_image_blobs('yq-output', 'remote-cold')
        self.api('/v2/prepared-go/manifests/seed')
        save(self.work / 'gc-result.json', {'deleted_cache_manifest': cache_digest,
             'before_kib': int(before), 'after_kib': int(after), 'offline_gc': True,
             'cache_missing': True, 'retained_output_and_seed': True,
             'cache_config_digest': cache_config_digest, 'cache_config_file_removed': True,
             'retained_output_manifest': output_digest, 'retained_output_blobs_verified': True})

    def cases(self):
        if not self.state.get('prepared') or self.state.get('cleaned') or self.state['cases']:
            raise ValueError('Cases require a newly prepared experiment')
        self.absent('/v2/yq-cache/manifests/baseline')
        self.case('disabled')
        self.case('remote-cold', remote=True, export=True)
        self.case('remote-warm', remote=True)
        self.case('mutated-disabled', mutated=True)
        self.case('mutated-import', remote=True, mutated=True)
        self.gc()
        self.case('after-gc', remote=True)
        by_name = {item['case']: item for item in self.state['cases']}
        for name in ('remote-cold', 'remote-warm', 'after-gc'):
            if by_name[name]['rootfs_sha256'] != by_name['disabled']['rootfs_sha256']:
                raise ValueError('Complete root filesystem differs: ' + name)
        if by_name['mutated-disabled']['rootfs_sha256'] != by_name['mutated-import']['rootfs_sha256']:
            raise ValueError('Mutation result differs with remote cache')
        if by_name['mutated-import']['binary_sha256'] == by_name['disabled']['binary_sha256']:
            raise ValueError('Mutation did not change binary')
        self.state['passed'] = True
        self.persist()

    def cleanup(self):
        if not self.state:
            return
        errors = []
        for name in self.state.get('ephemeral_containers', []):
            try:
                info = self.inspect_resource('container', name)
                if info is None:
                    continue
                if info['Config']['Labels'].get(LABEL) != self.state['prefix']:
                    raise ValueError('Ephemeral container ownership mismatch')
                self.d('rm', '-f', name)
            except Exception as error:
                errors.append(str(error))
        if self.state.get('builder'):
            try:
                self.d('buildx', 'rm', '--force', self.state['builder'])
                self.state.pop('builder', None)
            except Exception as error:
                errors.append(str(error))
        for kind, key, remove in [('container', 'registry', ['rm', '-f']),
                                   ('volume', 'volume', ['volume', 'rm']),
                                   ('network', 'network', ['network', 'rm'])]:
            name = self.state[key]
            try:
                info = self.inspect_resource(kind, name)
            except Exception as error:
                errors.append(str(error))
                continue
            if info is None:
                continue
            labels = info['Config']['Labels'] if kind == 'container' else info['Labels']
            if labels.get(LABEL) != self.state['prefix']:
                errors.append('Ownership mismatch: ' + name)
                continue
            try:
                if kind == 'container':
                    self.d('logs', name, log=self.work / 'registry.log')
                self.d(*remove, name)
            except Exception as error:
                errors.append(str(error))
        self.state['cleanup_errors'] = errors
        self.state['cleaned'] = not errors
        self.persist()
        if errors:
            raise RuntimeError('Cleanup incomplete: ' + '; '.join(errors))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True, help='Pinned yq checkout (git archive only)')
    parser.add_argument('--work-dir', type=Path, required=True, help='New task-only evidence directory')
    parser.add_argument('--docker-config', type=Path, required=True, help='Anonymous task-only Docker config with verified Buildx')
    parser.add_argument('--docker-host', required=True, help='Explicit local Docker Unix socket')
    parser.add_argument('--image-prefix', choices=['docker.io', 'mirror.gcr.io'], default='docker.io')
    parser.add_argument('--phase', choices=['all', 'setup', 'cases', 'cleanup'], default='all')
    args = parser.parse_args()
    if not args.docker_host.startswith('unix:///'):
        parser.error('Only a local Unix socket is supported')
    experiment = Experiment(args)
    if args.phase in ('all', 'setup'):
        # A rejected nonempty work directory must never clean an earlier run.
        experiment.state = {}
    succeeded = False
    try:
        if args.phase in ('all', 'setup'):
            experiment.setup()
        if args.phase in ('all', 'cases'):
            experiment.cases()
        succeeded = True
    finally:
        if args.phase != 'setup' or not succeeded:
            experiment.cleanup()


if __name__ == '__main__':
    main()
