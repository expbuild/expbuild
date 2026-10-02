from pathlib import Path
import tempfile
import unittest
import zipfile

from run_rxjava import MODULE_ENTRY, jar_entries, test_results as read_test_results, validate_rebuild, validate_runtime
import hashlib
import json


class RxJavaEvidenceTest(unittest.TestCase):
    def test_rebuild_requires_descriptor_in_compiled_output_and_jar(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            module = root / 'build/classes/java/module-info/module-info.class'
            module.parent.mkdir(parents=True)
            module.write_bytes(b'descriptor')
            entries = {MODULE_ENTRY: hashlib.sha256(module.read_bytes()).hexdigest(), 'Example.class': 'same'}
            validate_rebuild(root, entries, entries)
            with self.assertRaisesRegex(ValueError, 'JAR missing'):
                validate_rebuild(root, entries, {'Example.class': 'same'})
            module.unlink()
            with self.assertRaisesRegex(ValueError, 'Compiled module'):
                validate_rebuild(root, entries, entries)

    def test_rebuild_rejects_changed_bytecode_and_duplicate_compiled_modules(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            module = root / 'build/classes/java/module-info/module-info.class'
            module.parent.mkdir(parents=True)
            module.write_bytes(b'descriptor')
            entries = {MODULE_ENTRY: hashlib.sha256(module.read_bytes()).hexdigest(), 'Example.class': 'original'}
            with self.assertRaisesRegex(ValueError, 'changed decompressed'):
                validate_rebuild(root, entries, {**entries, 'Example.class': 'changed'})
            duplicate = root / 'build/classes/java/main/module-info.class'
            duplicate.parent.mkdir(parents=True)
            duplicate.write_bytes(b'descriptor')
            with self.assertRaisesRegex(ValueError, 'Compiled module'):
                validate_rebuild(root, entries, entries)

    def test_jar_comparison_ignores_zip_timestamps_but_not_manifest_content(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            results = []
            for name, year, manifest in [('a', 2020, b'Manifest-Version: 1.0\n'),
                                         ('b', 2026, b'Manifest-Version: 1.0\n'),
                                         ('changed', 2026, b'Manifest-Version: 2.0\n')]:
                path = root / (name + '.jar')
                with zipfile.ZipFile(path, 'w') as archive:
                    archive.writestr(zipfile.ZipInfo('META-INF/MANIFEST.MF', (year, 1, 1, 0, 0, 0)), manifest)
                    archive.writestr('pkg/Example.class', b'unchanged bytecode')
                results.append(jar_entries(path))
            self.assertEqual(results[0], results[1])
            self.assertNotEqual(results[0], results[2])

    def test_task_runtime_cannot_silently_change_tools(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'events.jsonl'
            runtime_path = Path(str(path) + '.jvm.json')
            for gradle, java, valid in [('8.14', '11.0.32', True), ('8.14.3', '11.0.32', False), ('8.14', '17.0.1', False)]:
                runtime_path.write_text(json.dumps({'gradleVersion': gradle, 'javaVersion': java, 'javaVendor': 'fixture'}))
                if valid:
                    validate_runtime(path)
                else:
                    with self.assertRaises(ValueError):
                        validate_runtime(path)

    def test_duplicate_jar_entries_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'duplicate.jar'
            with zipfile.ZipFile(path, 'w') as archive:
                archive.writestr('entry', b'one')
                with self.assertWarns(UserWarning):
                    archive.writestr('entry', b'two')
            with self.assertRaises(ValueError):
                jar_entries(path)

    def test_missing_failed_and_skipped_oracles_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            results = root / 'build/test-results/test'
            results.mkdir(parents=True)
            with self.assertRaises(ValueError):
                read_test_results(root)
            fixture = results / 'TEST-fixture.xml'
            for attributes in ['tests="0"', 'tests="1" failures="1"', 'tests="1" errors="1"',
                               'tests="1" skipped="1"']:
                fixture.write_text('<testsuite ' + attributes + '/>')
                with self.assertRaises(ValueError):
                    read_test_results(root)
            fixture.write_text('<testsuite tests="1"><testcase classname="Example" name="fails"><failure/></testcase></testsuite>')
            with self.assertRaises(ValueError):
                read_test_results(root)
            fixture.write_text('<testsuite tests="1"><testcase classname="Example" name="passes"/></testsuite>')
            self.assertEqual(read_test_results(root)['cases'], [('Example', 'passes')])

    def test_pinned_scope_rejects_a_partial_successful_suite(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            results = root / 'build/test-results/test'
            results.mkdir(parents=True)
            fixture = results / 'TEST-fixture.xml'
            class_name = 'io.reactivex.rxjava3.internal.operators.flowable.FlowableMapTest'
            for count, valid in [(27, False), (28, True), (29, False)]:
                cases = ''.join(f'<testcase classname="{class_name}" name="case{i}"/>' for i in range(count))
                fixture.write_text(f'<testsuite tests="{count}">{cases}</testsuite>')
                if valid:
                    self.assertEqual(read_test_results(root, pinned_scope=True)['tests'], 28)
                else:
                    with self.assertRaisesRegex(ValueError, 'Pinned RxJava test scope'):
                        read_test_results(root, pinned_scope=True)

    def test_only_the_pinned_upstream_announce_skip_is_allowed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            results = root / 'build/test-results/test'
            results.mkdir(parents=True)
            fixture = results / 'TEST-fixture.xml'
            content = ('<testsuite tests="2" skipped="1"><testcase classname="Example" name="passes"/>'
                       '<testcase classname="io.reactivex.rxjava3.internal.operators.flowable.FlowableMapTest" '
                       'name="announce"><skipped/></testcase></testsuite>')
            fixture.write_text(content)
            self.assertEqual(read_test_results(root)['skipped'], 1)
            fixture.write_text(content.replace('name="announce"', 'name="unexpected"'))
            with self.assertRaises(ValueError):
                read_test_results(root)


if __name__ == '__main__':
    unittest.main()
