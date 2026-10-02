#!/usr/bin/env python3
"""Run a small, authenticated loopback-only Abseil cache experiment.

Requires an existing verified Bazel binary, built bazel-remote, and the pinned
source checkout. No installation, image pull or Kubernetes access is performed.
"""
import argparse
import base64
import difflib
import hashlib
import io
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import tarfile
import time
import urllib.request

from common import WORKLOADS, file_manifest, run_command, sha256, stop, timed_command

INCREMENTAL_TEST = '''
// Fixed benchmark mutation: a new assertion must be compiled and executed.
TEST(ExpbuildCacheInvalidation, AddedAsciiAssertion) {
  EXPECT_EQ("EXPBUILD-CACHE-INVALIDATION",
            absl::AsciiStrToUpper("expbuild-cache-invalidation"));
}
'''


def read_metrics(url, authorization):
    request = urllib.request.Request(url + '/metrics', headers={'Authorization': authorization})
    return urllib.request.urlopen(request, timeout=5).read().decode()


def counters(text):
    return {line.rsplit(' ', 1)[0]: float(line.rsplit(' ', 1)[1])
            for line in text.splitlines()
            if line.startswith('bazel_remote_incoming_requests_total{')}


def apply_incremental_test(work):
    relative = 'absl/strings/ascii_test.cc'
    target = work / relative
    before = target.read_text()
    if 'ExpbuildCacheInvalidation' in before:
        raise ValueError('Incremental fixture was already applied')
    after = before + INCREMENTAL_TEST
    patch = ''.join(difflib.unified_diff(before.splitlines(keepends=True), after.splitlines(keepends=True),
                                       fromfile='a/' + relative, tofile='b/' + relative))
    target.write_text(after)
    return patch


def validate_tests(events, require_execution=False):
    summaries = [e['testSummary'] for e in events if 'testSummary' in e]
    targets = {e['id']['testSummary']['label'] for e in events if 'testSummary' in e}
    if len(summaries) != len(WORKLOADS['abseil']['targets']) or targets != set(WORKLOADS['abseil']['targets']):
        raise ValueError('Missing or duplicate requested Bazel test results')
    if any(s.get('overallStatus') != 'PASSED' or s.get('totalRunCount', 0) <= 0 for s in summaries):
        raise ValueError('Bazel test suite did not pass')
    if require_execution and any(s.get('totalNumCached', 0) for s in summaries):
        raise ValueError('Uncached test oracle reused test results')
    return summaries


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--bazel', required=True, type=Path)
    parser.add_argument('--engine', required=True, type=Path)
    parser.add_argument('--dependency-cache', required=True, type=Path)
    parser.add_argument('--htpasswd', required=True, type=Path, help='Disposable fixture, username builder / password secret')
    parser.add_argument('--incremental', action='store_true', help='Also run a paired fixed source mutation, with separate unmeasured prewarming')
    args = parser.parse_args()
    root = args.output.resolve()
    root.mkdir(mode=0o700, parents=True, exist_ok=False)
    source = args.source.resolve()
    revision = WORKLOADS['abseil']['revision']
    actual = subprocess.check_output(['git', '-C', str(source), 'rev-parse', 'HEAD'], text=True).strip()
    if actual != revision:
        raise ValueError(f'Unexpected source revision {actual}')
    archive = subprocess.check_output(['git', '-C', str(source), 'archive', revision])
    bazel, engine = str(args.bazel.resolve()), str(args.engine.resolve())
    identity = {'revision': revision, 'bazel_version': subprocess.check_output([bazel, '--version'], text=True).strip(),
                'bazel_sha256': hashlib.file_digest(open(bazel, 'rb'), 'sha256').hexdigest(),
                'engine_sha256': hashlib.file_digest(open(engine, 'rb'), 'sha256').hexdigest(),
                'compiler': subprocess.check_output(['clang', '--version'], text=True),
                'platform': os.uname().sysname + '/' + os.uname().machine,
                'dependency_cache': str(args.dependency_cache.resolve()),
                'dependency_policy': 'Previously warmed repository downloads only; no output/disk action cache reuse',
                'samples_per_case': 1}
    if identity['bazel_version'] != 'bazel ' + WORKLOADS['abseil']['bazel_version']:
        raise ValueError('Expected Bazel ' + WORKLOADS['abseil']['bazel_version'])
    dependencies = file_manifest(args.dependency_cache.resolve())
    if not dependencies:
        raise ValueError('A warmed repository download cache is required')
    (root / 'dependency-manifest.json').write_text(json.dumps(dependencies, sort_keys=True, indent=2))
    identity['dependency_manifest_sha256'] = sha256(root / 'dependency-manifest.json')
    identity['resource_measurement'] = 'Raw platform time output for each command; not the entire host or cache server'
    (root / 'identity.json').write_text(json.dumps(identity, indent=2))
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    url = f'http://127.0.0.1:{port}'
    authorization = 'Basic ' + base64.b64encode(b'builder:secret').decode()
    helper = root / 'credential-helper.py'
    helper.write_text('#!/usr/bin/env python3\nimport json, os\nprint(json.dumps({"headers":{"Authorization":[os.environ["EXPBUILD_BENCH_AUTH"]]}}))\n')
    helper.chmod(0o700)
    engine_log = (root / 'engine.log').open('w')
    process = None
    results = []
    environment = {**os.environ, 'EXPBUILD_BENCH_AUTH': authorization}
    def interrupted(signum, _frame):
        raise SystemExit(128 + signum)
    handlers = {sig: signal.signal(sig, interrupted) for sig in (signal.SIGTERM, signal.SIGINT)}
    try:
        process = subprocess.Popen([engine, '--dir', str(root / 'remote-store'), '--max_size', '1',
                                '--http_address', f'127.0.0.1:{port}', '--grpc_address', 'none',
                                '--htpasswd_file', str(args.htpasswd.resolve()), '--enable_endpoint_metrics'],
                               stdout=engine_log, stderr=subprocess.STDOUT, start_new_session=True,
                               env={**os.environ, 'GOMAXPROCS': '2'})
        (root / 'owned-resources.json').write_text(json.dumps({'engine_pid': process.pid, 'address': url}))
        for _ in range(50):
            if process.poll() is not None:
                raise RuntimeError('Task cache engine exited; inspect engine.log')
            try:
                read_metrics(url, authorization)
                break
            except OSError:
                time.sleep(0.1)
        else:
            raise RuntimeError('Task cache engine did not become ready')
        cases = ['disabled-a', 'disabled-b', 'remote-cold', 'remote-hot']
        if args.incremental:
            cases += ['incremental-disabled', 'incremental-remote']
        for case in cases:
            run = root / case
            work = run / 'source'
            work.mkdir(parents=True)
            with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
                tar.extractall(work, filter='data')
            remote = case in ('remote-cold', 'remote-hot', 'incremental-remote')
            command = [bazel, '--ignore_all_rc_files', '--batch', f'--output_base={run / "output"}',
                       'test', *WORKLOADS['abseil']['targets'], '--enable_bzlmod=true',
                       '--cxxopt=-std=c++17', '--jobs=2', '--test_output=errors',
                       '--remote_download_outputs=all', f'--repository_cache={args.dependency_cache.resolve()}',
                       '--disk_cache=', f'--remote_cache={url if remote else ""}',
                       f'--remote_accept_cached={str(remote).lower()}',
                       f'--remote_upload_local_results={str(case == "remote-cold").lower()}',
                       f'--credential_helper=127.0.0.1={helper}',
                       f'--build_event_json_file={run / "events.jsonl"}', f'--profile={run / "profile.json.gz"}']
            patch_sha256 = None
            if case.startswith('incremental-'):
                prewarm = command + [f'--build_event_json_file={run / "prewarm-events.jsonl"}',
                                     f'--profile={run / "prewarm-profile.json.gz"}']
                if run_command(prewarm, work, run / 'prewarm.log', environment):
                    raise RuntimeError('Incremental prewarm failed')
                patch = apply_incremental_test(work)
                (run / 'source.patch').write_text(patch)
                patch_sha256 = hashlib.sha256(patch.encode()).hexdigest()
            before = read_metrics(url, authorization)
            (run / 'metrics-before.txt').write_text(before)
            (run / 'command.json').write_text(json.dumps(command, indent=2))
            started = time.monotonic()
            code = run_command(timed_command(command, run / 'resources.txt'),
                               work, run / 'build.log', environment)
            elapsed = time.monotonic() - started
            after = read_metrics(url, authorization)
            (run / 'metrics-after.txt').write_text(after)
            metrics = {key: value - counters(before).get(key, 0) for key, value in counters(after).items()}
            events = [json.loads(line) for line in (run / 'events.jsonl').read_text().splitlines()]
            summary = next((e['buildMetrics'] for e in events if 'buildMetrics' in e), {})
            tests = validate_tests(events)
            if file_manifest(args.dependency_cache.resolve()) != dependencies:
                raise RuntimeError('Repository downloads changed during measurement')
            hashes = {}
            for name in ('ascii_test', 'str_cat_test', 'str_split_test'):
                binary = work / 'bazel-bin/absl/strings' / name
                if binary.exists():
                    if not binary.resolve().is_relative_to((run / 'output').resolve()):
                        raise RuntimeError('Artifact is outside this case output base')
                    hashes[name] = hashlib.file_digest(binary.open('rb'), 'sha256').hexdigest()
            result = {'case': case, 'exit_code': code, 'wall_seconds': elapsed,
                      'patch_sha256': patch_sha256,
                      'binary_sha256': hashes, 'server_request_deltas': metrics,
                      'build_metrics': summary,
                      'test_summaries': tests, 'dependency_artifacts_unchanged': True}
            results.append(result)
            (root / 'results.json').write_text(json.dumps(results, indent=2))
            print(json.dumps({k: result[k] for k in ('case', 'exit_code', 'wall_seconds', 'binary_sha256')}), flush=True)
            if code or len(hashes) != 3:
                raise RuntimeError('Build failed or outputs missing; stop the experiment')
            if not remote and any(metrics.values()):
                raise RuntimeError('Disabled case made cache requests')
            if case == 'remote-cold' and metrics.get('bazel_remote_incoming_requests_total{kind="ac",method="get",status="miss"}', 0) <= 0:
                raise RuntimeError('Cold producer did not query an empty action cache')
            if case == 'disabled-b' and hashes != results[0]['binary_sha256']:
                raise RuntimeError('Disabled output bytes differ; investigate before measuring cache reuse')
            if case.startswith('incremental-'):
                if hashes['ascii_test'] == results[0]['binary_sha256']['ascii_test']:
                    raise RuntimeError('Changed test source did not change its executable')
                for name in ('str_cat_test', 'str_split_test'):
                    if hashes[name] != results[0]['binary_sha256'][name]:
                        raise RuntimeError('Unrelated test output changed')
                xml = (work / 'bazel-testlogs/absl/strings/ascii_test/test.xml').read_text()
                if 'AddedAsciiAssertion' not in xml or 'ExpbuildCacheInvalidation' not in xml:
                    raise RuntimeError('The new assertion is missing from the test result')
            if case == 'incremental-remote':
                disabled = next(r for r in results if r['case'] == 'incremental-disabled')
                if hashes != disabled['binary_sha256'] or patch_sha256 != disabled['patch_sha256']:
                    raise RuntimeError('Patched remote outputs differ from the paired disabled case')
                if metrics.get('bazel_remote_incoming_requests_total{kind="ac",method="get",status="miss"}', 0) <= 0:
                    raise RuntimeError('Changed inputs did not cause any remote action cache misses')
            if case == 'remote-hot':
                ac_hits = metrics.get('bazel_remote_incoming_requests_total{kind="ac",method="get",status="hit"}', 0)
                if ac_hits <= 0:
                    raise RuntimeError('No server-observed action cache hits; do not claim remote reuse')
                if hashes != results[0]['binary_sha256']:
                    raise RuntimeError('Cached output bytes differ from independent disabled builds')
            if case in ('remote-hot', 'incremental-remote'):
                oracle = command + ['--remote_cache=', '--remote_accept_cached=false',
                                    '--remote_upload_local_results=false', '--nocache_test_results',
                                    f'--build_event_json_file={run / "oracle-events.jsonl"}',
                                    f'--profile={run / "oracle-profile.json.gz"}']
                oracle_code = run_command(oracle, work, run / 'oracle.log', environment)
                result['uncached_test_oracle_exit'] = oracle_code
                (root / 'results.json').write_text(json.dumps(results, indent=2))
                if oracle_code:
                    raise RuntimeError('Uncached test oracle failed')
                oracle_events = [json.loads(line) for line in (run / 'oracle-events.jsonl').read_text().splitlines()]
                result['uncached_test_oracle_summaries'] = validate_tests(oracle_events, require_execution=True)
                result['uncached_test_oracle_validated'] = True
                (root / 'results.json').write_text(json.dumps(results, indent=2))
    finally:
        if process is not None:
            stop(process)
        engine_log.close()
        helper.unlink(missing_ok=True)
        (root / 'cleanup.json').write_text(json.dumps({
            'engine_returncode': process.returncode if process is not None else None,
            'credential_helper_removed': not helper.exists(),
        }))
        for sig, handler in handlers.items():
            signal.signal(sig, handler)


if __name__ == '__main__':
    main()
