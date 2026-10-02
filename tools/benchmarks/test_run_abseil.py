import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from common import run_command, stop, WORKLOADS
from run_abseil import apply_incremental_test, counters, validate_tests


class RunnerTest(unittest.TestCase):
    def test_incremental_patch_is_stable_and_cannot_be_applied_twice(self):
        patches = []
        for _ in range(2):
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                source = root / 'absl/strings/ascii_test.cc'
                source.parent.mkdir(parents=True)
                source.write_text('// baseline\n')
                patches.append(apply_incremental_test(root))
                self.assertIn('AddedAsciiAssertion', source.read_text())
                with self.assertRaises(ValueError):
                    apply_incremental_test(root)
        self.assertEqual(patches[0], patches[1])

    def test_oracle_rejects_missing_failed_or_cached_tests(self):
        events = [{'id': {'testSummary': {'label': target}},
                   'testSummary': {'overallStatus': 'PASSED', 'totalRunCount': 1, 'totalNumCached': 0}}
                  for target in WORKLOADS['abseil']['targets']]
        validate_tests(events, True)
        with self.assertRaises(ValueError):
            validate_tests(events[:-1], True)
        events[0]['testSummary']['totalNumCached'] = 1
        with self.assertRaises(ValueError):
            validate_tests(events, True)
        events[0]['testSummary']['overallStatus'] = 'FAILED'
        with self.assertRaises(ValueError):
            validate_tests(events)

    def test_metric_parser_ignores_non_request_series(self):
        sample = '# HELP description\nprocess_resident_memory_bytes 4096\nbazel_remote_incoming_requests_total{kind="ac",method="get",status="hit"} 164\n'
        parsed = counters(sample)
        self.assertEqual(list(parsed.values()), [164])

    def test_stop_is_confined_to_its_own_session(self):
        owned = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'], start_new_session=True)
        bystander = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'], start_new_session=True)
        try:
            stop(owned)
            self.assertIsNotNone(owned.poll())
            self.assertIsNone(bystander.poll())
        finally:
            stop(owned)
            stop(bystander)

    def test_command_timeout_reaps_the_owned_process(self):
        processes = []
        real_popen = subprocess.Popen

        def capture(*args, **kwargs):
            process = real_popen(*args, **kwargs)
            processes.append(process)
            return process

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with patch('common.subprocess.Popen', side_effect=capture):
                with self.assertRaises(subprocess.TimeoutExpired):
                    run_command([sys.executable, '-c', 'import time; time.sleep(30)'],
                                root, root / 'timeout.log', os.environ.copy(), timeout=0.1)
            self.assertEqual(len(processes), 1)
            self.assertIsNotNone(processes[0].poll())


if __name__ == '__main__':
    unittest.main()
