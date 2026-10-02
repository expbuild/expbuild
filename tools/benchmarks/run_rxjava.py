#!/usr/bin/env python3
"""Run pinned RxJava with existing verified tools and an isolated Gradle cache."""
import argparse
import base64
import hashlib
import io
import json
import os
import re
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import tarfile
import time
import urllib.request
import xml.etree.ElementTree as ET
import zipfile

from common import WORKLOADS, run_command, sha256, stop, timed_command

HERE = Path(__file__).resolve().parent
ALLOWED_SKIPS = {(WORKLOADS['rxjava']['test_filter'], 'announce')}
MODULE_ENTRY = 'META-INF/versions/9/module-info.class'


def jar_entries(path):
    with zipfile.ZipFile(path) as archive:
        names = [entry.filename for entry in archive.infolist() if not entry.is_dir()]
        if len(names) != len(set(names)):
            raise ValueError('Duplicate JAR entries')
        return {name: hashlib.sha256(archive.read(name)).hexdigest() for name in sorted(names)}


def compiled_modules(work):
    return {str(path.relative_to(work)): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in sorted((work / 'build/classes').rglob('module-info.class'))}


def validate_module_output(work, entries):
    modules = compiled_modules(work)
    if MODULE_ENTRY not in entries:
        raise ValueError('JAR missing the required Java 9 module descriptor')
    if len(modules) != 1 or next(iter(modules.values())) != entries[MODULE_ENTRY]:
        raise ValueError('Compiled module descriptor missing, duplicated, or different from JAR')
    return modules


def validate_rebuild(work, before, after):
    validate_module_output(work, after)
    if before != after:
        raise ValueError('In-place rebuild changed decompressed JAR entries')


def test_results(work, pinned_scope=False):
    paths = list((work / 'build/test-results/test').glob('TEST-*.xml'))
    if not paths:
        raise ValueError('Missing XML test results')
    result = {'tests': 0, 'failures': 0, 'errors': 0, 'skipped': 0, 'cases': [], 'skipped_cases': []}
    for path in sorted(paths):
        suite = ET.parse(path).getroot()
        for key in ['tests', 'failures', 'errors', 'skipped']:
            result[key] += int(suite.get(key, '0'))
        if suite.findall('.//failure') or suite.findall('.//error'):
            raise ValueError('Failed test cases in XML')
        result['cases'] += sorted((case.get('classname'), case.get('name')) for case in suite.findall('testcase'))
        result['skipped_cases'] += [(case.get('classname'), case.get('name')) for case in suite.findall('testcase')
                                    if case.find('skipped') is not None]
    # The fixed upstream RxJavaTest superclass deliberately @Ignores announce.
    # Keep that known skip visible; reject every other skip and an all-skipped run.
    if (result['tests'] <= result['skipped'] or result['failures'] or result['errors']
            or len(set(result['cases'])) != len(result['cases'])
            or len(result['cases']) != result['tests']
            or len(result['skipped_cases']) != result['skipped']
            or not set(result['skipped_cases']) <= ALLOWED_SKIPS):
        raise ValueError('Incomplete or failed test suite')
    if pinned_scope and (result['tests'] != 28 or any(c != WORKLOADS['rxjava']['test_filter'] for c, _ in result['cases'])):
        raise ValueError('Pinned RxJava test scope changed')
    return result


def validate_runtime(events_path):
    runtime = json.loads(Path(str(events_path) + '.jvm.json').read_text())
    if runtime['gradleVersion'] != WORKLOADS['rxjava']['gradle_version'] or runtime['javaVersion'].split('.')[0] != str(WORKLOADS['rxjava']['java_major']):
        raise ValueError('Gradle task runtime differs from the pinned Gradle/JDK contract')
    return {k: runtime[k] for k in ('gradleVersion', 'javaVersion', 'javaVendor')}


def cache_status(url):
    authorization = 'Basic ' + base64.b64encode(b'builder:secret').decode()
    request = urllib.request.Request(url + '/status', headers={'Authorization': authorization})
    with urllib.request.urlopen(request, timeout=5) as response:
        return json.load(response)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ['source', 'output', 'gradle', 'java-home', 'engine', 'dependency-snapshot', 'htpasswd']:
        parser.add_argument('--' + name, required=True, type=Path)
    parser.add_argument('--reproducible-jar', action='store_true',
                        help='Use Bnd reproducible mode uniformly; changes build metadata, not source')
    parser.add_argument('--isolated-module-output', action='store_true',
                        help='Explicit diagnostic workaround for pinned RxJava: isolate plugin compiler outputs')
    args = parser.parse_args()
    root = args.output.resolve()
    root.mkdir(mode=0o700, parents=True, exist_ok=False)
    java_home, gradle, engine = args.java_home.resolve(), args.gradle.resolve(), args.engine.resolve()
    snapshot = args.dependency_snapshot.resolve()
    revision = WORKLOADS['rxjava']['revision']
    if subprocess.check_output(['git', '-C', str(args.source), 'rev-parse', 'HEAD'], text=True).strip() != revision:
        raise ValueError('Unexpected source revision')
    archive = subprocess.check_output(['git', '-C', str(args.source), 'archive', revision])
    dependency_files = {str(p.relative_to(snapshot)): hashlib.file_digest(p.open('rb'), 'sha256').hexdigest()
                        for p in sorted(snapshot.rglob('*')) if p.is_file()}
    if not dependency_files or any('build-cache' in p or p.endswith('.lock') for p in dependency_files):
        raise ValueError('Only a prepared modules-2 download snapshot is allowed')
    (root / 'dependency-manifest.json').write_text(json.dumps(dependency_files, sort_keys=True, indent=2))
    environment = {key: value for key, value in os.environ.items() if key not in
                   ['JAVA_OPTS', 'GRADLE_OPTS', 'JAVA_TOOL_OPTIONS', 'JDK_JAVA_OPTIONS', '_JAVA_OPTIONS']}
    environment.update(JAVA_HOME=str(java_home), CI='true', BUILD_WITH_11='true', BUILD_TAG='v3.1.12', TZ='UTC',
                       EXPBUILD_BENCH_USER='builder', EXPBUILD_BENCH_PASSWORD='secret')
    version_environment = {**environment, 'GRADLE_USER_HOME': str(root / 'preflight-gradle-home')}
    gradle_version = subprocess.check_output([str(gradle), '--version'], env=version_environment, text=True)
    if not re.search(r'^Gradle ' + re.escape(WORKLOADS['rxjava']['gradle_version']) + r'$', gradle_version, re.M):
        raise ValueError('Expected Gradle ' + WORKLOADS['rxjava']['gradle_version'])
    identity = {'revision': revision, 'gradle': str(gradle), 'java_home': str(java_home),
                'java_version': subprocess.check_output([str(java_home / 'bin/java'), '-version'], text=True, stderr=subprocess.STDOUT),
                'engine_sha256': hashlib.file_digest(engine.open('rb'), 'sha256').hexdigest(),
                'dependency_manifest_sha256': hashlib.sha256((root / 'dependency-manifest.json').read_bytes()).hexdigest(),
                'platform': os.uname().sysname + '/' + os.uname().machine,
                'samples_per_case': 1, 'dependency_policy': 'Identical modules-2 snapshots; normal mode for remote cache; reject dependency downloads or artifact changes',
                'worker_limit': 2, 'daemon_heap': '1536m', 'test_heap': '1200m (upstream)'}
    identity['gradle_version'] = WORKLOADS['rxjava']['gradle_version']
    identity['java_sha256'] = sha256(java_home / 'bin/java')
    identity['resource_measurement'] = 'Raw platform time output for each command; not the entire host or cache server'
    identity['reproducible_jar'] = args.reproducible_jar
    identity['isolated_module_output'] = args.isolated_module_output
    (root / 'identity.json').write_text(json.dumps(identity, indent=2))
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    url = f'http://127.0.0.1:{port}'
    process = None
    results = []

    def interrupted(signum, _frame):
        raise SystemExit(128 + signum)

    handlers = {sig: signal.signal(sig, interrupted) for sig in [signal.SIGINT, signal.SIGTERM]}
    with (root / 'engine.log').open('w') as engine_log:
        try:
            process = subprocess.Popen([str(engine), '--listen', f'127.0.0.1:{port}', '--data', str(root / 'remote-store'),
                                        '--credentials', str(args.htpasswd.resolve()), '--max-entry-bytes', str(1 << 30),
                                        '--max-total-bytes', str(2 << 30)], stdout=engine_log, stderr=subprocess.STDOUT,
                                       env={**os.environ, 'GOMAXPROCS': '2'}, start_new_session=True)
            (root / 'owned-resources.json').write_text(json.dumps({'engine_pid': process.pid, 'address': url}))
            for _ in range(50):
                if process.poll() is not None:
                    raise RuntimeError('Task cache engine exited')
                try:
                    initial = cache_status(url)
                    break
                except OSError:
                    time.sleep(0.1)
            else:
                raise RuntimeError('Task cache engine did not become ready')
            if initial['entries'] != 0:
                raise RuntimeError('Remote store must start empty')
            for case in ['disabled-a', 'disabled-b', 'remote-cold', 'remote-hot']:
                run = root / case
                work = run / 'source'
                work.mkdir(parents=True)
                with tarfile.open(fileobj=io.BytesIO(archive)) as source:
                    source.extractall(work, filter='data')
                home = run / 'gradle-home'
                shutil.copytree(snapshot, home / 'caches/modules-2')
                (home / 'gradle.properties').write_text(
                    'org.gradle.java.installations.auto-detect=false\norg.gradle.java.installations.auto-download=false\n'
                    'org.gradle.java.installations.paths=' + str(java_home) + '\n'
                    'org.gradle.jvmargs=-Xmx1536m -XX:MaxMetaspaceSize=512m -Dfile.encoding=UTF-8\n'
                    'org.gradle.daemon=false\norg.gradle.workers.max=2\n')
                remote = case.startswith('remote-')
                env = {**environment, 'GRADLE_USER_HOME': str(home),
                       'EXPBUILD_BENCH_CACHE_URL': url + '/cache/' if remote else '',
                       'EXPBUILD_BENCH_PUSH': str(case == 'remote-cold').lower(),
                       'EXPBUILD_BENCH_EVENTS': str(run / 'events.jsonl')}
                # --offline disables Gradle's remote build cache too. Keep the
                # warmed dependency snapshot fixed and reject further downloads.
                command = [str(gradle), '--no-daemon', '--max-workers=2', '--console=plain',
                           '--init-script', str(HERE / 'gradle.init.gradle'),
                           '--init-script', str(HERE / 'gradle-events.init.gradle'),
                           '--build-cache' if remote else '--no-build-cache',
                           'clean', 'jar', 'test', '--tests', WORKLOADS['rxjava']['test_filter'], '--info', '--profile']
                if args.reproducible_jar:
                    command += ['--init-script', str(HERE / 'gradle-reproducible.init.gradle')]
                if args.isolated_module_output:
                    command += ['--init-script', str(HERE / 'gradle-rxjava-module-output.init.gradle')]
                (run / 'command.json').write_text(json.dumps(command, indent=2))
                before = cache_status(url)
                try:
                    started = time.monotonic()
                    code = run_command(timed_command(command, run / 'resources.txt'),
                                       work, run / 'build.log', env, timeout=1800)
                    elapsed = time.monotonic() - started
                    after = cache_status(url)
                    (run / 'status-before.json').write_text(json.dumps(before, indent=2))
                    (run / 'status-after.json').write_text(json.dumps(after, indent=2))
                    if code:
                        raise RuntimeError('Gradle failed: ' + case)
                    log_text = (run / 'build.log').read_text()
                    if 'Downloading ' in log_text:
                        raise RuntimeError('Dependency download entered the timed measurement')
                    artifact_files = {str(p.relative_to(home / 'caches/modules-2')):
                                      hashlib.file_digest(p.open('rb'), 'sha256').hexdigest()
                                      for p in sorted((home / 'caches/modules-2/files-2.1').rglob('*')) if p.is_file()}
                    if artifact_files != {k: v for k, v in dependency_files.items() if k.startswith('files-2.1/')}:
                        raise RuntimeError('Dependency artifact snapshot changed during measurement')
                    jars = list((work / 'build/libs').glob('*.jar'))
                    if len(jars) != 1:
                        raise RuntimeError('Expected exactly one main JAR')
                    entries = jar_entries(jars[0])
                    modules = validate_module_output(work, entries)
                    (run / 'jar-entries.json').write_text(json.dumps(entries, sort_keys=True, indent=2))
                    events = [json.loads(line) for line in (run / 'events.jsonl').read_text().splitlines()]
                    result = {'case': case, 'exit_code': code, 'wall_seconds': elapsed,
                              'jar_sha256': hashlib.file_digest(jars[0].open('rb'), 'sha256').hexdigest(),
                              'jar_entries_sha256': hashlib.sha256(json.dumps(entries, sort_keys=True).encode()).hexdigest(),
                              'jar_entry_count': len(entries), 'tests': test_results(work, pinned_scope=True), 'events': events,
                              'compiled_modules': modules, 'runtime': validate_runtime(run / 'events.jsonl'),
                              'dependency_artifacts_unchanged': True, 'dependency_download_log_entries': 0,
                              'server_request_deltas': {k: after[k] - before[k] for k in ['getHits', 'getMisses', 'putSuccess', 'putRejected']}}
                    results.append(result)
                    (root / 'results.json').write_text(json.dumps(results, indent=2))
                    print(json.dumps({k: result[k] for k in ['case', 'exit_code', 'wall_seconds', 'jar_entries_sha256', 'server_request_deltas']}), flush=True)
                    if case != 'disabled-a' and result['jar_entries_sha256'] != results[0]['jar_entries_sha256']:
                        raise RuntimeError('Decompressed JAR entries differ, including manifest; investigate before cache claims')
                    if result['tests'] != results[0]['tests']:
                        raise RuntimeError('Test suite differs from baseline')
                    if not remote and any(result['server_request_deltas'].values()):
                        raise RuntimeError('Disabled case made cache requests')
                    if case == 'remote-hot' and (after['putSuccess'] != before['putSuccess'] or after['putRejected'] != before['putRejected']):
                        raise RuntimeError('Read-only consumer attempted cache writes')
                    if case == 'remote-cold' and (after['getMisses'] <= before['getMisses']
                                                  or after['putSuccess'] <= before['putSuccess']):
                        raise RuntimeError('Cold producer did not actually populate the remote cache')
                    if case == 'remote-hot':
                        shutil.copyfile(jars[0], run / 'measured.jar')
                        cached = {event['task'] for event in events if event['skipMessage'] == 'FROM-CACHE'}
                        if not {':compileJava', ':compileTestJava'} <= cached or after['getHits'] <= before['getHits']:
                            raise RuntimeError('Missing real remote compilation task reuse')
                        oracle = [item for item in command if item not in ['--build-cache', 'clean', '--profile']]
                        oracle += ['--offline', '--no-build-cache', '--rerun-tasks']
                        # A separate source/home also avoids changing measured
                        # JARs and reveals any dependence on previous outputs.
                        oracle_work = run / 'oracle-source'
                        oracle_work.mkdir()
                        with tarfile.open(fileobj=io.BytesIO(archive)) as source:
                            source.extractall(oracle_work, filter='data')
                        oracle_home = run / 'oracle-gradle-home'
                        shutil.copytree(snapshot, oracle_home / 'caches/modules-2')
                        shutil.copyfile(home / 'gradle.properties', oracle_home / 'gradle.properties')
                        oracle_env = {**env, 'GRADLE_USER_HOME': str(oracle_home), 'EXPBUILD_BENCH_CACHE_URL': '',
                                      'EXPBUILD_BENCH_EVENTS': str(run / 'oracle-events.jsonl')}
                        (run / 'oracle-command.json').write_text(json.dumps(oracle, indent=2))
                        oracle_started = time.monotonic()
                        try:
                            oracle_code = run_command(oracle, oracle_work, run / 'oracle.log', oracle_env, timeout=1800)
                            oracle_elapsed = time.monotonic() - oracle_started
                        finally:
                            run_command([str(gradle), '--stop'], oracle_work, run / 'oracle-stop.log', oracle_env, timeout=60)
                        if oracle_code:
                            raise RuntimeError('Independent test oracle failed')
                        oracle_events = [json.loads(line) for line in (run / 'oracle-events.jsonl').read_text().splitlines()]
                        oracle_jars = list((oracle_work / 'build/libs').glob('*.jar'))
                        if len(oracle_jars) != 1:
                            raise RuntimeError('Independent oracle JAR missing')
                        result['oracle'] = {'exit_code': oracle_code, 'wall_seconds': oracle_elapsed,
                                            'directory_policy': 'Fresh source and Gradle home, dependency downloads only',
                                            'tests': test_results(oracle_work, pinned_scope=True), 'events': oracle_events, 'runtime': validate_runtime(run / 'oracle-events.jsonl')}
                        (root / 'results.json').write_text(json.dumps(results, indent=2))
                        test_event = next(e for e in oracle_events if e['task'] == ':test')
                        if oracle_code or test_event['skipped'] or not test_event['didWork']:
                            raise RuntimeError('Independent test oracle did not execute successfully')
                        if jar_entries(oracle_jars[0]) != entries or result['oracle']['tests'] != result['tests']:
                            raise RuntimeError('Oracle output differs from measured output')
                        validate_module_output(oracle_work, jar_entries(oracle_jars[0]))
                        result['oracle']['validated'] = True
                        (root / 'results.json').write_text(json.dumps(results, indent=2))
                        # Fresh-source equivalence does not establish safety of
                        # rebuilding a workspace restored from cache. Preserve
                        # the measured JAR, then test that separate contract too.
                        rebuild_env = {**env, 'EXPBUILD_BENCH_CACHE_URL': '',
                                       'EXPBUILD_BENCH_EVENTS': str(run / 'rebuild-events.jsonl')}
                        (run / 'rebuild-command.json').write_text(json.dumps(oracle, indent=2))
                        rebuild_started = time.monotonic()
                        rebuild_code = run_command(oracle, work, run / 'rebuild.log', rebuild_env, timeout=1800)
                        rebuild = {'exit_code': rebuild_code, 'wall_seconds': time.monotonic() - rebuild_started,
                                   'validated': False, 'compiled_modules': compiled_modules(work)}
                        result['in_place_rebuild'] = rebuild
                        (root / 'results.json').write_text(json.dumps(results, indent=2))
                        if rebuild_code:
                            raise RuntimeError('In-place rebuild failed')
                        rebuilt_entries = jar_entries(jars[0])
                        (run / 'rebuild-jar-entries.json').write_text(json.dumps(rebuilt_entries, sort_keys=True, indent=2))
                        rebuild.update(tests=test_results(work, pinned_scope=True), runtime=validate_runtime(run / 'rebuild-events.jsonl'),
                                       jar_modules={k: v for k, v in rebuilt_entries.items() if k.endswith('module-info.class')},
                                       changed_entries=sorted(k for k in entries.keys() | rebuilt_entries.keys()
                                                              if entries.get(k) != rebuilt_entries.get(k)),
                                       events=[json.loads(line) for line in (run / 'rebuild-events.jsonl').read_text().splitlines()])
                        (root / 'results.json').write_text(json.dumps(results, indent=2))
                        test_event = next(e for e in rebuild['events'] if e['task'] == ':test')
                        if test_event['skipped'] or not test_event['didWork'] or rebuild['tests'] != result['tests']:
                            raise RuntimeError('In-place rebuild test oracle did not execute the expected suite')
                        validate_rebuild(work, entries, rebuilt_entries)
                        rebuild['validated'] = True
                        (root / 'results.json').write_text(json.dumps(results, indent=2))
                finally:
                    run_command([str(gradle), '--stop'], work, run / 'stop.log', env, timeout=60)
        finally:
            if process is not None:
                stop(process)
            (root / 'cleanup.json').write_text(json.dumps({'engine_returncode': process.returncode if process else None}))
            for sig, handler in handlers.items():
                signal.signal(sig, handler)


if __name__ == '__main__':
    main()
