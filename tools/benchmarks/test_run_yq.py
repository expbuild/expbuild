import io
import json
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import Mock, patch

from run_yq import ACCEPTANCE, COMPILE, PINS, Experiment, acceptance_count, adapt_dockerfile, digest, main, mutate, oci_artifact, step_hits, verify_buildx


def layer(entries):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode='w:gz') as stream:
        for name, data in entries.items():
            info = tarfile.TarInfo(name)
            info.size = len(data)
            info.mode = 0o755 if name == 'usr/bin/yq' else 0o644
            stream.addfile(info, io.BytesIO(data))
    return output.getvalue()


def image(path, layers, arch='arm64', corrupt=False):
    blobs = {}

    def add(data, media):
        key = digest(data)
        blobs['blobs/' + key.replace(':', '/')] = data
        return {'digest': key, 'size': len(data), 'mediaType': media}

    config = add(json.dumps({'os': 'linux', 'architecture': arch}).encode(),
                 'application/vnd.oci.image.config.v1+json')
    manifest = add(json.dumps({'schemaVersion': 2, 'config': config, 'layers': [
        add(raw, 'application/vnd.oci.image.layer.v1.tar+gzip') for raw in layers
    ]}).encode(), 'application/vnd.oci.image.manifest.v1+json')
    blobs['index.json'] = json.dumps({'schemaVersion': 2, 'manifests': [manifest]}).encode()
    if corrupt:
        blobs['blobs/' + config['digest'].replace(':', '/')] = b'bad'
    with tarfile.open(path, 'w') as stream:
        for name, data in blobs.items():
            info = tarfile.TarInfo(name)
            info.size = len(data)
            stream.addfile(info, io.BytesIO(data))


class YqEvidenceTest(unittest.TestCase):
    def test_restart_refreshes_ephemeral_port_and_rechecks_loopback_binding(self):
        experiment = object.__new__(Experiment)
        experiment.state = {'registry': 'task-registry'}
        experiment.persist = Mock()
        experiment.d = Mock(side_effect=[json.dumps({'5000/tcp': [{'HostIp': ip, 'HostPort': port}]})
                                         for ip, port in [('127.0.0.1', '32779'),
                                                          ('127.0.0.1', '32780'), ('0.0.0.0', '5000')]])
        experiment.refresh_endpoint()
        experiment.refresh_endpoint()
        self.assertEqual(experiment.state['endpoint'], 'http://127.0.0.1:32780')
        self.assertEqual(len(experiment.state['endpoint_history']), 2)
        with self.assertRaisesRegex(ValueError, 'localhost'):
            experiment.refresh_endpoint()

    def test_disconnected_daemon_is_not_reported_as_successful_cleanup(self):
        experiment = object.__new__(Experiment)
        experiment.state = {'prefix': 'task', 'registry': 'task-registry',
                            'network': 'task-net', 'volume': 'task-data'}
        experiment.persist = Mock()
        experiment.d = Mock(side_effect=subprocess.CalledProcessError(
            1, ['docker', 'inspect'], stderr=b'Cannot connect to the Docker daemon'))
        with self.assertRaisesRegex(RuntimeError, 'Cleanup incomplete'):
            experiment.cleanup()
        self.assertFalse(experiment.state['cleaned'])
        self.assertEqual(len(experiment.state['cleanup_errors']), 3)
        experiment.d = Mock(side_effect=subprocess.CalledProcessError(
            1, ['docker', 'inspect'], stderr=b'Error response from daemon: No such container: task'))
        self.assertIsNone(experiment.inspect_resource('container', 'task'))

    def test_rejected_existing_directory_never_cleans_previous_resources(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            state = json.dumps({'prefix': 'previous-task', 'registry': 'do-not-remove'})
            (root / 'state.json').write_text(state)
            argv = ['run_yq.py', '--source', temp, '--work-dir', temp,
                    '--docker-config', temp, '--docker-host', 'unix:///unused.sock']
            with patch('sys.argv', argv), patch('run_yq.command') as command:
                with self.assertRaisesRegex(ValueError, 'new empty'):
                    main()
                command.assert_not_called()
            self.assertEqual((root / 'state.json').read_text(), state)

    @patch('run_yq.time.sleep')
    def test_registry_start_waits_for_transport_and_has_a_deadline(self, sleep):
        experiment = object.__new__(Experiment)
        experiment.api = Mock(side_effect=[ConnectionResetError(), (200, {}, b'{}')])
        experiment.ready()
        self.assertEqual(experiment.api.call_count, 2)
        experiment.api = Mock(side_effect=ConnectionResetError())
        with self.assertRaises(ConnectionResetError):
            experiment.ready()
        self.assertEqual(experiment.api.call_count, 20)

    def test_surviving_manifest_is_insufficient_when_a_blob_is_corrupt(self):
        experiment = object.__new__(Experiment)
        descriptor = {'digest': digest(b'original'), 'size': len(b'original')}
        manifest = json.dumps({'config': descriptor, 'layers': []}).encode()
        experiment.api = Mock(side_effect=[(200, {}, manifest), (200, {}, b'corrupt')])
        with self.assertRaises(ValueError):
            experiment.check_image_blobs('yq-output', 'remote-cold')

    def test_acceptance_requires_all_suites_with_nonzero_tests(self):
        self.assertEqual(acceptance_count('Ran \x1b[1;36m3\x1b[0m tests.\nRan 1 test.', 2), 4)
        for log in ['Ran 3 tests.', 'Ran 0 tests.\nRan 3 tests.',
                    'Ran 3 tests.\nRan 1 test.\nFAILED (failures=1)',
                    'hd: command not found\nRan 3 tests.\nRan 1 test.\nOK']:
            with self.assertRaises(ValueError):
                acceptance_count(log, 2)

    @patch('run_yq.platform.system', return_value='Darwin')
    @patch('run_yq.platform.machine', return_value='arm64')
    def test_unverified_buildx_cannot_be_executed(self, machine, system):
        with tempfile.TemporaryDirectory() as temp:
            (Path(temp) / 'docker-buildx').write_bytes(b'pretend version v0.37.2')
            with self.assertRaisesRegex(ValueError, 'SHA256'):
                verify_buildx({'cliPluginsExtraDirs': [temp]})

    def test_named_hits_do_not_confuse_base_warmup_with_compilation(self):
        log = f'#1 [builder 1/4] FROM base\n#1 CACHED\n#2 [builder 3/4] {COMPILE}\n#2 DONE 5.3s\n#3 [builder 4/4] {ACCEPTANCE}\n#3 DONE 3.0s\n'
        self.assertEqual(step_hits(log), {'compile': False, 'acceptance': False})
        self.assertEqual(step_hits(log.replace('#2 DONE 5.3s', '#2 CACHED').replace('#3 DONE 3.0s', '#3 CACHED')),
                         {'compile': True, 'acceptance': True})
        with self.assertRaises(ValueError):
            step_hits(log.replace('#3 DONE 3.0s', '#3 ERROR'))
        with self.assertRaises(ValueError):
            step_hits('#1 CACHED\n')

    def test_adapter_preserves_real_upstream_build_and_acceptance(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            data = ('FROM golang:1.27.1@' + PINS['golang'].split('@')[1] + ' AS builder\n' +
                    COMPILE + '\n' + ACCEPTANCE + '\nFROM alpine:3@' +
                    PINS['alpine'].split('@')[1] + ' AS production\n')
            (root / 'Dockerfile').write_text(data)
            adapt_dockerfile(root, 'registry:5000/seed@sha256:abc', 'alpine@sha256:def')
            actual = (root / 'Dockerfile').read_text()
            self.assertIn(COMPILE, actual)
            self.assertIn(ACCEPTANCE, actual)
            with self.assertRaises(ValueError):
                adapt_dockerfile(root, 'seed', 'alpine')

    def test_mutation_changes_only_the_pinned_version_declaration(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / 'cmd').mkdir()
            (root / 'cmd/version.go').write_text('VersionPrerelease = ""\n')
            mutate(root)
            self.assertEqual((root / 'cmd/version.go').read_text(),
                             'VersionPrerelease = "expbuild-cache-probe"\n')
            with self.assertRaises(ValueError):
                mutate(root)

    def test_whole_rootfs_detects_extra_file_even_when_binary_matches(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            base = layer({'usr/bin/yq': b'yq-binary', 'etc/config': b'original'})
            image(root / 'a.tar', [base])
            image(root / 'b.tar', [base, layer({'etc/config': b'changed'})])
            a = oci_artifact(root / 'a.tar', root / 'a-yq')
            b = oci_artifact(root / 'b.tar', root / 'b-yq')
            self.assertEqual(a['binary_sha256'], b['binary_sha256'])
            self.assertNotEqual(a['rootfs_sha256'], b['rootfs_sha256'])

    def test_whiteouts_are_applied_without_extracting_image_paths(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            image(root / 'image.tar', [layer({'usr/bin/yq': b'yq', 'etc/old': b'x'}),
                                       layer({'etc/.wh..wh..opq': b'', 'etc/new': b'y'})])
            result = oci_artifact(root / 'image.tar', root / 'yq')
            self.assertNotIn('etc/old', result['rootfs'])
            self.assertIn('etc/new', result['rootfs'])
            self.assertFalse((root / 'etc').exists())

    def test_corrupt_blobs_wrong_architecture_and_missing_binary_fail(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for options, files in [({'corrupt': True}, {'usr/bin/yq': b'yq'}),
                                    ({'arch': 'amd64'}, {'usr/bin/yq': b'yq'}),
                                    ({}, {'etc/config': b'no binary'}),
                                    ({}, {'../escape': b'x', 'usr/bin/yq': b'yq'})]:
                with self.subTest(options=options, files=files):
                    image(root / 'image.tar', [layer(files)], **options)
                    with self.assertRaises(ValueError):
                        oci_artifact(root / 'image.tar', root / 'yq')


if __name__ == '__main__':
    unittest.main()
