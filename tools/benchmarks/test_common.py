from pathlib import Path
import unittest
from common import timed_command
from reproduce_module_output import assert_transition
from run_rxjava import MODULE_ENTRY


class ControlsTest(unittest.TestCase):
    def test_platform_resource_command_preserves_argv(self):
        command = ['tool', 'argument with spaces']
        for system, flag in [('Darwin', '-l'), ('Linux', '-v')]:
            self.assertEqual(timed_command(command, Path('resources.txt'), system),
                             ['/usr/bin/time', flag, '-o', 'resources.txt', *command])
        with self.assertRaises(ValueError):
            timed_command(command, Path('resources.txt'), 'Windows')

    def test_reproduction_requires_exact_descriptor_loss_only(self):
        before = {MODULE_ENTRY: 'module', 'Example.class': 'class'}
        assert_transition(before, {'Example.class': 'class'}, True)
        assert_transition(before, before, False)
        for initial, after, loss in [(before, before, True),
                                     (before, {'Example.class': 'corrupt'}, True),
                                     ({'Example.class': 'class'}, {'Example.class': 'class'}, False)]:
            with self.assertRaises(ValueError):
                assert_transition(initial, after, loss)
