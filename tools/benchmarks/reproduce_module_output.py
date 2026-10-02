#!/usr/bin/env python3
"""Verify the pinned overlapping-output defect and its opt-in diagnostic workaround.

Uses existing Gradle 8.14/JDK 11 and a prepared modules-2 snapshot. Creates its
own output directories and optional loopback HTTP reader; no expbuild server.
"""
import argparse
import functools
import http.server
import json
import os
from pathlib import Path
import shutil
import signal
import threading

from common import HERE, run_command
from run_rxjava import MODULE_ENTRY, compiled_modules, jar_entries


def assert_transition(initial, rebuilt, expect_loss):
    if MODULE_ENTRY not in initial:
        raise ValueError('Initial JAR already lacks the module descriptor')
    expected = {k: v for k, v in initial.items() if k != MODULE_ENTRY} if expect_loss else initial
    if rebuilt != expected:
        raise ValueError('Unexpected rebuild entry differences')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('output', 'gradle', 'java-home', 'dependency-snapshot'):
        parser.add_argument('--' + name, required=True, type=Path)
    args = parser.parse_args()
    root = args.output.resolve()
    root.mkdir(parents=True, exist_ok=False)
    gradle, java = args.gradle.resolve(), args.java_home.resolve()
    home = root / 'gradle-home'
    shutil.copytree(args.dependency_snapshot.resolve(), home / 'caches/modules-2')
    (home / 'gradle.properties').write_text(
        'org.gradle.java.installations.auto-detect=false\norg.gradle.java.installations.auto-download=false\n'
        'org.gradle.java.installations.paths=' + str(java) + '\norg.gradle.jvmargs=-Xmx512m\n')
    env = {k: v for k, v in os.environ.items() if k not in
           ('JAVA_OPTS', 'GRADLE_OPTS', 'JAVA_TOOL_OPTIONS', 'JDK_JAVA_OPTIONS', '_JAVA_OPTIONS')}
    env.update(JAVA_HOME=str(java), GRADLE_USER_HOME=str(home))
    rows, requests = [], []

    def create(name):
        work = root / name
        shutil.copytree(HERE / 'fixtures/gradle-module-output', work,
                        ignore=shutil.ignore_patterns('build', '.gradle', '__pycache__'))
        # Assert pinned toolchain inside Gradle without attaching task listeners.
        with (work / 'settings.gradle').open('a') as settings:
            settings.write("\nassert gradle.gradleVersion == '8.14'\nassert JavaVersion.current() == JavaVersion.VERSION_11\n")
        return work

    def build(work, phase, cached=False, fixed=False):
        command = [str(gradle), '--no-daemon', '--max-workers=2', '--console=plain', '--info',
                   '--build-cache' if cached else '--no-build-cache']
        if fixed:
            command += ['--init-script', str(HERE / 'gradle-rxjava-module-output.init.gradle')]
        command += ['clean', 'jar'] if phase == 'initial' else ['--rerun-tasks', 'jar']
        (work / (phase + '-command.json')).write_text(json.dumps(command, indent=2))
        code = run_command(command, work, work / (phase + '.log'), env, timeout=180)
        if code:
            raise RuntimeError('Gradle failed: ' + work.name + '/' + phase)
        log = (work / (phase + '.log')).read_text()
        if 'Downloading ' in log:
            raise RuntimeError('Prepared dependency snapshot was incomplete')
        jar = work / 'build/libs/module-repro-1.0.jar'
        entries = jar_entries(jar)
        shutil.copyfile(jar, work / (phase + '.jar'))
        rows.append({'case': work.name, 'phase': phase, 'entries': entries,
                     'compiled_modules': compiled_modules(work), 'exit_code': code,
                     'module_from_cache': '> Task :compileJava FROM-CACHE' in log})
        (root / 'results.json').write_text(json.dumps(rows, indent=2))
        return rows[-1]

    def check_consumer(work, cached, fixed, expect_loss):
        first = build(work, 'initial', cached, fixed)
        rebuilt = build(work, 'rebuild', False, fixed)
        if cached and not first['module_from_cache']:
            raise ValueError('Consumer did not restore compileJava from cache')
        assert_transition(first['entries'], rebuilt['entries'], expect_loss)
        if len(first['compiled_modules']) != 1 or len(rebuilt['compiled_modules']) != (0 if expect_loss else 1):
            raise ValueError('Unexpected compiled module count')

    class Handler(http.server.SimpleHTTPRequestHandler):
        def do_GET(self):
            requests.append(self.path)
            super().do_GET()
        def log_message(self, *_args):
            pass

    def interrupted(signum, _frame):
        raise SystemExit(128 + signum)
    handlers = {sig: signal.signal(sig, interrupted) for sig in (signal.SIGINT, signal.SIGTERM)}
    server = None
    thread = None
    try:
        check_consumer(create('disabled-control'), False, False, False)
        build(create('original-producer'), 'initial', True)
        check_consumer(create('original-local'), True, False, True)
        # Read-only standard-library HTTP cache demonstrates that expbuild is
        # not necessary to reproduce the loss. The service only exposes this
        # fixture's new, private local task-cache directory on loopback.
        handler = functools.partial(Handler, directory=str(home / 'caches/build-cache-1'))
        server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        consumer = create('original-http')
        with (consumer / 'settings.gradle').open('a') as settings:
            settings.write("\nbuildCache { local { enabled = false }; remote(org.gradle.caching.http.HttpBuildCache) { "
                           "url = 'http://127.0.0.1:%d/'; allowInsecureProtocol = true; push = false } }\n" % server.server_port)
        check_consumer(consumer, True, False, True)
        if not requests:
            raise ValueError('No HTTP cache reads observed')
        build(create('fixed-producer'), 'initial', True, True)
        check_consumer(create('fixed-local'), True, True, False)
        (root / 'validated.json').write_text(json.dumps({'builds': len(rows), 'http_reads': len(requests),
            'original_loss_reproduced': True, 'fixed_preserves_entries': True}, indent=2))
    finally:
        if server:
            server.shutdown()
            server.server_close()
            thread.join()
        run_command([str(gradle), '--stop'], root, root / 'stop.log', env, timeout=60)
        (root / 'http-requests.json').write_text(json.dumps(requests, indent=2))
        for sig, handler in handlers.items():
            signal.signal(sig, handler)


if __name__ == '__main__':
    main()
